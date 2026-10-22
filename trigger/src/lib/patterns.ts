/** §13.3 / §23 candidate pre-filters as pure functions — applied BEFORE any model call. */
import type { EvidenceItem } from "@co/model-gateway";
import type { PatternCandidate } from "@co/contracts";

export const PATTERN_MIN_EVIDENCE = 3;
export const PATTERN_MIN_DAYS = 2;

export function eligibleEvidence(evidence: EvidenceItem[]): { eligible: boolean; reason?: string } {
  if (evidence.length < PATTERN_MIN_EVIDENCE) return { eligible: false, reason: "fewer than minimum evidence items" };
  const days = new Set(evidence.map((e) => (e.occurred_at ?? "undated").slice(0, 10)));
  if (days.size < PATTERN_MIN_DAYS) return { eligible: false, reason: "all evidence from the same day" };
  const sources = new Set(evidence.map((e) => e.source_type ?? "unknown"));
  if (sources.size === 1 && days.size === 1) return { eligible: false, reason: "all evidence from the same source and day" };
  return { eligible: true };
}

/** post-model filters: contradiction, sensitivity, confidence threshold (env-tunable). */
export function acceptCandidate(
  candidate: PatternCandidate,
  opts: { minConfidence?: number } = {},
): { accepted: boolean; reason?: string } {
  const minConfidence = opts.minConfidence ?? Number(process.env.PATTERN_MIN_CONFIDENCE ?? 0.5);
  if (candidate.contradicting_evidence_ids.length > 0) return { accepted: false, reason: "unresolved contradiction" };
  if (candidate.sensitivity === "high") return { accepted: false, reason: "sensitive inference" };
  if (candidate.confidence < minConfidence) return { accepted: false, reason: "below confidence threshold" };
  if (candidate.supporting_evidence_ids.length < PATTERN_MIN_EVIDENCE) return { accepted: false, reason: "insufficient receipts" };
  return { accepted: true };
}
