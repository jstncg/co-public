import { normalizeInboundAttachments } from "./deposits.ts";
import { withAbort } from "./abort.ts";
import { stableId } from "./id.ts";
import { fetchPublicResource, type ResourceFetcher } from "./media.ts";
import type { OriginalStore } from "./originals.ts";
import type { ImagePart, InboundAttachment, MessagePart, ProviderRequest, RuntimeMessage } from "./types.ts";

export const MAX_NATIVE_IMAGE_BYTES = 3_000_000;
export const MAX_NATIVE_IMAGES = 4;

export function validateImageRequest(request: ProviderRequest): void {
  let count = 0;
  for (const message of request.messages) for (const part of message.parts) {
    if (part.type === "audio") throw new Error("Audio must pass through foreground perception before provider dispatch");
    if (part.type !== "image") continue;
    if (message.role !== "user" || ++count > MAX_NATIVE_IMAGES) throw new Error("Native image request exceeds role or count limits");
    imageData(part);
  }
}

export function imageReferences(attachments: InboundAttachment[], sourceEventId: string): ImagePart[] {
  return attachments.flatMap((attachment) => {
    const mimeType = attachment.mimeType?.toLowerCase().split(";")[0]?.trim();
    return mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp"
      ? [{ type: "image" as const, sourceEventId, attachmentId: attachment.id, mimeType }] : [];
  });
}

function matchesSignature(bytes: Buffer, mimeType: ImagePart["mimeType"]): boolean {
  if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mimeType === "image/jpeg") return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return mimeType === "image/webp" && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
}

export function imageData(part: ImagePart): string {
  if (typeof part.data !== "string" || !part.data || part.data.length > Math.ceil(MAX_NATIVE_IMAGE_BYTES / 3) * 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)) {
    throw new Error("Image bytes are missing, oversized, or invalid base64");
  }
  const bytes = Buffer.from(part.data, "base64");
  if (bytes.toString("base64") !== part.data || !matchesSignature(bytes, part.mimeType)) throw new Error("Image MIME type does not match its bytes");
  return part.data;
}

/** Cached originals survive expired URLs and restarts. Raw URLs and failures
 * never enter prompts. The newest four images bound payload and latency. */
export async function hydrateImages(originals: OriginalStore, tenantId: string, messages: RuntimeMessage[], options: {
  fetchResource?: ResourceFetcher;
  assertLease: () => void;
}): Promise<RuntimeMessage[]> {
  const refs = messages.flatMap((message) => message.parts.filter((part) => part.type === "image"));
  const selected = new Set(refs.slice(-MAX_NATIVE_IMAGES));
  const signal = AbortSignal.timeout(12_000);
  const fetcher: ResourceFetcher = options.fetchResource ?? ((url, headers, limit) => fetchPublicResource(url, headers, limit, 5, { signal }));
  return Promise.all(messages.map(async (message) => ({
    ...message,
    parts: await Promise.all(message.parts.map(async (part): Promise<MessagePart> => {
      if (part.type !== "image") return part;
      if (!selected.has(part)) return { type: "text", text: "[Earlier image omitted from this bounded visual context; do not infer its contents.]" };
      if (message.role !== "user" || !part.sourceEventId || !part.attachmentId || part.data !== undefined) throw new Error("Invalid durable image provenance");
      const source = originals.store.getEvent(tenantId, part.sourceEventId);
      const payload = source?.payload;
      const attachment = payload && typeof payload === "object" && !Array.isArray(payload)
        ? normalizeInboundAttachments(payload.attachments).find((item) => item.id === part.attachmentId) : undefined;
      if (!source || !attachment || !imageReferences([attachment], source.id).some((ref) => ref.mimeType === part.mimeType)) {
        throw new Error("Image source is missing, cross-tenant, or has a different MIME binding");
      }
      try {
        options.assertLease();
        let original = originals.forAttachment(tenantId, source.id, part.attachmentId);
        if (!original) {
          const resource = await withAbort(fetcher(attachment.url, { Accept: part.mimeType }, Math.min(originals.maximumBytes, MAX_NATIVE_IMAGE_BYTES)), signal);
          options.assertLease();
          if (resource.status !== 200) throw new Error("Image fetch was not successful");
          imageData({ ...part, data: resource.body.toString("base64") });
          original = originals.preserve({
            tenantId, sourceEventId: source.id, attachmentId: part.attachmentId, sourceUri: attachment.url,
            finalUri: resource.url, mimeType: part.mimeType, data: resource.body,
            ...(attachment.filename ? { filename: attachment.filename } : {}),
          });
        }
        if (original.sourceUri !== attachment.url || original.mimeType !== part.mimeType) throw new Error("Original image binding changed");
        const bytes = originals.bytes(tenantId, original.id);
        if (!bytes) throw new Error("Original image bytes are missing");
        const hydrated = { ...part, data: bytes.toString("base64") };
        imageData(hydrated);
        return hydrated;
      } catch {
        options.assertLease();
        originals.store.appendEvent({
          id: stableId("evt", `image-unavailable:${tenantId}:${source.id}:${part.attachmentId}`),
          tenantId, stream: `original:${source.id}`, type: "image.foreground_unavailable", causationId: source.id,
          payload: { attachmentId: part.attachmentId, reason: "fetch-or-validation-failed" },
        });
        return { type: "text", text: "[Image unavailable: its bytes could not be loaded or validated. Do not describe its contents or claim to have seen it.]" };
      }
    })),
  })));
}
