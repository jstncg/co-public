import { z } from "zod";
export const MoveType = z.enum(["open_source","listen_or_read","share_with_person","draft_message","congratulate","create_calendar_draft","create_reminder_draft","open_maps","build_plan","build_checklist","invite_friend","find_options","start_small_experiment","dismiss_with_reason"]);
export type MoveType = z.infer<typeof MoveType>;
const moveTypeSchema = MoveType;  // canonical move enum, now defined at the leaf

const certainty = z.number().min(0).max(1);
const uncertaintySchema = z.object({ field: z.string(), reason: z.string() }).strict();

export const artifactExtractionSchema = z.object({
  source_summary: z.string().max(800),
  entities: z.array(z.string().max(200)).max(20),
  places: z.array(z.string().max(200)).max(20),
  products: z.array(z.string().max(200)).max(20),
  claims: z.array(z.string().max(500)).max(20),
  content_mood: z.string().max(120).nullable(),
  possible_user_intents: z.array(z.string().max(200)).max(8),
  media_access_confidence: certainty,
  uncertainties: z.array(uncertaintySchema).max(12),
}).strict();

export const whyQuestionSchema = z.object({
  prompt: z.string().min(1).max(120),
  options: z.array(z.string().min(1).max(60)).min(2).max(5),
}).strict();

export const immediateResponseSchema = z.object({
  mode: z.enum(["understand", "react", "remember", "move", "quiet"]),
  response: z.string().max(600),
  why_question: whyQuestionSchema.nullable(),
  suggested_actions: z.array(z.object({ move_type: moveTypeSchema, title: z.string() })).default([]),
  confidence: certainty,
  should_wait_for_user: z.boolean(),
}).strict();

const observationChangeSchema = z.object({
  statement: z.string().max(500),
  scope: z.string().max(120),
  confidence: certainty,
  evidence_ids: z.array(z.uuid()).min(1).max(12),
}).strict();

export const memoryUpdateSchema = z.object({
  observations_to_add: z.array(observationChangeSchema).max(12),
  observations_to_invalidate: z.array(z.uuid()).max(12),
  thread_links: z.array(z.object({ thread_id: z.uuid(), relationship: z.string().max(120), confidence: certainty }).strict()).max(8),
  watch_suggestion: z.object({ display_name: z.string().max(200), entity_type: z.string().max(80), reason: z.string().max(300) }).strict().nullable(),
  sensitivity_flags: z.array(z.string().max(100)).max(10),
  requires_user_confirmation: z.boolean(),
}).strict();

export const patternCandidateSchema = z.object({
  statement: z.string().max(500),
  supporting_evidence_ids: z.array(z.uuid()).min(3).max(20),
  contradicting_evidence_ids: z.array(z.uuid()).max(20),
  alternative_explanations: z.array(z.string().max(300)).min(1).max(5),
  confidence: certainty,
  novelty: certainty,
  actionability: certainty,
  sensitivity: z.enum(["low", "medium", "high"]),
  door_hypothesis: z.string().max(400).nullable(),
  why_now: z.string().max(300).nullable(),
}).strict();

export const radarAssessmentSchema = z.object({
  event_type: z.string().max(80),
  event_summary: z.string().max(600),
  source_facts: z.array(z.string().max(300)).min(1).max(10),
  personal_relevance: certainty,
  novelty: certainty,
  timeliness: certainty,
  actionability: certainty,
  source_trust: certainty,
  creepiness_risk: certainty,
  why_user: z.string().max(500),
  suggested_actions: z.array(z.object({ move_type: moveTypeSchema, title: z.string() })).max(4).default([]),
  send_recommendation: z.enum(["send", "inbox_only", "discard"]),
}).strict();

export const webCitationSchema = z.object({
  url: z.url(),
  title: z.string().min(1).max(300),
  startIndex: z.number().int().nonnegative(),
  endIndex: z.number().int().nonnegative(),
}).strict().refine((citation) => citation.endIndex >= citation.startIndex, "citation range is invalid");

export const webSearchResultSchema = z.object({
  query: z.string().min(1).max(320),
  summary: z.string().min(1).max(4_000),
  citations: z.array(webCitationSchema).min(1).max(30),
}).strict();

export const moveTypes = [
  "open_source", "listen_or_read", "share_with_person", "draft_message", "congratulate",
  "create_calendar_draft", "create_reminder_draft", "open_maps", "build_plan",
  "build_checklist", "invite_friend", "find_options", "start_small_experiment",
  "dismiss_with_reason",
] as const;

export const movePlanSchema = z.object({
  move_type: z.enum(moveTypes),
  title: z.string().max(160),
  steps: z.array(z.string().max(300)).min(1).max(8),
  external_effect: z.boolean(),
  final_user_action_required: z.literal(true),
  private_context_disclosed: z.literal(false),
}).strict();

export type ArtifactExtraction = z.infer<typeof artifactExtractionSchema>;
export type ImmediateResponse = z.infer<typeof immediateResponseSchema>;
export type MemoryUpdate = z.infer<typeof memoryUpdateSchema>;
export type PatternCandidate = z.infer<typeof patternCandidateSchema>;
export type RadarAssessment = z.infer<typeof radarAssessmentSchema>;
export type WebCitation = z.infer<typeof webCitationSchema>;
export type WebSearchResult = z.infer<typeof webSearchResultSchema>;
export type MovePlan = z.infer<typeof movePlanSchema>;
