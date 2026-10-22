import { z } from "zod";

export const provenanceClasses = ["owner", "participant", "external", "system"] as const;
export const consentStates = ["owner_supplied", "participants_consented", "unknown", "not_required"] as const;
export const speakerRelations = ["user", "other_person", "source", "unknown"] as const;
export const segmentContentKinds = ["transcript", "caption", "turn", "ocr", "description", "normalized_text"] as const;

export const evidenceSegmentSchema = z.object({
  segment_key: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/),
  content_kind: z.enum(segmentContentKinds),
  text: z.string().trim().min(1).max(50_000),
  start_offset: z.number().int().nonnegative().nullable().default(null),
  end_offset: z.number().int().nonnegative().nullable().default(null),
  start_seconds: z.number().finite().nonnegative().max(604_800).nullable().default(null),
  end_seconds: z.number().finite().nonnegative().max(604_800).nullable().default(null),
  speaker_label: z.string().trim().min(1).max(120).nullable().default(null),
  speaker_relation: z.enum(speakerRelations).default("unknown"),
  provenance_class: z.enum(provenanceClasses).default("external"),
  confidence: z.number().min(0).max(1).default(1),
}).strict().superRefine((segment, context) => {
  if (segment.start_offset !== null && segment.end_offset !== null && segment.end_offset < segment.start_offset) {
    context.addIssue({ code: "custom", path: ["end_offset"], message: "must be at or after start_offset" });
  }
  if (segment.start_seconds !== null && segment.end_seconds !== null && segment.end_seconds < segment.start_seconds) {
    context.addIssue({ code: "custom", path: ["end_seconds"], message: "must be at or after start_seconds" });
  }
});

export const signalTypes = [
  "source_claim", "user_statement", "commitment", "question", "entity", "preference", "moment",
] as const;
export const signalSubjectRelations = ["source", "user", "other_person", "unknown"] as const;
export const signalSensitivities = ["low", "medium", "high"] as const;

export const signalCandidateSchema = z.object({
  signal_type: z.enum(signalTypes),
  subject_relation: z.enum(signalSubjectRelations),
  statement: z.string().trim().min(1).max(500),
  confidence: z.number().min(0).max(1),
  supporting_segment_keys: z.array(z.string().min(1).max(160)).max(16),
  contradicting_segment_keys: z.array(z.string().min(1).max(160)).max(16),
  uncertainty: z.string().trim().min(1).max(300).nullable(),
  sensitivity: z.enum(signalSensitivities),
}).strict();

export const signalCompilationSchema = z.object({
  signals: z.array(signalCandidateSchema).max(24),
}).strict();

export const usefulnessLanes = [
  "reply_now", "return_later", "update_candidate", "watch_candidate", "move_draft", "hold",
] as const;

export const usefulnessCandidateSchema = z.object({
  lane: z.enum(usefulnessLanes),
  reason: z.string().trim().min(1).max(500),
  supporting_segment_keys: z.array(z.string().min(1).max(160)).max(16),
  relevance: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  actionability: z.number().min(0).max(1),
  requires_review: z.literal(true),
  not_before: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export type EvidenceSegment = z.infer<typeof evidenceSegmentSchema>;
export type SignalCandidate = z.infer<typeof signalCandidateSchema>;
export type SignalCompilation = z.infer<typeof signalCompilationSchema>;
export type UsefulnessLane = (typeof usefulnessLanes)[number];
export type UsefulnessCandidate = z.infer<typeof usefulnessCandidateSchema>;
export type ProvenanceClass = (typeof provenanceClasses)[number];
export type ConsentState = (typeof consentStates)[number];

