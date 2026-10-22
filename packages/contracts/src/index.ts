/**
 * co · shared contracts — the single source of truth for model outputs and cross-package types.
 * spec: goal.md §22.3 (schemas), §11 (source types), §15.5 (event ontology), §16 (moves).
 * every nontrivial model output MUST parse against these before it touches the db or a user.
 */
import { z } from "zod";

export * from "./primitives";                        // SourceType, Coverage
export * from "./transport";
// merged 2026-07-27: codex's contract modules. Both trees defined contracts the other lacked —
// mine are the model-output schemas (extraction, why, patterns, radar, moves), codex's are the
// API-surface and platform contracts (artifact, history, memory, phone-link, flags, analytics).
export * from "./analytics";
export * from "./artifact";
export * from "./flags";
export * from "./history";
export * from "./memory";
export * from "./model";
export * from "./phone-link";
export * from "./signals";
export * from "./collaboration";
export * from "./awareness";
export * from "./google-workspace";
export * from "./action";
export * from "./version";                         // ingest seam (docs/ingest-contract.md)

export const WorldEventType = z.enum(["launch","new_episode","new_post","new_article","new_paper","new_product","funding","job_change","event_announced","registration_opened","application_deadline","course_opened","release","interview","award","location_opened","other"]);
export type WorldEventType = z.infer<typeof WorldEventType>;

// MoveType moved to ./model 2026-07-29 (breaking an index<->model import cycle I created);
// re-exported below via export * from "./model" and imported here for MovePlan.
import { MoveType, movePlanSchema } from "./model";
export { MoveType };

// ---------- artifact extraction (§22.3) ----------
export const ArtifactExtraction = z.object({
  source_summary: z.string(),
  entities: z.array(z.string()),
  places: z.array(z.string()),
  products: z.array(z.string()),
  claims: z.array(z.string()),
  content_mood: z.string().nullable(),
  possible_user_intents: z.array(z.string()),
  media_access_confidence: z.number().min(0).max(1),
  // merged 2026-07-29: codex's structured shape adopted ({field, reason}) — richer, and its
  // processing suite depends on it. My string[] consumers updated same commit.
  uncertainties: z.array(z.object({ field: z.string(), reason: z.string() })),
});
export type ArtifactExtraction = z.infer<typeof ArtifactExtraction>;

// ---------- immediate response ----------
export const WhyQuestion = z.object({
  prompt: z.string(),
  options: z.array(z.string()).min(2).max(5),
});
export const ImmediateResponse = z.object({
  mode: z.enum(["understand","react","remember","move","quiet"]),
  response: z.string().max(600), // 1–3 sentences, hard max 80 words enforced upstream too
  why_question: WhyQuestion.nullable(),
  suggested_actions: z.array(z.object({ move_type: MoveType, title: z.string() })),
  confidence: z.number().min(0).max(1),
  should_wait_for_user: z.boolean(),
});
export type ImmediateResponse = z.infer<typeof ImmediateResponse>;

// ---------- memory update ----------
export const MemoryUpdate = z.object({
  observations_to_add: z.array(z.object({
    observation_type: z.string(),
    statement: z.string(),
    scope: z.string().nullable(),
    confidence: z.number().min(0).max(1),
  })),
  observations_to_invalidate: z.array(z.string().uuid()),
  thread_links: z.array(z.object({
    thread_title: z.string(),
    relationship: z.enum(["supports","contradicts","context"]),
    confidence: z.number().min(0).max(1),
  })),
  watch_suggestion: z.object({ display_name: z.string(), entity_type: z.string(), reason: z.string() }).nullable(),
  sensitivity_flags: z.array(z.string()),
  requires_user_confirmation: z.boolean(),
});
export type MemoryUpdate = z.infer<typeof MemoryUpdate>;

// ---------- pattern candidate ----------
export const PatternCandidate = z.object({
  statement: z.string(),
  supporting_evidence_ids: z.array(z.string().uuid()).min(3), // §13.3: minimum three moments
  contradicting_evidence_ids: z.array(z.string().uuid()),
  alternative_explanations: z.array(z.string()).min(1),       // no single-story verdicts
  confidence: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  actionability: z.number().min(0).max(1),
  sensitivity: z.enum(["low","medium","high"]),
  door_hypothesis: z.string().nullable(),
  why_now: z.string().nullable(),
});
export type PatternCandidate = z.infer<typeof PatternCandidate>;

// ---------- radar assessment ----------
export const RadarAssessment = z.object({
  event_type: WorldEventType,
  event_summary: z.string(),
  source_facts: z.array(z.string()),
  personal_relevance: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  timeliness: z.number().min(0).max(1),
  actionability: z.number().min(0).max(1),
  source_trust: z.number().min(0).max(1),
  creepiness_risk: z.number().min(0).max(1),
  why_user: z.string().min(1),                                // mandatory, references explicit evidence
  suggested_actions: z.array(z.object({ move_type: MoveType, title: z.string() })),
  send_recommendation: z.enum(["send","inbox_only","discard"]),
});
export type RadarAssessment = z.infer<typeof RadarAssessment>;

// ---------- move plan ----------
export const MovePlan = movePlanSchema;
export type MovePlan = z.infer<typeof MovePlan>;

// ---------- outcome update ----------
export const OutcomeUpdate = z.object({
  hypothesis_adjustments: z.array(z.object({
    hypothesis_id: z.string().uuid(),
    direction: z.enum(["strengthen","weaken","invalidate"]),
    reason: z.string(),
  })),
  standard_adjustments: z.array(z.object({ domain: z.string(), statement: z.string() })),
  followup_question: z.string().nullable(),     // select the minimum that resolves the hypothesis
});
export type OutcomeUpdate = z.infer<typeof OutcomeUpdate>;

// ---------- radar scoring weights (§15.6, interpretable) ----------
export const RADAR_WEIGHTS = {
  personal_fit: 0.30, novelty: 0.20, timeliness: 0.20,
  actionability: 0.15, source_trust: 0.10, social_obligation: 0.05,
} as const;

export function radarTotal(a: RadarAssessment, redundancyPenalty = 0, uncertaintyPenalty = 0): number {
  const base =
    RADAR_WEIGHTS.personal_fit * a.personal_relevance +
    RADAR_WEIGHTS.novelty * a.novelty +
    RADAR_WEIGHTS.timeliness * a.timeliness +
    RADAR_WEIGHTS.actionability * a.actionability +
    RADAR_WEIGHTS.source_trust * a.source_trust +
    RADAR_WEIGHTS.social_obligation * 0; // social_obligation scored separately when implemented
  return Math.max(0, base - a.creepiness_risk - redundancyPenalty - uncertaintyPenalty);
}

// ---------- content-free analytics event names (§29) ----------
export const PRODUCT_EVENTS = [
  "onboarding_started","first_capture_started","first_capture_completed","first_response_ready",
  "why_prompt_shown","why_submitted","quiet_save_selected","account_created","notifications_prompted",
  "notifications_granted","capture_created","capture_failed","capture_retried","thread_created",
  "pattern_candidate_created","pattern_reviewed","pattern_sent","pattern_feedback","watch_entity_added",
  "watch_entity_suggested","watch_entity_approved","radar_candidate_created","radar_sent","radar_feedback",
  "move_prepared","move_approved","move_completed","outcome_submitted","artifact_deleted",
  "export_requested","account_deleted","invite_sent",
] as const;
export type ProductEventName = (typeof PRODUCT_EVENTS)[number];  // renamed 2026-07-29: collided with codex's ProductEvent object type from ./analytics
