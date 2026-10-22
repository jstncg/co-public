import type {
  ContextEventKind,
  ContextSourceKind,
  HarnessAgentOutput,
} from "@co/contracts";

export type AwarenessEvidence = {
  evidenceType: "context_event" | "signal";
  id: string;
  text: string;
  sourceKind: ContextSourceKind | "memory";
  occurredAt: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  eventKind: ContextEventKind | null;
  analysisAllowed: boolean;
  sensitivity: "unknown" | "low" | "medium" | "high";
  confidence: number;
  subjectRelation: "source" | "user" | "other_person" | "unknown" | null;
};

export type TemporalContextSnapshot = {
  trigger: AwarenessEvidence;
  contextEventIds: string[];
  signalIds: string[];
  sourceKinds: ContextSourceKind[];
  reasonCodes: string[];
  relevantEvidenceCount: number;
};

export type AwarenessDecisionResult = {
  decision: "record_only" | "defer" | "collaborate" | "hold";
  reason: string;
  nextEvaluationAt: Date | null;
};

const STOPWORDS = new Set([
  "about", "after", "again", "because", "before", "being", "calendar", "event",
  "from", "have", "into", "just", "that", "their", "then", "there", "these",
  "they", "this", "through", "want", "what", "when", "where", "which", "with",
  "would", "your",
]);

function terms(text: string) {
  return new Set(
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu)
      ?.filter((term) => !STOPWORDS.has(term))
      .slice(0, 200) ?? [],
  );
}

function lexicalOverlap(left: Set<string>, rightText: string) {
  const right = terms(rightText);
  let overlap = 0;
  for (const term of right) if (left.has(term)) overlap += 1;
  return overlap;
}

function intersectsWindow(
  evidence: AwarenessEvidence,
  windowStartMs: number,
  windowEndMs: number,
) {
  const start = Date.parse(evidence.effectiveFrom ?? evidence.occurredAt);
  const end = Date.parse(evidence.effectiveTo ?? evidence.effectiveFrom ?? evidence.occurredAt);
  return Number.isFinite(start) && Number.isFinite(end) && start <= windowEndMs && end >= windowStartMs;
}

/**
 * Selects a small task-specific packet. Temporal records use an explicit
 * event window; durable signals use semantic overlap and confidence, never age.
 */
export function assembleTemporalContext(input: {
  trigger: AwarenessEvidence;
  candidates: AwarenessEvidence[];
  now: Date;
  pastWindowMs?: number;
  futureWindowMs?: number;
  maxContextEvents?: number;
  maxSignals?: number;
}): TemporalContextSnapshot {
  const pastWindowMs = input.pastWindowMs ?? 48 * 60 * 60 * 1_000;
  const futureWindowMs = input.futureWindowMs ?? 14 * 24 * 60 * 60 * 1_000;
  const maxContextEvents = input.maxContextEvents ?? 24;
  const maxSignals = input.maxSignals ?? 16;
  const nowMs = input.now.getTime();
  const triggerTerms = terms(input.trigger.text);

  const eventCandidates = input.candidates
    .filter((candidate) =>
      candidate.evidenceType === "context_event" &&
      candidate.id !== input.trigger.id &&
      candidate.analysisAllowed &&
      candidate.sensitivity !== "high" &&
      intersectsWindow(candidate, nowMs - pastWindowMs, nowMs + futureWindowMs)
    )
    .map((candidate) => {
      const overlap = lexicalOverlap(triggerTerms, candidate.text);
      const crossSource = candidate.sourceKind !== input.trigger.sourceKind ? 1 : 0;
      const activeNow = intersectsWindow(candidate, nowMs, nowMs) ? 1 : 0;
      const startsAt = Date.parse(candidate.effectiveFrom ?? candidate.occurredAt);
      const startsSoon = candidate.sourceKind === "calendar" &&
        Number.isFinite(startsAt) &&
        startsAt >= nowMs - 30 * 60 * 1_000 &&
        startsAt <= nowMs + 4 * 60 * 60 * 1_000 ? 1 : 0;
      return {
        candidate,
        relevant: overlap > 0 || (crossSource === 1 && (activeNow === 1 || startsSoon === 1)),
        score: overlap * 4 + crossSource * 2 + activeNow * 2 + startsSoon,
      };
    })
    .filter(({ relevant }) => relevant)
    .sort((left, right) =>
      right.score - left.score ||
      left.candidate.id.localeCompare(right.candidate.id)
    )
    .slice(0, maxContextEvents)
    .map(({ candidate }) => candidate);

  const signalCandidates = input.candidates
    .filter((candidate) =>
      candidate.evidenceType === "signal" &&
      candidate.analysisAllowed &&
      candidate.sensitivity !== "high"
    )
    .map((candidate) => {
      const overlap = lexicalOverlap(triggerTerms, candidate.text);
      const firstParty = candidate.subjectRelation === "user" ? 1 : 0;
      // Deliberately no occurredAt/age term: old evidence competes on the same
      // relevance and confidence basis as new evidence.
      return { candidate, overlap, score: overlap * 4 + firstParty * 2 + candidate.confidence };
    })
    .filter(({ overlap }) => overlap > 0)
    .sort((left, right) =>
      right.score - left.score ||
      left.candidate.id.localeCompare(right.candidate.id)
    )
    .slice(0, maxSignals)
    .map(({ candidate }) => candidate);

  const contextEvents = [input.trigger, ...eventCandidates];
  const sourceKinds = [...new Set(
    contextEvents.map((evidence) => evidence.sourceKind)
      .filter((source): source is ContextSourceKind => source !== "memory"),
  )];
  const reasonCodes = [
    "trigger_included",
    ...(eventCandidates.length > 0 ? ["temporal_neighbors"] : []),
    ...(signalCandidates.length > 0 ? ["cross_time_signal_match"] : []),
    ...(sourceKinds.length > 1 ? ["cross_source_context"] : []),
  ];
  return {
    trigger: input.trigger,
    contextEventIds: contextEvents.map((evidence) => evidence.id),
    signalIds: signalCandidates.map((evidence) => evidence.id),
    sourceKinds,
    reasonCodes,
    relevantEvidenceCount: eventCandidates.length + signalCandidates.length,
  };
}

export function decideAwareness(input: {
  snapshot: TemporalContextSnapshot;
  now: Date;
  lastCollaborationAt: Date | null;
  cooldownMs?: number;
}): AwarenessDecisionResult {
  const trigger = input.snapshot.trigger;
  if (!trigger.analysisAllowed) return { decision: "hold" as const, reason: "analysis_not_allowed", nextEvaluationAt: null };
  if (trigger.sensitivity === "high") return { decision: "hold" as const, reason: "high_sensitivity", nextEvaluationAt: null };
  if (
    trigger.eventKind === "message_sent" ||
    trigger.eventKind === "calendar_deleted" ||
    trigger.eventKind === "email_deleted"
  ) {
    return { decision: "record_only" as const, reason: "non_user_or_deletion_event", nextEvaluationAt: null };
  }
  const triggerStartMs = Date.parse(trigger.effectiveFrom ?? trigger.occurredAt);
  if (
    trigger.eventKind === "calendar_changed" &&
    triggerStartMs > input.now.getTime() + 48 * 60 * 60 * 1_000
  ) {
    return {
      decision: "record_only" as const,
      reason: "calendar_window_not_open",
      nextEvaluationAt: null,
    };
  }
  if (input.snapshot.relevantEvidenceCount === 0 || input.snapshot.sourceKinds.length < 2) {
    return { decision: "record_only" as const, reason: "no_cross_source_relevance", nextEvaluationAt: null };
  }
  const cooldownMs = input.cooldownMs ?? 15 * 60 * 1_000;
  if (input.lastCollaborationAt && input.now.getTime() - input.lastCollaborationAt.getTime() < cooldownMs) {
    return {
      decision: "record_only" as const,
      reason: "collaboration_cooldown",
      nextEvaluationAt: null,
    };
  }
  return { decision: "collaborate" as const, reason: "cross_source_relevance", nextEvaluationAt: null };
}

export function candidateFromSynthesis(output: HarnessAgentOutput, minimumConfidence = 0.75) {
  const findings = output.findings.filter((finding) =>
    finding.confidence >= minimumConfidence &&
    finding.citations.some((citation) => citation.evidence_type !== "agent_result")
  );
  if (findings.length === 0) return null;
  const selected = findings.slice(0, 3);
  return {
    proposedCopy: selected.map((finding) => finding.statement).join(" ").slice(0, 2_000),
    confidence: Math.min(...selected.map((finding) => finding.confidence)),
    citations: [...new Set(selected.flatMap((finding) =>
      finding.citations
        .filter((citation) => citation.evidence_type !== "agent_result")
        .map((citation) => citation.evidence_id)
    ))],
  };
}
