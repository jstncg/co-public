import {
  usefulnessCandidateSchema,
  type ConsentState,
  type SignalCandidate,
  type UsefulnessCandidate,
} from "@co/contracts";

export type UsefulnessContext = {
  explicitRequest: "summary" | "react" | "save" | "none";
  liveContextMatch: boolean;
  repeatedEvidenceCount: number;
  explicitWatchRequest: boolean;
  consentState: ConsentState;
  sourceType: string;
  /** Audit input only: v1 routing must not prefer evidence merely because it is recent. */
  evidenceAgeDays: number;
};

function proposal(
  signal: SignalCandidate,
  lane: UsefulnessCandidate["lane"],
  reason: string,
  scores: { relevance: number; novelty: number; actionability: number },
): UsefulnessCandidate {
  return usefulnessCandidateSchema.parse({
    lane,
    reason,
    supporting_segment_keys: signal.supporting_segment_keys,
    ...scores,
    requires_review: true,
    not_before: null,
  });
}

export function routeSignalUsefulness(signal: SignalCandidate, context: UsefulnessContext): UsefulnessCandidate {
  const base = {
    relevance: Math.min(1, signal.confidence),
    novelty: context.repeatedEvidenceCount > 1 ? 0.35 : 0.7,
    actionability: 0.2,
  };
  const callLike = ["call", "meeting", "conversation"].includes(context.sourceType);
  if (
    signal.sensitivity === "high" ||
    signal.confidence < 0.55 ||
    signal.supporting_segment_keys.length === 0 ||
    (callLike && context.consentState === "unknown")
  ) {
    return proposal(signal, "hold", "Evidence is sensitive, weakly supported, or lacks a clear consent boundary.", {
      ...base, actionability: 0,
    });
  }

  if (context.explicitRequest !== "none" && ["question", "source_claim", "moment"].includes(signal.signal_type)) {
    return proposal(signal, "reply_now", "This evidence can directly serve the user's explicit request.", {
      ...base, relevance: 1, actionability: 0.5,
    });
  }

  if (signal.signal_type === "commitment" && signal.subject_relation === "user") {
    return proposal(signal, "move_draft", "A first-party commitment may support one reversible draft; the user still takes the final action.", {
      ...base, relevance: 0.9, actionability: 0.85,
    });
  }

  if (context.explicitWatchRequest && signal.signal_type === "entity") {
    return proposal(signal, "watch_candidate", "The user explicitly asked to keep watch on an evidenced entity.", {
      ...base, relevance: 0.9, actionability: 0.7,
    });
  }

  if (
    signal.subject_relation === "user" &&
    ["user_statement", "preference"].includes(signal.signal_type) &&
    context.repeatedEvidenceCount >= 2
  ) {
    return proposal(signal, "update_candidate", "Repeated first-party evidence may merit a reviewed memory update.", {
      ...base, relevance: 0.85, novelty: 0.4, actionability: 0.55,
    });
  }

  if (context.liveContextMatch) {
    return proposal(signal, "return_later", "The evidence connects to an active context, but is not urgent enough to interrupt now.", {
      ...base, relevance: 0.75, actionability: 0.45,
    });
  }

  return proposal(signal, "hold", "The evidence is preserved, but there is not yet a timely or sufficiently personal use.", base);
}
