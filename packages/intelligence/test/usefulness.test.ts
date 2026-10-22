import { describe, expect, it } from "vitest";
import { signalCandidateSchema } from "@co/contracts";
import { routeSignalUsefulness } from "../src/usefulness";

const signal = (overrides: Record<string, unknown> = {}) => signalCandidateSchema.parse({
  signal_type: "source_claim",
  subject_relation: "source",
  statement: "A creator describes building a weekly studio practice.",
  confidence: 0.85,
  supporting_segment_keys: ["segment:1"],
  contradicting_segment_keys: [],
  uncertainty: null,
  sensitivity: "low",
  ...overrides,
});

const context = (overrides: Record<string, unknown> = {}) => ({
  explicitRequest: "none" as const,
  liveContextMatch: false,
  repeatedEvidenceCount: 1,
  explicitWatchRequest: false,
  consentState: "not_required" as const,
  sourceType: "youtube",
  evidenceAgeDays: 0,
  ...overrides,
});

describe("usefulness routing", () => {
  it("never promotes an ordinary source claim into personal memory", () => {
    expect(routeSignalUsefulness(signal(), context()).lane).toBe("hold");
  });

  it("makes repeated first-party preferences reviewed update candidates", () => {
    expect(routeSignalUsefulness(signal({
      signal_type: "preference",
      subject_relation: "user",
      statement: "I work better in rooms where other people are making things.",
    }), context({ repeatedEvidenceCount: 3 })).lane).toBe("update_candidate");
  });

  it("holds call evidence when consent is unknown", () => {
    expect(routeSignalUsefulness(signal({
      signal_type: "user_statement",
      subject_relation: "user",
    }), context({ sourceType: "call", consentState: "unknown", liveContextMatch: true })).lane).toBe("hold");
  });

  it("routes a first-party commitment to a draft, never execution", () => {
    const result = routeSignalUsefulness(signal({
      signal_type: "commitment",
      subject_relation: "user",
      statement: "I will ask Maya about the studio this week.",
    }), context({ sourceType: "conversation", consentState: "owner_supplied" }));
    expect(result).toMatchObject({ lane: "move_draft", requires_review: true });
  });

  it("does not change a candidate lane merely because the same evidence is newer", () => {
    const repeatedPreference = signal({
      signal_type: "preference",
      subject_relation: "user",
      statement: "I work better in rooms where other people are making things.",
    });
    const recent = routeSignalUsefulness(repeatedPreference, context({
      repeatedEvidenceCount: 3,
      evidenceAgeDays: 1,
    }));
    const old = routeSignalUsefulness(repeatedPreference, context({
      repeatedEvidenceCount: 3,
      evidenceAgeDays: 365,
    }));
    expect(old).toEqual(recent);
  });
});
