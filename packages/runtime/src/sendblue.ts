import { timingSafeEqual } from "node:crypto";
import { DependencyError, dependencyNetworkError, retryAfterMilliseconds } from "./dependency-errors.ts";
import { attachmentJson, attachmentMarker, normalizeInboundAttachments } from "./deposits.ts";
import { canonicalProviderPhoneIdentity } from "./identity.ts";
import type { InboundMessage, JsonObject, RuntimeConfig, TapbackType } from "./types.ts";

type UnknownObject = Record<string, unknown>;

function object(value: unknown): UnknownObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownObject : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class SendblueAdapter {
  readonly config: RuntimeConfig;

  constructor(config: RuntimeConfig) {
    this.config = config;
  }

  configured(): boolean {
    const value = this.config.sendblue;
    return Boolean(value.apiKeyId && value.apiSecretKey && value.fromNumber);
  }

  verify(secret: string | undefined): boolean {
    const expected = this.config.sendblue.webhookSecret;
    if (!expected) return false;
    if (!secret) return false;
    const left = Buffer.from(secret);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  parseInbound(payload: unknown, tenantId: string): InboundMessage | undefined {
    const body = object(payload);
    if (body.is_outbound !== false) return undefined;
    const content = string(body.content);
    const mediaUrl = string(body.media_url);
    const attachments = normalizeInboundAttachments(mediaUrl ? [{
      id: string(body.media_id) || string(body.attachment_id),
      url: mediaUrl,
      mimeType: string(body.media_type) || string(body.mime_type),
      filename: string(body.media_filename) || string(body.filename),
      sizeBytes: body.media_size ?? body.file_size,
    }] : []);
    const location = object(body.location);
    const locationText = typeof location.latitude === "number" && typeof location.longitude === "number"
      ? `[location shared: ${location.latitude}, ${location.longitude}${typeof location.accuracy === "number" ? ` ±${location.accuracy}m` : ""}]`
      : "";
    const text = [content, ...attachments.map(attachmentMarker), locationText].filter(Boolean).join("\n");
    const rawSenderPeerId = string(body.from_number) || string(body.number);
    const senderPeerId = canonicalProviderPhoneIdentity(rawSenderPeerId);
    const groupId = string(body.group_id);
    const messageType = string(body.message_type);
    const isDirect = (messageType === "message" || messageType === "location") && !groupId;
    const isGroup = messageType === "group" && Boolean(groupId);
    if (!isDirect && !isGroup) return undefined;
    const peerId = groupId ? `group:${groupId}` : senderPeerId;
    if (!peerId || !text) return undefined;
    const externalId = string(body.message_handle) || undefined;
    const metadata: JsonObject = {
      service: string(body.service),
      groupId,
      senderPeerId,
      rawSenderPeerId,
      sendblueNumber: string(body.sendblue_number) || string(body.to_number),
      replyTo: object(body.reply_to) as JsonObject,
      location: object(body.location) as JsonObject,
      participants: Array.isArray(body.participants) ? body.participants.filter((item): item is string => typeof item === "string") : [],
      mediaUrls: mediaUrl ? [mediaUrl] : [],
      ...attachments.length ? { attachments: attachmentJson(attachments) } : {},
    };
    return { tenantId, channel: "sendblue", peerId, text, ...(attachments.length ? { attachments } : {}), ...(externalId ? { externalId } : {}), metadata };
  }

  async send(number: string, content: string, options: { replyTo?: string; idempotencyKey?: string } = {}): Promise<JsonObject> {
    const config = this.config.sendblue;
    if (!config.apiKeyId || !config.apiSecretKey || !config.fromNumber) throw new Error("Sendblue is not configured");
    const groupId = number.startsWith("group:") ? number.slice("group:".length) : undefined;
    const endpoint = groupId ? "send-group-message" : "send-message";
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "sb-api-key-id": config.apiKeyId,
          "sb-api-secret-key": config.apiSecretKey,
          ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          content,
          from_number: config.fromNumber,
          ...(groupId ? { group_id: groupId } : { number }),
          ...(options.replyTo ? { reply_to: { message_handle: options.replyTo } } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const dependency = dependencyNetworkError("Sendblue", error);
      throw new DependencyError({
        service: dependency.service, kind: dependency.kind, message: dependency.message, retryable: true, uncertain: true,
      });
    }
    const raw = await response.text();
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { raw: raw.slice(0, 500) };
    }
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const retryAfterMs = response.status === 429 ? retryAfterMilliseconds(response.headers.get("retry-after")) : undefined;
      throw new DependencyError({
        service: "Sendblue", kind: response.status === 429 ? "rate_limited" : response.status === 408 || response.status >= 500 ? "unavailable" : response.status === 401 || response.status === 403 ? "authentication" : "invalid_request",
        message: `Sendblue send failed: HTTP ${response.status} ${raw.slice(0, 300)}`, retryable,
        // A rate limit is a definitive rejection. Timeouts and server/proxy
        // failures may occur after Sendblue accepted the message.
        uncertain: response.status !== 429 && (response.status === 408 || response.status >= 500), httpStatus: response.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    const result = object(body);
    const messageId = string(result.message_handle) || string(result.message_id) || string(result.id);
    if (!messageId) throw new DependencyError({
      service: "Sendblue", kind: "malformed_response",
      message: "Sendblue returned HTTP success without a provider message ID; acceptance cannot be proven",
      retryable: false, uncertain: true, httpStatus: response.status,
    });
    const status = string(result.status);
    return { provider: "sendblue", messageId, ...(status ? { status } : {}) };
  }

  async react(targetMessageId: string, reaction: TapbackType, idempotencyKey?: string): Promise<JsonObject> {
    const config = this.config.sendblue;
    if (!config.apiKeyId || !config.apiSecretKey || !config.fromNumber) throw new Error("Sendblue is not configured");
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/send-reaction`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json", "sb-api-key-id": config.apiKeyId, "sb-api-secret-key": config.apiSecretKey,
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify({ message_handle: targetMessageId, reaction, from_number: config.fromNumber }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const dependency = dependencyNetworkError("Sendblue", error);
      throw new DependencyError({ service: dependency.service, kind: dependency.kind, message: dependency.message, retryable: true, uncertain: true });
    }
    const raw = await response.text();
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const retryAfterMs = response.status === 429 ? retryAfterMilliseconds(response.headers.get("retry-after")) : undefined;
      throw new DependencyError({
        service: "Sendblue", kind: response.status === 429 ? "rate_limited" : response.status === 408 || response.status >= 500 ? "unavailable" : response.status === 401 || response.status === 403 ? "authentication" : "invalid_request",
        message: `Sendblue reaction failed: HTTP ${response.status}${raw ? ` ${raw.slice(0, 300)}` : ""}`, retryable,
        uncertain: response.status !== 429 && (response.status === 408 || response.status >= 500), httpStatus: response.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    return { provider: "sendblue", targetMessageId, reactionType: reaction, status: "accepted" };
  }
}
