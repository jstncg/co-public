import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DependencyError } from "./dependency-errors.ts";
import { id, nowIso, stableId } from "./id.ts";
import type { SqliteStore } from "./store.ts";
import type { JsonObject } from "./types.ts";

type Row = Record<string, string | number | bigint | null | Uint8Array>;
type SecretFields = Record<string, string>;

const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface CredentialHandle {
  id: string;
  tenantId: string;
  workspaceId: string;
  origin: string;
  label: string;
  fieldNames: string[];
  status: "active" | "retired";
  createdAt: string;
  retiredAt?: string;
}

export interface CredentialFillReceipt {
  credentialId: string;
  origin: string;
  targetId: string;
  filledFields: string[];
  screenshotMasked: true;
  eventId: string;
}

export interface CredentialSink {
  currentUrl(): Promise<string>;
  fillSecretFields(input: { expectedOrigin: string; fields: Array<{ selector: string; value: string }> }): Promise<{ filled: number; screenshotMasked: boolean }>;
}

export type CredentialSinkFactory = (targetId: string) => CredentialSink;

function required(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > maximum || normalized.includes("\0")) throw new Error(`${field} exceeds its safe bound`);
  return normalized;
}

function validWorkspace(value: string): string {
  const workspace = required(value, "Credential workspace", 256);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$/.test(workspace)) throw new Error("Credential workspace contains unsupported characters");
  return workspace;
}

export function credentialOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("Credential origin must be an absolute URL"); }
  if (parsed.username || parsed.password) throw new Error("Credential origin may not contain embedded credentials");
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("Credential origin must use HTTPS (HTTP is allowed only for loopback development)");
  }
  return parsed.origin;
}

export function parseCredentialKey(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  let key: Buffer;
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) key = Buffer.from(trimmed, "hex");
  else {
    if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(trimmed)) throw new Error("Credential key must be 32 bytes encoded as base64 or 64 hexadecimal characters");
    key = Buffer.from(trimmed, "base64");
  }
  if (key.byteLength !== 32) throw new Error("Credential key must decode to exactly 32 bytes");
  return key;
}

function fields(value: SecretFields): SecretFields {
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 16) throw new Error("Credential fields must contain 1-16 values");
  const normalized: SecretFields = {};
  let totalBytes = 0;
  for (const [name, secret] of entries) {
    if (!FIELD_NAME.test(name)) throw new Error(`Credential field name is invalid: ${name}`);
    if (typeof secret !== "string" || !secret || secret.includes("\0")) throw new Error(`Credential field ${name} must be a non-empty string without null bytes`);
    totalBytes += Buffer.byteLength(secret);
    if (Buffer.byteLength(secret) > 16_384) throw new Error(`Credential field ${name} exceeds 16 KiB`);
    normalized[name] = secret;
  }
  if (totalBytes > 65_536) throw new Error("Credential fields exceed 64 KiB in total");
  return normalized;
}

function selectorMap(value: Record<string, unknown>, knownFields: Set<string>): Record<string, string> {
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 16) throw new Error("Credential fill needs 1-16 field selectors");
  const normalized: Record<string, string> = {};
  for (const [name, selector] of entries) {
    if (!knownFields.has(name)) throw new Error(`Credential handle has no field named ${name}`);
    if (typeof selector !== "string") throw new Error(`Selector for ${name} must be a string`);
    normalized[name] = required(selector, `Selector for ${name}`, 1_024);
  }
  return normalized;
}

function aad(input: { tenantId: string; workspaceId: string; credentialId: string; origin: string }): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, tenantId: input.tenantId, workspaceId: input.workspaceId, credentialId: input.credentialId, origin: input.origin }));
}

export class CredentialBroker {
  readonly store: SqliteStore;
  readonly workspaceId: string;
  private readonly key: Buffer | undefined;
  private readonly sinkFactory: CredentialSinkFactory | undefined;

  constructor(store: SqliteStore, options: { workspaceId: string; key?: Buffer; sinkFactory?: CredentialSinkFactory }) {
    this.store = store;
    this.workspaceId = validWorkspace(options.workspaceId);
    this.key = options.key ? Buffer.from(options.key) : undefined;
    if (this.key && this.key.byteLength !== 32) throw new Error("Credential broker key must contain exactly 32 bytes");
    this.sinkFactory = options.sinkFactory;
  }

  enabled(): boolean {
    return Boolean(this.key);
  }

  storeCredential(input: { tenantId: string; origin: string; label: string; fields: SecretFields }): CredentialHandle {
    if (!this.key) throw new Error("Credential broker is disabled; configure its encryption key");
    const origin = credentialOrigin(input.origin);
    const label = required(input.label, "Credential label", 256);
    const secretFields = fields(input.fields);
    const credentialId = id("cred");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(aad({ tenantId: input.tenantId, workspaceId: this.workspaceId, credentialId, origin }));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secretFields), "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const createdAt = nowIso();
    this.store.transaction(() => {
      this.store.db.prepare(`INSERT INTO credential_items(
        id,tenant_id,workspace_id,origin,label,field_names_json,ciphertext,iv,auth_tag,status,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        credentialId, input.tenantId, this.workspaceId, origin, label, JSON.stringify(Object.keys(secretFields).sort()),
        ciphertext.toString("base64"), iv.toString("base64"), authTag.toString("base64"), "active", createdAt,
      );
      this.store.appendEvent({
        id: stableId("evt", `credential-stored:${input.tenantId}:${credentialId}`), tenantId: input.tenantId,
        stream: `credential:${credentialId}`, type: "credential.stored",
        payload: { credentialId, workspaceId: this.workspaceId, origin, label, fieldNames: Object.keys(secretFields).sort() },
      });
    });
    return this.require(input.tenantId, credentialId);
  }

  get(tenantId: string, credentialId: string): CredentialHandle | undefined {
    const row = this.store.db.prepare("SELECT * FROM credential_items WHERE tenant_id=? AND id=?").get(tenantId, credentialId) as Row | undefined;
    return row ? this.handleFromRow(row) : undefined;
  }

  list(tenantId: string, limit = 100): CredentialHandle[] {
    return (this.store.db.prepare("SELECT * FROM credential_items WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?")
      .all(tenantId, Math.max(1, Math.min(1_000, Math.floor(limit)))) as Row[]).map((row) => this.handleFromRow(row));
  }

  retire(tenantId: string, credentialId: string): CredentialHandle {
    const handle = this.require(tenantId, credentialId);
    if (handle.status === "retired") return handle;
    const retiredAt = nowIso();
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE credential_items SET status='retired',retired_at=? WHERE tenant_id=? AND id=? AND status='active'")
        .run(retiredAt, tenantId, credentialId);
      this.store.appendEvent({
        id: stableId("evt", `credential-retired:${tenantId}:${credentialId}`), tenantId,
        stream: `credential:${credentialId}`, type: "credential.retired", payload: { credentialId },
      });
    });
    return this.require(tenantId, credentialId);
  }

  async fill(input: { tenantId: string; credentialId: string; targetId: string; selectors: Record<string, unknown> }): Promise<CredentialFillReceipt> {
    if (!this.key || !this.sinkFactory) throw new Error("Browser credential filling is not configured");
    const handle = this.require(input.tenantId, input.credentialId);
    if (handle.status !== "active") throw new Error("Credential handle is retired");
    if (handle.workspaceId !== this.workspaceId) throw new Error("Credential handle is outside this browser workspace");
    const targetId = required(input.targetId, "Browser target", 256);
    const selectors = selectorMap(input.selectors, new Set(handle.fieldNames));
    const sink = this.sinkFactory(targetId);
    const currentOrigin = credentialOrigin(await sink.currentUrl());
    if (currentOrigin !== handle.origin) throw new Error(`Credential origin mismatch: expected ${handle.origin}`);
    const secrets = this.decrypt(input.tenantId, handle);
    const selected = Object.entries(selectors).map(([name, selector]) => ({ selector, value: secrets[name] as string }));
    let result: { filled: number; screenshotMasked: boolean };
    try {
      try {
        result = await sink.fillSecretFields({ expectedOrigin: handle.origin, fields: selected });
      } catch (error) {
        if (error instanceof DependencyError) {
          throw new DependencyError({
            service: error.service, kind: error.kind,
            message: error.uncertain
              ? "Browser credential fill ended without a confirmed outcome"
              : "Browser credential fill was rejected before any confirmed change",
            retryable: error.retryable, uncertain: error.uncertain,
            ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
            ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
          });
        }
        throw new DependencyError({
          service: "browser-credential-fill", kind: "unknown",
          message: "Browser credential fill ended without a confirmed outcome",
          retryable: false, uncertain: true,
        });
      }
    } finally {
      for (const name of Object.keys(secrets)) secrets[name] = "";
    }
    if (result.filled !== selected.length || !result.screenshotMasked) {
      throw new DependencyError({
        service: "browser-credential-fill", kind: "malformed_response",
        message: "Browser did not confirm complete masked credential filling; some fields may have changed",
        retryable: false, uncertain: true,
      });
    }
    const event = this.store.appendEvent({
      tenantId: input.tenantId, stream: `credential:${handle.id}`, type: "credential.filled",
      payload: { credentialId: handle.id, workspaceId: this.workspaceId, origin: handle.origin, targetId, fieldNames: Object.keys(selectors).sort(), screenshotMasked: true },
    });
    return { credentialId: handle.id, origin: handle.origin, targetId, filledFields: Object.keys(selectors).sort(), screenshotMasked: true, eventId: event.id };
  }

  asJson(handle: CredentialHandle): JsonObject {
    return { ...handle, retiredAt: handle.retiredAt ?? null } as unknown as JsonObject;
  }

  private decrypt(tenantId: string, handle: CredentialHandle): SecretFields {
    if (!this.key) throw new Error("Credential broker is disabled");
    const row = this.store.db.prepare("SELECT ciphertext,iv,auth_tag FROM credential_items WHERE tenant_id=? AND id=?")
      .get(tenantId, handle.id) as Row | undefined;
    if (!row) throw new Error("Credential handle does not exist");
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(String(row.iv), "base64"));
      decipher.setAAD(aad({ tenantId, workspaceId: this.workspaceId, credentialId: handle.id, origin: handle.origin }));
      decipher.setAuthTag(Buffer.from(String(row.auth_tag), "base64"));
      plaintext = Buffer.concat([decipher.update(Buffer.from(String(row.ciphertext), "base64")), decipher.final()]);
      const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
      return fields(object(parsed) as SecretFields);
    } catch {
      throw new Error("Credential ciphertext failed workspace-bound authentication");
    } finally {
      plaintext?.fill(0);
    }
  }

  private require(tenantId: string, credentialId: string): CredentialHandle {
    const handle = this.get(tenantId, required(credentialId, "Credential handle", 256));
    if (!handle) throw new Error(`Credential handle not found: ${credentialId}`);
    return handle;
  }

  private handleFromRow(row: Row): CredentialHandle {
    let fieldNames: string[];
    try {
      const parsed: unknown = JSON.parse(String(row.field_names_json));
      if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string" || !FIELD_NAME.test(value))) throw new Error();
      fieldNames = parsed;
    } catch {
      throw new Error(`Credential ${String(row.id)} has corrupt field metadata`);
    }
    const status = String(row.status);
    if (status !== "active" && status !== "retired") throw new Error(`Credential ${String(row.id)} has invalid status`);
    return {
      id: String(row.id), tenantId: String(row.tenant_id), workspaceId: String(row.workspace_id), origin: String(row.origin),
      label: String(row.label), fieldNames, status, createdAt: String(row.created_at),
      ...(typeof row.retired_at === "string" && row.retired_at ? { retiredAt: row.retired_at } : {}),
    };
  }
}

function cdpBase(value: string): URL {
  const url = new URL(value);
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("CDP discovery must use HTTPS or loopback HTTP");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("CDP discovery URL may not contain credentials, query, or fragment");
  return url;
}

async function evaluateCdp(webSocketUrl: string, expression: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let settled = false;
    let dispatched = false;
    const connectionFailure = (message: string, kind: "timeout" | "network" = "network"): DependencyError => new DependencyError({
      service: "browser-cdp", kind, message,
      retryable: !dispatched, uncertain: dispatched,
    });
    const timer = setTimeout(() => {
      finish(() => reject(connectionFailure("Browser credential fill timed out", "timeout")));
    }, 20_000);
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      operation();
    };
    socket.addEventListener("open", () => {
      try {
        socket.send(JSON.stringify({
          id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true },
        }));
        dispatched = true;
      } catch (error) {
        finish(() => reject(connectionFailure(`Browser credential CDP dispatch failed: ${error instanceof Error ? error.message : String(error)}`)));
      }
    });
    socket.addEventListener("error", () => finish(() => reject(connectionFailure("Browser credential CDP connection failed"))));
    socket.addEventListener("close", () => finish(() => reject(connectionFailure("Browser credential CDP connection closed before confirmation"))));
    socket.addEventListener("message", (event) => {
      let response: UnknownCdpResponse;
      try {
        const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
        response = JSON.parse(raw) as UnknownCdpResponse;
      } catch {
        return;
      }
      if (response.id !== 1) return;
      if (response.error) finish(() => reject(connectionFailure("Browser rejected credential fill evaluation")));
      else if (response.result?.exceptionDetails) finish(() => reject(connectionFailure("Browser credential fill evaluation failed")));
      else finish(() => resolve(response.result?.result?.value));
    });
  });
}

interface UnknownCdpResponse {
  id?: number;
  error?: unknown;
  result?: { exceptionDetails?: unknown; result?: { value?: unknown } };
}

export class CdpCredentialSink implements CredentialSink {
  readonly baseUrl: URL;
  readonly targetId: string;

  constructor(baseUrl: string, targetId: string) {
    this.baseUrl = cdpBase(baseUrl);
    this.targetId = required(targetId, "Browser target", 256);
  }

  async currentUrl(): Promise<string> {
    return (await this.target()).url;
  }

  async fillSecretFields(input: { expectedOrigin: string; fields: Array<{ selector: string; value: string }> }): Promise<{ filled: number; screenshotMasked: boolean }> {
    let target: { url: string; webSocketDebuggerUrl: string };
    try {
      target = await this.target();
    } catch {
      throw new DependencyError({
        service: "browser-cdp", kind: "network", message: "Browser target discovery failed before credential fill dispatch",
        retryable: true, uncertain: false,
      });
    }
    const payload = JSON.stringify({ expectedOrigin: input.expectedOrigin, fields: input.fields })
      .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    const expression = `(() => {
      const payload = ${payload};
      if (location.origin !== payload.expectedOrigin) return { error: "origin_changed" };
      let style = document.getElementById("co-credential-screenshot-mask");
      if (!style) {
        style = document.createElement("style");
        style.id = "co-credential-screenshot-mask";
        style.textContent = '[data-co-vault-filled="true"]{-webkit-text-security:disc!important;color:transparent!important;text-shadow:0 0 0 #777!important;}';
        (document.head || document.documentElement).appendChild(style);
      }
      let filled = 0;
      for (const entry of payload.fields) {
        const node = document.querySelector(entry.selector);
        if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) continue;
        const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (!setter) continue;
        node.setAttribute("data-co-vault-filled", "true");
        setter.call(node, entry.value);
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        filled += 1;
      }
      return { filled, screenshotMasked: Boolean(style && style.isConnected), origin: location.origin };
    })()`;
    const result = object(await evaluateCdp(target.webSocketDebuggerUrl, expression));
    if (result.error === "origin_changed" || result.origin !== input.expectedOrigin) {
      throw new DependencyError({
        service: "browser-cdp", kind: "invalid_request", message: "Browser origin changed before credential fill",
        retryable: false, uncertain: false,
      });
    }
    return { filled: typeof result.filled === "number" ? result.filled : 0, screenshotMasked: result.screenshotMasked === true };
  }

  private async target(): Promise<{ url: string; webSocketDebuggerUrl: string }> {
    const endpoint = new URL("json/list", this.baseUrl.toString().endsWith("/") ? this.baseUrl : `${this.baseUrl.toString()}/`);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`CDP discovery failed with HTTP ${response.status}`);
    const raw: unknown = await response.json();
    if (!Array.isArray(raw)) throw new Error("CDP discovery returned malformed target data");
    const record = raw.map(object).find((entry) => entry.id === this.targetId && entry.type === "page");
    if (!record || typeof record.url !== "string" || typeof record.webSocketDebuggerUrl !== "string") throw new Error("Browser page target was not found");
    const webSocket = new URL(record.webSocketDebuggerUrl);
    const expectedProtocol = this.baseUrl.protocol === "https:" ? "wss:" : "ws:";
    if (webSocket.protocol !== expectedProtocol || webSocket.hostname !== this.baseUrl.hostname || webSocket.port !== this.baseUrl.port) {
      throw new Error("CDP target returned a websocket outside the configured browser boundary");
    }
    return { url: record.url, webSocketDebuggerUrl: webSocket.toString() };
  }
}

type UnknownObject = Record<string, unknown>;
function object(value: unknown): UnknownObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownObject : {};
}
