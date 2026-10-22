import { z } from "zod";

export const standingOrderCreateSchema = z.object({
  instruction: z.string().trim().min(1).max(500),
  scope: z.string().trim().min(1).max(80).default("all"),
  exactReceipt: z.uuid().nullable().default(null),
}).strict();

export const standingOrderSchema = z.object({
  id: z.uuid(),
  instruction: z.string().max(500),
  scope: z.string().max(80),
  exactReceipt: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();

export const memoryReturnSchema = z.object({
  id: z.uuid(),
  oldArtifactId: z.uuid(),
  triggerArtifactId: z.uuid().nullable(),
  triggerMessageId: z.uuid().nullable(),
  reason: z.string().max(500),
  copy: z.string().max(1_000),
  status: z.enum(["approved", "delivered"]),
  createdAt: z.iso.datetime({ offset: true }),
  deliveredAt: z.iso.datetime({ offset: true }).nullable(),
  oldReceipt: z.object({
    title: z.string().max(500).nullable(),
    publisher: z.string().max(500).nullable(),
    canonicalUrl: z.url().nullable(),
    capturedAt: z.iso.datetime({ offset: true }),
    coverage: z.string().max(40),
  }).strict(),
}).strict();

export const legacyClaimImportSchema = z.object({
  sourceClaimId: z.string().trim().min(1).max(200),
  statement: z.string().trim().min(1).max(1_000),
  evidenceArtifactIds: z.array(z.uuid()).min(1).max(20),
  alternatives: z.array(z.string().trim().min(1).max(500)).max(5).default([]),
  sourceSystem: z.string().trim().min(1).max(80).default("predecessor"),
}).strict();

export type StandingOrder = z.infer<typeof standingOrderSchema>;
export type MemoryReturn = z.infer<typeof memoryReturnSchema>;

