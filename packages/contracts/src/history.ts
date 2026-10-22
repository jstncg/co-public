import { z } from "zod";
import { sourceCoverage, sourceTypes } from "./artifact";
import { transportSchema } from "./transport";

export const messageContextSchema = z.object({
  messageId: z.uuid(),
  direction: z.enum(["inbound", "outbound"]),
  transport: transportSchema,
  textPreview: z.string().max(500).nullable(),
  sentAt: z.iso.datetime({ offset: true }),
  deliveredAt: z.iso.datetime({ offset: true }).nullable(),
  readAt: z.iso.datetime({ offset: true }).nullable(),
  mediaCount: z.number().int().min(0).max(8),
}).strict();

export const catchReceiptSchema = z.object({
  canonicalUrl: z.url(),
  sourceTitle: z.string().max(500).nullable(),
  publisher: z.string().max(500).nullable(),
  coverage: z.enum(sourceCoverage),
  retrievedAt: z.iso.datetime({ offset: true }),
}).strict();

export const catchHistoryItemSchema = z.object({
  artifactId: z.uuid(),
  clientArtifactId: z.uuid(),
  sourceType: z.enum(sourceTypes),
  canonicalUrl: z.url().nullable(),
  title: z.string().max(500).nullable(),
  publisher: z.string().max(500).nullable(),
  textPreview: z.string().max(500).nullable(),
  userNote: z.string().max(2_000).nullable(),
  coverage: z.enum(sourceCoverage),
  processingStatus: z.string().max(80),
  capturedAt: z.iso.datetime({ offset: true }),
  messageContext: messageContextSchema.nullable(),
  receipt: catchReceiptSchema.nullable(),
}).strict();

export const relationshipSummarySchema = z.object({
  messageCount: z.number().int().nonnegative(),
  sharedMomentCount: z.number().int().nonnegative(),
  recurringThreadCount: z.number().int().nonnegative(),
  thingsTakingShapeCount: z.number().int().nonnegative(),
  radarCount: z.number().int().nonnegative(),
}).strict();

export const catchHistoryResponseSchema = z.object({
  summary: relationshipSummarySchema,
  catches: z.array(catchHistoryItemSchema).max(250),
}).strict();

export const artifactCorrectionSchema = z.object({
  clientArtifactId: z.uuid(),
  correction: z.string().trim().min(1).max(1_000),
}).strict();

export type CatchHistoryItem = z.infer<typeof catchHistoryItemSchema>;
export type CatchHistoryResponse = z.infer<typeof catchHistoryResponseSchema>;
export type ArtifactCorrection = z.infer<typeof artifactCorrectionSchema>;
