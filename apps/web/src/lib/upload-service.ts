import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const allowedMIME = new Set(["image/jpeg", "image/png", "image/heic", "audio/m4a", "audio/mp4", "video/mp4", "text/plain", "application/pdf"]);

export const uploadRequestSchema = z.object({
  clientArtifactId: z.uuid(),
  attachments: z.array(z.object({
    filename: z.string().trim().min(1).max(180),
    mimeType: z.string().trim().min(1).max(120),
    byteCount: z.number().int().positive().max(50 * 1024 * 1024),
  }).strict()).min(1).max(8),
}).strict();

function safeExtension(filename: string) {
  const candidate = filename.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  return candidate.slice(0, 10);
}

export async function createUploadSlots(admin: SupabaseClient, userId: string, unknownInput: unknown) {
  const input = uploadRequestSchema.parse(unknownInput);
  const slots = await Promise.all(input.attachments.map(async (attachment) => {
    if (!allowedMIME.has(attachment.mimeType)) throw new Error("unsupported_mime_type");
    const extension = safeExtension(attachment.filename);
    const objectId = crypto.randomUUID();
    const path = `${userId}/${input.clientArtifactId}/${objectId}${extension ? `.${extension}` : ""}`;
    const signed = await admin.storage.from("artifacts").createSignedUploadUrl(path, { upsert: false });
    if (signed.error) throw signed.error;
    return { path, signedUrl: signed.data.signedUrl, token: signed.data.token, mimeType: attachment.mimeType, byteCount: attachment.byteCount };
  }));
  return { bucket: "artifacts", slots };
}

export function assertOwnedObjectPaths(userId: string, clientArtifactId: string, paths: string[]) {
  const prefix = `${userId}/${clientArtifactId}/`;
  if (paths.some((path) => !path.startsWith(prefix) || path.includes(".."))) throw new Error("invalid_object_path");
}
