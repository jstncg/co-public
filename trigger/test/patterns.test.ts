import { test } from "node:test";
import assert from "node:assert/strict";
import { eligibleEvidence, acceptCandidate } from "../src/lib/patterns";
import type { EvidenceItem } from "@co/model-gateway";
import type { PatternCandidate } from "@co/contracts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ev = (n: number, day: string): EvidenceItem => ({ id: uuid(n), kind: "artifact", statement: `moment ${n}`, occurred_at: day, source_type: "social_post" });

const candidate: PatternCandidate = {
  statement: "the repeated element may be small-group making",
  supporting_evidence_ids: [uuid(1), uuid(2), uuid(3)],
  contradicting_evidence_ids: [],
  alternative_explanations: ["could be the people"],
  confidence: 0.6,
  novelty: 0.5,
  actionability: 0.6,
  sensitivity: "low",
  door_hypothesis: null,
  why_now: null,
};

test("eligibleEvidence enforces §13.3 minimums", () => {
  assert.equal(eligibleEvidence([ev(1, "2026-06-01"), ev(2, "2026-06-02")]).eligible, false);
  assert.equal(eligibleEvidence([ev(1, "2026-06-01"), ev(2, "2026-06-01"), ev(3, "2026-06-01")]).eligible, false);
  assert.equal(eligibleEvidence([ev(1, "2026-06-01"), ev(2, "2026-06-02"), ev(3, "2026-06-05")]).eligible, true);
});

test("acceptCandidate rejects contradiction, high sensitivity, low confidence", () => {
  assert.equal(acceptCandidate(candidate, { minConfidence: 0.5 }).accepted, true);
  assert.equal(acceptCandidate({ ...candidate, contradicting_evidence_ids: [uuid(9)] }, { minConfidence: 0.5 }).accepted, false);
  assert.equal(acceptCandidate({ ...candidate, sensitivity: "high" }, { minConfidence: 0.5 }).accepted, false);
  assert.equal(acceptCandidate({ ...candidate, confidence: 0.3 }, { minConfidence: 0.5 }).accepted, false);
});
