import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assembleTemporalContext,
  candidateFromSynthesis,
  decideAwareness,
  type AwarenessEvidence,
} from "../src/index";

const now = new Date("2026-07-30T19:00:00Z");

function evidence(overrides: Partial<AwarenessEvidence> = {}): AwarenessEvidence {
  return {
    evidenceType: "context_event",
    id: randomUUID(),
    text: "Discuss the launch preparation.",
    sourceKind: "messaging",
    occurredAt: now.toISOString(),
    effectiveFrom: null,
    effectiveTo: null,
    eventKind: "message_received",
    analysisAllowed: true,
    sensitivity: "low",
    confidence: 1,
    subjectRelation: null,
    ...overrides,
  };
}

describe("ambient awareness", () => {
  it("assembles cross-source temporal context and durable matching signals", () => {
    const trigger = evidence();
    const calendar = evidence({
      sourceKind: "calendar",
      eventKind: "calendar_window_opening",
      text: "Launch preparation meeting.",
      effectiveFrom: "2026-07-31T18:00:00Z",
      effectiveTo: "2026-07-31T19:00:00Z",
    });
    const signal = evidence({
      evidenceType: "signal",
      sourceKind: "memory",
      eventKind: null,
      text: "The user committed to prepare the launch.",
      occurredAt: "2025-07-30T19:00:00Z",
      subjectRelation: "user",
      confidence: 0.9,
    });
    const snapshot = assembleTemporalContext({ trigger, candidates: [calendar, signal], now });
    expect(snapshot.contextEventIds).toEqual([trigger.id, calendar.id]);
    expect(snapshot.signalIds).toEqual([signal.id]);
    expect(snapshot.sourceKinds).toEqual(["messaging", "calendar"]);
    expect(decideAwareness({ snapshot, now, lastCollaborationAt: null }).decision).toBe("collaborate");
  });

  it("does not give a newer durable signal a ranking advantage", () => {
    const trigger = evidence({ text: "Vocabulary practice before the presentation." });
    const old = evidence({
      evidenceType: "signal",
      id: "11111111-1111-4111-8111-111111111111",
      sourceKind: "memory",
      eventKind: null,
      text: "Vocabulary practice matters for presentations.",
      occurredAt: "2025-07-30T19:00:00Z",
      subjectRelation: "user",
      confidence: 0.9,
    });
    const recent = { ...old, id: "22222222-2222-4222-8222-222222222222", occurredAt: "2026-07-29T19:00:00Z" };
    const first = assembleTemporalContext({ trigger, candidates: [old, recent], now });
    const second = assembleTemporalContext({ trigger, candidates: [recent, old], now });
    expect(first.signalIds).toEqual([old.id, recent.id]);
    expect(second.signalIds).toEqual(first.signalIds);
  });

  it("does not treat an unrelated future calendar item as cross-source relevance", () => {
    const trigger = evidence({ text: "I liked the book recommendation." });
    const unrelated = evidence({
      sourceKind: "calendar",
      eventKind: "calendar_window_opening",
      text: "Calendar availability: busy. Product review.",
      effectiveFrom: "2026-08-05T18:00:00Z",
      effectiveTo: "2026-08-05T19:00:00Z",
    });
    const snapshot = assembleTemporalContext({ trigger, candidates: [unrelated], now });
    expect(snapshot.contextEventIds).toEqual([trigger.id]);
    expect(decideAwareness({ snapshot, now, lastCollaborationAt: null }))
      .toMatchObject({ decision: "record_only", reason: "no_cross_source_relevance" });
  });

  it("does not make every calendar window collaborate with an unrelated recent message", () => {
    const calendarTrigger = evidence({
      sourceKind: "calendar",
      eventKind: "calendar_window_opening",
      text: "Calendar availability: busy. Product review.",
      effectiveFrom: "2026-07-31T18:00:00Z",
      effectiveTo: "2026-07-31T19:00:00Z",
    });
    const unrelatedMessage = evidence({
      text: "I liked the book recommendation.",
      occurredAt: "2026-07-30T18:30:00Z",
    });
    const snapshot = assembleTemporalContext({
      trigger: calendarTrigger,
      candidates: [unrelatedMessage],
      now,
    });
    expect(snapshot.contextEventIds).toEqual([calendarTrigger.id]);
    expect(decideAwareness({ snapshot, now, lastCollaborationAt: null }))
      .toMatchObject({ decision: "record_only", reason: "no_cross_source_relevance" });
  });

  it("records outbound messages, holds sensitive evidence, and cooldown-skips model work", () => {
    const outbound = assembleTemporalContext({
      trigger: evidence({ eventKind: "message_sent" }),
      candidates: [],
      now,
    });
    expect(decideAwareness({ snapshot: outbound, now, lastCollaborationAt: null }).decision).toBe("record_only");

    const sensitive = assembleTemporalContext({
      trigger: evidence({ sensitivity: "high" }),
      candidates: [],
      now,
    });
    expect(decideAwareness({ snapshot: sensitive, now, lastCollaborationAt: null }).decision).toBe("hold");

    const trigger = evidence();
    const calendar = evidence({
      sourceKind: "calendar",
      eventKind: "calendar_window_opening",
      effectiveFrom: now.toISOString(),
    });
    const crossSource = assembleTemporalContext({ trigger, candidates: [calendar], now });
    expect(decideAwareness({
      snapshot: crossSource,
      now,
      lastCollaborationAt: new Date(now.getTime() - 60_000),
    })).toMatchObject({ decision: "record_only", reason: "collaboration_cooldown" });
  });

  it("creates a candidate only from sufficiently confident cited findings", () => {
    const citation = randomUUID();
    expect(candidateFromSynthesis({
      summary: "Synthesis.",
      findings: [{
        statement: "Prepare the cited meeting note.",
        confidence: 0.8,
        citations: [{ evidence_type: "context_event", evidence_id: citation }],
      }],
      disagreements: [],
      proposed_next_tasks: [],
    })).toEqual({
      proposedCopy: "Prepare the cited meeting note.",
      confidence: 0.8,
      citations: [citation],
    });
    expect(candidateFromSynthesis({
      summary: "Weak.",
      findings: [{
        statement: "Maybe.",
        confidence: 0.4,
        citations: [{ evidence_type: "context_event", evidence_id: citation }],
      }],
      disagreements: [],
      proposed_next_tasks: [],
    })).toBeNull();
    expect(candidateFromSynthesis({
      summary: "Dependency only.",
      findings: [{
        statement: "Unsupported by original evidence.",
        confidence: 0.9,
        citations: [{ evidence_type: "agent_result", evidence_id: citation }],
      }],
      disagreements: [],
      proposed_next_tasks: [],
    })).toBeNull();
  });
});
