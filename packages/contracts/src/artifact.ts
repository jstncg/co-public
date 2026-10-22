import { z } from "zod";

export const sourceTypes = [
  "text", "voice", "image", "screenshot", "url", "article", "youtube",
  "podcast", "short_video", "social_post", "ai_conversation", "place",
  "product", "person", "event", "video", "call", "meeting", "conversation", "other",
] as const;

export const sourceCoverage = ["full_media", "image", "text", "url_only", "unavailable"] as const;

export const artifactCaptureSchema = z.object({
  clientArtifactId: z.uuid(),
  sourceType: z.enum(sourceTypes),
  sourceApp: z.string().trim().max(120).nullable().default(null),
  canonicalUrl: z.url().max(4096).nullable().default(null),
  suppliedText: z.string().max(200_000).nullable().default(null),
  userNote: z.string().max(2_000).nullable().default(null),
  timestampSeconds: z.number().finite().nonnegative().max(604_800).nullable().default(null),
  coverage: z.enum(sourceCoverage),
  analysisAllowed: z.boolean().default(true),
  capturedAt: z.iso.datetime({ offset: true }),
  idempotencyKey: z.string().min(16).max(160),
  uploadObjectKeys: z.array(z.string().min(1).max(512)).max(8).default([]),
}).strict().superRefine((value, context) => {
  if (!value.canonicalUrl && !value.suppliedText && value.uploadObjectKeys.length === 0) {
    context.addIssue({ code: "custom", message: "capture must include a URL, text, or supplied object" });
  }
  if (!value.analysisAllowed && value.coverage === "unavailable") return;
});

export type ArtifactCapture = z.infer<typeof artifactCaptureSchema>;

export const artifactReceiptSchema = z.object({
  artifactId: z.uuid(),
  status: z.enum(["queued", "processing", "ready", "saved_without_analysis", "failed_safe"]),
  coverage: z.enum(sourceCoverage),
  localAcknowledgement: z.string().max(160),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();

export type ArtifactReceipt = z.infer<typeof artifactReceiptSchema>;
