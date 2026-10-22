import { createHash } from "node:crypto";
import { z } from "zod";
import { sourceCoverage, sourceTypes } from "./artifact";
import { consentStates, evidenceSegmentSchema, provenanceClasses } from "./signals";

export const transports = ["sendblue", "linq", "sms", "app"] as const;
export const messageDirections = ["inbound", "outbound"] as const;
export const deliveryStatuses = ["SENT", "DELIVERED", "READ", "ERROR"] as const;

export const transportSchema = z.enum(transports);
export const messageDirectionSchema = z.enum(messageDirections);
export const deliveryStatusSchema = z.enum(deliveryStatuses);

export const ingestArtifactSchema = z.object({
  source_type: z.enum(sourceTypes),
  canonical_url: z.url().max(4_096).nullable().default(null),
  coverage: z.enum(sourceCoverage),
  extraction: z.string().max(200_000).nullable().default(null),
  timestamp_seconds: z.number().finite().nonnegative().max(604_800).nullable().default(null),
  occurred_at: z.iso.datetime({ offset: true }).nullable().default(null),
  provenance_class: z.enum(provenanceClasses).default("external"),
  consent_state: z.enum(consentStates).default("not_required"),
  source_adapter: z.string().trim().min(1).max(120).nullable().default(null),
  source_adapter_version: z.string().trim().min(1).max(120).nullable().default(null),
  segments: z.array(evidenceSegmentSchema).max(500).default([]),
}).strict().superRefine((artifact, context) => {
  if (!artifact.canonical_url && !artifact.extraction && artifact.segments.length === 0) {
    context.addIssue({ code: "custom", message: "transport artifact requires a URL, rail extraction, or segments" });
  }
  if (artifact.segments.reduce((sum, segment) => sum + segment.text.length, 0) > 200_000) {
    context.addIssue({ code: "custom", path: ["segments"], message: "combined segment text exceeds 200000 characters" });
  }
});

// Store only bounded operational facts. Raw provider payloads and credentials are never accepted.
export const transportMetadataSchema = z.object({
  event_type: z.string().trim().min(1).max(80).optional(),
  message_type: z.string().trim().min(1).max(80).optional(),
  source_version: z.string().trim().min(1).max(80).optional(),
  media_count: z.number().int().min(0).max(8).optional(),
  sms_fallback: z.boolean().optional(),
  error_code: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/).optional(),
}).strip();

// The outer object strips unknown fields for forward compatibility. Nested content-bearing fields
// remain bounded and transport_metadata is explicitly allowlisted above.
export const ingestEnvelopeSchema = z.object({
  idempotency_key: z.string().trim().min(1).max(240),
  tenant_phone: z.string().regex(/^\+[1-9]\d{6,14}$/, "must be E.164"),
  transport: transportSchema,
  direction: messageDirectionSchema,
  external_message_id: z.string().trim().min(1).max(512).nullable(),
  external_thread_id: z.string().trim().min(1).max(512),
  text: z.string().max(200_000).nullable(),
  media_urls: z.array(z.url().max(4_096)).max(8).default([]),
  sent_at: z.iso.datetime({ offset: true }),
  status: deliveryStatusSchema.nullable(),
  reply_to_external_id: z.string().trim().min(1).max(512).nullable(),
  artifacts: z.array(ingestArtifactSchema).max(8).default([]),
  transport_metadata: transportMetadataSchema.default({}),
}).superRefine((envelope, context) => {
  if (envelope.status && !envelope.external_message_id) {
    context.addIssue({ code: "custom", path: ["external_message_id"], message: "status callback requires an external message id" });
  }
  if (!envelope.status && !envelope.text && envelope.media_urls.length === 0 && envelope.artifacts.length === 0) {
    context.addIssue({ code: "custom", message: "message envelope requires text, media, or an artifact" });
  }
});

export const ingestResponseSchema = z.object({
  ok: z.literal(true),
  message_id: z.uuid(),
  deduped: z.boolean(),
}).strict();

export type Transport = z.infer<typeof transportSchema>;
export type MessageDirection = z.infer<typeof messageDirectionSchema>;
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;
export type IngestArtifact = z.infer<typeof ingestArtifactSchema>;
export type TransportMetadata = z.infer<typeof transportMetadataSchema>;
export type IngestEnvelope = z.infer<typeof ingestEnvelopeSchema>;
export type IngestResponse = z.infer<typeof ingestResponseSchema>;

// merged 2026-07-27: both trees defined this seam identically but named it differently — mine
// PascalCase, codex's camelCase+Schema. Codex's names win (the live receiver and all nine of its
// contract modules use them); these aliases keep my packages compiling without a rename sweep.
export const Transport = transportSchema;
export const MessageDirection = messageDirectionSchema;
export const DeliveryStatus = deliveryStatusSchema;
export const IngestArtifact = ingestArtifactSchema;
export const IngestEnvelope = ingestEnvelopeSchema;

/** The sender-side idempotency rule from docs/ingest-contract.md v1.1. Mine, kept: codex's tree
 *  computes this inside the receiver, but the SENDER (frame/co_dualwrite.py) needs the same rule
 *  expressed once, and the spooled-replay guarantee depends on it being identical on both sides. */
export function envelopeIdempotencyKey(
  env: Pick<IngestEnvelope, "transport" | "tenant_phone" | "direction" | "external_message_id" | "text" | "sent_at">,
): string {
  if (env.external_message_id) return `${env.transport}:${env.external_message_id}`;
  const bucket = Math.floor(Date.parse(env.sent_at) / 5000); // floor(epoch_seconds / 5)
  const sig = createHash("sha256").update(`${env.tenant_phone}|${env.direction}|${env.text ?? ""}|${bucket}`).digest("hex");
  return `${env.transport}:sig:${sig}`;
}
