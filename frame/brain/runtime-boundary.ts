import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8090;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 15_000;
const MIN_ENGINE_TOKEN_BYTES = 32;
const MAX_MESSAGES = 64;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_TOTAL_MESSAGE_BYTES = 768 * 1024;
const MAX_TENANT_LENGTH = 64;
const MAX_MODEL_LENGTH = 128;
const MAX_HINT_LENGTH = 500;
const MAX_SESSION_LENGTH = 4_000;
const TENANT_ID = /^[a-z0-9][a-z0-9_+-]*$/;

type Environment = Readonly<Record<string, string | undefined>>;

export interface RuntimeConfig {
  host: string;
  port: number;
  token?: string;
  maxBodyBytes: number;
  bodyTimeoutMs: number;
}

export interface TurnMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TurnEnvelope {
  model: string;
  messages: TurnMessage[];
  stream: boolean;
  user: string;
  channel?: "voice";
  mode?: "thread" | "capture" | "delivery";
  co_hint?: string;
  session?: string;
}

export class RuntimeRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RuntimeRequestError";
    this.status = status;
    this.code = code;
  }
}

function integerSetting(
  env: Environment,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host.toLowerCase() === "localhost";
}

export function loadRuntimeConfig(env: Environment): RuntimeConfig {
  const host = env.WITNESS_HOST?.trim() || DEFAULT_HOST;
  if (/\s|\//.test(host)) throw new Error("WITNESS_HOST must be a hostname or IP address");

  const token = env.CO_ENGINE_TOKEN?.trim() || undefined;
  if (token && Buffer.byteLength(token, "utf8") < MIN_ENGINE_TOKEN_BYTES) {
    throw new Error(`CO_ENGINE_TOKEN must be at least ${MIN_ENGINE_TOKEN_BYTES} bytes`);
  }
  if (!isLoopbackHost(host) && !token) {
    throw new Error("CO_ENGINE_TOKEN is required when WITNESS_HOST is not loopback");
  }

  return {
    host,
    port: integerSetting(env, "WITNESS_PORT", DEFAULT_PORT, 1, 65_535),
    token,
    maxBodyBytes: integerSetting(
      env,
      "CO_ENGINE_MAX_BODY_BYTES",
      DEFAULT_MAX_BODY_BYTES,
      1_024,
      8 * 1024 * 1024,
    ),
    bodyTimeoutMs: integerSetting(
      env,
      "CO_ENGINE_BODY_TIMEOUT_MS",
      DEFAULT_BODY_TIMEOUT_MS,
      1_000,
      120_000,
    ),
  };
}

function bearerToken(authorization: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  return match?.[1];
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function assertEngineAuthorization(
  config: RuntimeConfig,
  authorization: string | undefined,
): void {
  if (!config.token) return;
  const supplied = bearerToken(authorization);
  if (!supplied || !timingSafeEqual(digest(supplied), digest(config.token))) {
    throw new RuntimeRequestError(401, "unauthorized", "valid bearer token required");
  }
}

export function readBoundedBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let total = 0;
    const chunks: Buffer[] = [];

    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error: RuntimeRequestError) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        fail(
          new RuntimeRequestError(
            413,
            "request_too_large",
            `request body exceeds ${maxBytes} bytes`,
          ),
        );
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total).toString("utf8"));
    };
    const onError = () =>
      fail(new RuntimeRequestError(400, "request_read_failed", "request body could not be read"));
    const onAborted = () =>
      fail(new RuntimeRequestError(400, "request_aborted", "request was aborted"));
    const timer = setTimeout(
      () => fail(new RuntimeRequestError(408, "request_timeout", "request body timed out")),
      timeoutMs,
    );
    timer.unref();

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeRequestError(422, "invalid_request", "request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RuntimeRequestError(422, "invalid_request", `${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new RuntimeRequestError(422, "invalid_request", `${field} is too long`);
  }
  return normalized;
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new RuntimeRequestError(422, "invalid_request", `${field} must be a string`);
  }
  if (value.length > maxLength) {
    throw new RuntimeRequestError(422, "invalid_request", `${field} is too long`);
  }
  return value.trim() || undefined;
}

export function parseTurnEnvelope(value: unknown): TurnEnvelope {
  const body = objectValue(value);
  const model = requiredString(body.model, "model", MAX_MODEL_LENGTH);
  const user = requiredString(body.user, "user", MAX_TENANT_LENGTH).toLowerCase();
  if (!TENANT_ID.test(user)) {
    throw new RuntimeRequestError(422, "invalid_tenant", "user must be a valid tenant id");
  }

  if (
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    body.messages.length > MAX_MESSAGES
  ) {
    throw new RuntimeRequestError(
      422,
      "invalid_messages",
      `messages must contain 1 to ${MAX_MESSAGES} items`,
    );
  }
  let totalMessageBytes = 0;
  const messages = body.messages.map((candidate, index): TurnMessage => {
    const message = objectValue(candidate);
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
      throw new RuntimeRequestError(422, "invalid_messages", `messages[${index}].role is invalid`);
    }
    if (typeof message.content !== "string") {
      throw new RuntimeRequestError(
        422,
        "invalid_messages",
        `messages[${index}].content must be a string`,
      );
    }
    const bytes = Buffer.byteLength(message.content, "utf8");
    if (bytes > MAX_MESSAGE_BYTES) {
      throw new RuntimeRequestError(
        422,
        "message_too_large",
        `messages[${index}].content is too large`,
      );
    }
    totalMessageBytes += bytes;
    if (totalMessageBytes > MAX_TOTAL_MESSAGE_BYTES) {
      throw new RuntimeRequestError(
        422,
        "messages_too_large",
        "combined message content is too large",
      );
    }
    return { role: message.role, content: message.content };
  });
  if (messages.at(-1)?.role !== "user" || !messages.at(-1)?.content.trim()) {
    throw new RuntimeRequestError(
      422,
      "invalid_messages",
      "the final message must be a non-empty user message",
    );
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new RuntimeRequestError(422, "invalid_request", "stream must be a boolean");
  }
  if (body.channel !== undefined && body.channel !== "voice") {
    throw new RuntimeRequestError(422, "invalid_request", "channel must be voice when provided");
  }
  if (
    body.mode !== undefined &&
    body.mode !== "thread" &&
    body.mode !== "capture" &&
    body.mode !== "delivery"
  ) {
    throw new RuntimeRequestError(422, "invalid_request", "mode is invalid");
  }

  return {
    model,
    messages,
    stream: body.stream ?? false,
    user,
    channel: body.channel,
    mode: body.mode,
    co_hint: optionalString(body.co_hint, "co_hint", MAX_HINT_LENGTH),
    session: optionalString(body.session, "session", MAX_SESSION_LENGTH),
  };
}

export async function readTurnEnvelope(
  req: IncomingMessage,
  config: RuntimeConfig,
): Promise<TurnEnvelope> {
  const raw = await readBoundedBody(req, config.maxBodyBytes, config.bodyTimeoutMs);
  let value: unknown;
  try {
    value = JSON.parse(raw || "{}");
  } catch {
    throw new RuntimeRequestError(400, "invalid_json", "request body is not valid JSON");
  }
  return parseTurnEnvelope(value);
}

export function requestPath(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}
