import { stableId } from "./id.ts";
import type { InboundAttachment, JsonValue } from "./types.ts";

const MAX_ATTACHMENTS = 10;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximum) : undefined;
}

/** Normalize an untrusted connector attachment without dereferencing it. */
export function normalizeInboundAttachments(value: unknown): InboundAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: InboundAttachment[] = [];
  for (const [index, raw] of value.slice(0, MAX_ATTACHMENTS).entries()) {
    const candidate = object(raw);
    const url = boundedText(candidate.url, 16_384);
    if (!url) continue;
    const id = boundedText(candidate.id, 256) ?? stableId("attachment", `${index}:${url}`);
    const mimeType = boundedText(candidate.mimeType ?? candidate.mime_type, 256);
    const filename = boundedText(candidate.filename ?? candidate.file_name ?? candidate.name, 1_024);
    const size = candidate.sizeBytes ?? candidate.size_bytes ?? candidate.size;
    const sizeBytes = typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : undefined;
    attachments.push({ id, url, ...(mimeType ? { mimeType } : {}), ...(filename ? { filename } : {}), ...(sizeBytes !== undefined ? { sizeBytes } : {}) });
  }
  return attachments;
}

export function attachmentJson(attachments: InboundAttachment[]): JsonValue[] {
  return attachments.map((attachment) => ({
    id: attachment.id,
    url: attachment.url,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
  }));
}

export function attachmentDigest(attachments: InboundAttachment[]): string {
  return stableId("attachment-set", JSON.stringify(attachmentJson(attachments)));
}

function mediaKind(mimeType: string | undefined): string {
  if (!mimeType) return "file";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf" || mimeType.includes("document") || mimeType.includes("word")) return "document";
  return "file";
}

/** Text shown to the foreground model. It conveys modality, never a signed URL. */
export function attachmentMarker(attachment: InboundAttachment, index: number): string {
  const label = attachment.filename ? ` ${attachment.filename}` : "";
  return `[attachment ${index + 1}: ${mediaKind(attachment.mimeType)}${label}]`;
}

/** A model/log-safe source label. The exact capability URL remains in durable
 * attachment/job state but query credentials and fragments do not cross the
 * foreground or analysis prompt boundary. */
export function safeSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "submitted attachment";
  }
}

export function redactCapabilityUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s<>]+/g, (candidate) => safeSourceUrl(candidate.replace(/[\])},.;!?]+$/, "")));
}
