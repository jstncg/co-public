import { describe, expect, it } from "vitest";
import { canonicalEventKey, decideRadarDelivery, evaluatePatternDelivery, outcomeObservation, prepareMove, transitionMove, type PatternEvidence } from "../src/index";

const ids = [
  "0198c5d2-bfed-75e0-b7d1-8a89b7c04111",
  "0198c5d2-bfed-75e0-b7d1-8a89b7c04112",
  "0198c5d2-bfed-75e0-b7d1-8a89b7c04113",
];
const candidate = { statement: "creative rooms may increase follow-through", supporting_evidence_ids: ids, contradicting_evidence_ids: [], alternative_explanations: ["the projects themselves may have been unusually motivating"], confidence: 0.7, novelty: 0.8, actionability: 0.8, sensitivity: "low", door_hypothesis: "try a weekly maker room", why_now: null };

describe("pattern restraint", () => {
  it("requires three receipts across two days", () => {
    const evidence = ids.map((artifactId) => ({ artifactId, capturedAt: "2026-07-20T10:00:00Z", direction: "support" as const, invalidated: false }));
    expect(evaluatePatternDelivery(candidate, evidence, { required: false, approved: false }).reasons).toContain("evidence_does_not_span_two_days");
    evidence[2] = { ...evidence[2]!, capturedAt: "2026-07-21T10:00:00Z" };
    expect(evaluatePatternDelivery(candidate, evidence, { required: false, approved: false }).deliverable).toBe(true);
  });

  it("withholds on contradiction or missing consented review", () => {
    const evidence: PatternEvidence[] = ids.map((artifactId, index) => ({ artifactId, capturedAt: `2026-07-${20 + index}T10:00:00Z`, direction: "support", invalidated: false }));
    evidence.push({ artifactId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04114", capturedAt: "2026-07-22T10:00:00Z", direction: "contradict", invalidated: false });
    const result = evaluatePatternDelivery(candidate, evidence, { required: true, approved: false });
    expect(result.reasons).toEqual(expect.arrayContaining(["unresolved_contradiction", "founder_review_missing"]));
  });
});

describe("radar restraint", () => {
  const strong = { personalRelevance: 1, novelty: 1, timeliness: 1, actionability: 1, sourceTrust: 1, creepinessRisk: 0 };
  it("never delivers without an explicit active watch", () => {
    expect(decideRadarDelivery({ signals: strong, watchApproved: false, watchPaused: false, withinQuietHours: false, notificationsSentThisWeek: 0, weeklyCap: 2 }).decision).toBe("discard");
  });
  it("respects quiet hours and weekly caps", () => {
    expect(decideRadarDelivery({ signals: strong, watchApproved: true, watchPaused: false, withinQuietHours: true, notificationsSentThisWeek: 0, weeklyCap: 2 }).decision).toBe("inbox_only");
    expect(decideRadarDelivery({ signals: strong, watchApproved: true, watchPaused: false, withinQuietHours: false, notificationsSentThisWeek: 2, weeklyCap: 2 }).decision).toBe("inbox_only");
  });
  it("deduplicates tracking-decorated canonical URLs", () => {
    const a = canonicalEventKey({ url: "https://example.com/apply?utm_source=x", eventType: "application_open", publishedAt: "2026-07-20T00:00:00Z" });
    const b = canonicalEventKey({ url: "https://example.com/apply", eventType: "application_open", publishedAt: "2026-07-20T15:00:00Z" });
    expect(a).toBe(b);
  });
});

describe("moves stay drafts until the person acts", () => {
  const move = { move_type: "draft_message", title: "Ask to visit", steps: ["Draft a note", "Open the share sheet"], external_effect: true, final_user_action_required: true, private_context_disclosed: false };
  it("blocks approval without final user confirmation", () => {
    expect(prepareMove(move).final_user_action_required).toBe(true);
    expect(() => transitionMove("prepared", "approved", false)).toThrow("confirmation");
  });
  it("turns completed outcomes into scoped evidence", () => {
    expect(outcomeObservation({ moveState: "completed", result: "The visit created a useful collaboration", valueRating: 5, repeatIntent: "yes" }).scope).toContain("these conditions");
  });
});
