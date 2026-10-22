import { createHmac, timingSafeEqual } from "node:crypto";
import { DependencyError, dependencyNetworkError, retryAfterMilliseconds } from "./dependency-errors.ts";
import { normalizeInboundAttachments } from "./deposits.ts";
import { canonicalProviderPhoneIdentity } from "./identity.ts";
import type { InboundAttachment, JsonObject, LinqConfig, TapbackType } from "./types.ts";

type UnknownObject = Record<string, unknown>;

function object(value: unknown): UnknownObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownObject : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function header(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export interface LinqParsedEvent {
  kind: "message" | "status" | "reaction" | "typing" | "ignored";
  eventType: string;
  eventId: string;
  chatId: string;
  peerId?: string;
  messageId?: string;
  text?: string;
  mediaUrls: string[];
  attachments: InboundAttachment[];
  isGroup: boolean;
  /** Direction and direct/group state were explicit in a supported schema. */
  trustedShape: boolean;
  payload: JsonObject;
}

/** Standard Webhooks verification, including its five-minute replay window. */
export function verifyLinqWebhook(
  secret: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Uint8Array,
  nowMs = Date.now(),
): boolean {
  const messageId = header(headers["webhook-id"]);
  const timestamp = header(headers["webhook-timestamp"]);
  const signature = header(headers["webhook-signature"]);
  if (!secret || !messageId || !timestamp || !signature || rawBody.byteLength === 0) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(nowMs / 1_000 - seconds) > 300) return false;
  let key: Buffer;
  try {
    key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  } catch {
    return false;
  }
  if (!key.length) return false;
  const signed = Buffer.concat([Buffer.from(`${messageId}.${timestamp}.`), Buffer.from(rawBody)]);
  const expected = createHmac("sha256", key).update(signed).digest();
  return signature.split(" ").some((candidate) => {
    const [version, encoded] = candidate.split(",", 2);
    if (version !== "v1" || !encoded) return false;
    let actual: Buffer;
    try { actual = Buffer.from(encoded, "base64"); } catch { return false; }
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

export function parseLinqEvent(value: unknown): LinqParsedEvent {
  const root = object(value);
  const eventType = text(root.event_type);
  const data = object(root.data);
  const chat = object(data.chat);
  const legacyMessage = object(data.message);
  const chatId = text(chat.id) || text(data.chat_id);
  const messageId = text(data.id) || text(data.message_id) || text(legacyMessage.id);
  const eventId = text(root.id) || `${eventType}:${chatId}:${messageId}`;
  const parts = Array.isArray(data.parts) ? data.parts : Array.isArray(legacyMessage.parts) ? legacyMessage.parts : [];
  const parsedParts = parts.map(object);
  const attachments = normalizeInboundAttachments(parsedParts.filter((part) => part.type === "media" && text(part.url)).map((part) => ({
    id: text(part.id) || text(part.attachment_id),
    url: text(part.url),
    mimeType: text(part.mime_type) || text(part.content_type),
    filename: text(part.filename) || text(part.name),
    sizeBytes: part.size_bytes ?? part.size,
  })));
  const mediaUrls = attachments.map((attachment) => attachment.url);
  const content = parsedParts.filter((part) => part.type === "text").map((part) => text(part.value)).filter(Boolean).join("\n").trim();
  const senderHandle = object(data.sender_handle);
  const sender = canonicalProviderPhoneIdentity(text(senderHandle.handle) || text(object(data.from_handle).handle) || text(data.from));
  const isGroup = chat.is_group === true || data.is_group === true;
  const v2 = root.webhook_version === "2026-02-03";
  const explicitGroup = typeof chat.is_group === "boolean";
  const direction = text(data.direction);
  const trustedV2Inbound = v2 && explicitGroup && direction === "inbound" && senderHandle.is_me === false;
  const trustedV2Outbound = v2 && explicitGroup && direction === "outbound";
  const payload = root as JsonObject;

  if (eventType === "message.received") {
    if (isGroup || !chatId || !sender || (!content && mediaUrls.length === 0)) {
      return { kind: "ignored", eventType, eventId, chatId, ...(sender ? { peerId: sender } : {}), ...(messageId ? { messageId } : {}), mediaUrls, attachments, isGroup, trustedShape: trustedV2Inbound, payload };
    }
    return { kind: "message", eventType, eventId, chatId, peerId: sender, ...(messageId ? { messageId } : {}), text: content, mediaUrls, attachments, isGroup, trustedShape: trustedV2Inbound, payload };
  }
  if (["message.sent", "message.delivered", "message.read", "message.failed"].includes(eventType)) {
    return { kind: "status", eventType, eventId, chatId, ...(messageId ? { messageId } : {}), mediaUrls: [], attachments: [], isGroup, trustedShape: trustedV2Outbound, payload };
  }
  if (eventType === "reaction.added" && data.is_from_me !== true) {
    const peerId = canonicalProviderPhoneIdentity(text(data.from));
    return { kind: "reaction", eventType, eventId, chatId, ...(peerId ? { peerId } : {}), ...(text(data.message_id) ? { messageId: text(data.message_id) } : {}), mediaUrls: [], attachments: [], isGroup, trustedShape: data.is_from_me === false && typeof chat.is_group === "boolean", payload };
  }
  if (eventType === "chat.typing_indicator.started" || eventType === "chat.typing_indicator.stopped") {
    return { kind: "typing", eventType, eventId, chatId, mediaUrls: [], attachments: [], isGroup, trustedShape: typeof chat.is_group === "boolean" && data.is_from_me === false, payload };
  }
  return { kind: "ignored", eventType, eventId, chatId, mediaUrls: [], attachments: [], isGroup, trustedShape: false, payload };
}

export class LinqAdapter {
  readonly config: LinqConfig;

  constructor(config: LinqConfig) {
    this.config = config;
  }

  configured(): boolean {
    return Boolean(this.config.apiKey && this.config.fromNumber);
  }

  async send(input: { peerId: string; content: string; chatId?: string; replyTo?: string; idempotencyKey?: string }): Promise<JsonObject> {
    if (!this.config.apiKey || !this.config.fromNumber) throw new Error("Linq is not configured");
    const message = { parts: [{ type: "text", value: input.content }] };
    const path = input.chatId ? `/chats/${encodeURIComponent(input.chatId)}/messages` : "/chats";
    const body = input.chatId
      ? { message, ...(input.replyTo ? { reply_to: { message_id: input.replyTo } } : {}) }
      : { to: [input.peerId], from: this.config.fromNumber, message };
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json",
          ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const dependency = dependencyNetworkError("Linq", error);
      throw new DependencyError({ service: dependency.service, kind: dependency.kind, message: dependency.message, retryable: true, uncertain: true });
    }
    const raw = await response.text();
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw: raw.slice(0, 500) }; }
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const retryAfterMs = response.status === 429 ? retryAfterMilliseconds(response.headers.get("retry-after")) : undefined;
      const error = object(object(parsed).error);
      const detail = text(error.message) || raw.slice(0, 300);
      throw new DependencyError({
        service: "Linq",
        kind: response.status === 429 ? "rate_limited" : response.status === 408 || response.status >= 500 ? "unavailable" : response.status === 401 || response.status === 403 ? "authentication" : "invalid_request",
        message: `Linq send failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
        retryable,
        uncertain: response.status !== 429 && (response.status === 408 || response.status >= 500),
        httpStatus: response.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    const result = object(parsed);
    const chatId = text(result.chat_id) || text(object(result.chat).id) || input.chatId;
    const returnedMessage = object(result.message);
    const messageId = text(returnedMessage.id) || text(result.message_id) || text(result.id);
    if (!messageId) throw new DependencyError({
      service: "Linq", kind: "malformed_response",
      message: "Linq returned HTTP success without a provider message ID; acceptance cannot be proven",
      retryable: false, uncertain: true, httpStatus: response.status,
    });
    const status = text(returnedMessage.delivery_status) || text(result.status);
    return { provider: "linq", ...(chatId ? { chatId } : {}), messageId, ...(status ? { status } : {}) };
  }

  async react(targetMessageId: string, type: TapbackType, idempotencyKey?: string): Promise<JsonObject> {
    if (!this.config.apiKey || !this.config.fromNumber) throw new Error("Linq is not configured");
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/messages/${encodeURIComponent(targetMessageId)}/reactions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify({ operation: "add", type }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const dependency = dependencyNetworkError("Linq", error);
      throw new DependencyError({ service: dependency.service, kind: dependency.kind, message: dependency.message, retryable: true, uncertain: true });
    }
    const raw = await response.text();
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const retryAfterMs = response.status === 429 ? retryAfterMilliseconds(response.headers.get("retry-after")) : undefined;
      throw new DependencyError({
        service: "Linq", kind: response.status === 429 ? "rate_limited" : response.status === 408 || response.status >= 500 ? "unavailable" : response.status === 401 || response.status === 403 ? "authentication" : "invalid_request",
        message: `Linq reaction failed: HTTP ${response.status}${raw ? ` ${raw.slice(0, 300)}` : ""}`, retryable,
        uncertain: response.status !== 429 && (response.status === 408 || response.status >= 500), httpStatus: response.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    return { provider: "linq", targetMessageId, reactionType: type, status: "accepted" };
  }
}
