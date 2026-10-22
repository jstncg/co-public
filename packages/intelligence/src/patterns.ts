import { patternCandidateSchema, type PatternCandidate } from "@co/contracts";

export type PatternEvidence = { artifactId: string; capturedAt: string; direction: "support" | "contradict" | "context"; invalidated: boolean };

export function evaluatePatternDelivery(
  unknownCandidate: unknown,
  evidence: PatternEvidence[],
  review: { required: boolean; approved: boolean },
): { deliverable: boolean; reasons: string[]; candidate: PatternCandidate } {
  const candidate = patternCandidateSchema.parse(unknownCandidate);
  const reasons: string[] = [];
  const valid = evidence.filter((item) => !item.invalidated);
  const supporting = valid.filter((item) => item.direction === "support" && candidate.supporting_evidence_ids.includes(item.artifactId));
  const days = new Set(supporting.map((item) => item.capturedAt.slice(0, 10)));
  const unresolvedContradictions = valid.filter((item) => item.direction === "contradict");
  if (new Set(supporting.map((item) => item.artifactId)).size < 3) reasons.push("fewer_than_three_receipts");
  if (days.size < 2) reasons.push("evidence_does_not_span_two_days");
  if (unresolvedContradictions.length > 0) reasons.push("unresolved_contradiction");
  if (review.required && !review.approved) reasons.push("founder_review_missing");
  return { deliverable: reasons.length === 0, reasons, candidate };
}
