import {
  collaborationRunRequestSchema,
  type CollaborationRunRequest,
} from "@co/contracts";

export type AwarenessProvider = "openai" | "anthropic";

export function awarenessProviderFromEnvironment(
  environment: Record<string, string | undefined>,
): AwarenessProvider | null {
  const provider = environment.CO_AWARENESS_PROVIDER;
  if (provider !== "openai" && provider !== "anthropic") return null;
  if (provider === "openai" && !environment.OPENAI_API_KEY) return null;
  if (provider === "anthropic" && !environment.ANTHROPIC_API_KEY) return null;
  if (!environment.MODEL_FAST || !environment.MODEL_REASONING) return null;
  return provider;
}

export function buildAwarenessCollaborationRequest(input: {
  userId: string;
  triggerEventId: string;
  contextEventIds: string[];
  signalIds: string[];
  provider: AwarenessProvider;
  fastModel: string;
  reasoningModel: string;
  evaluatedAt: string;
}): CollaborationRunRequest {
  const common = {
    provider: input.provider,
    timeout_ms: 120_000,
  };
  return collaborationRunRequestSchema.parse({
    tenant_id: input.userId,
    idempotency_key: `ambient-awareness:${input.triggerEventId}`,
    objective: [
      "Assess whether the bounded, time-specific evidence supports one useful observation",
      "that could help the user in the present context. Silence is a valid and preferred",
      "outcome when the evidence is weak, repetitive, intrusive, or merely motivational.",
      `The evaluation instant is ${input.evaluatedAt}; calendar evidence supplies its own timezone.`,
    ].join(" "),
    evidence_packet: {
      artifact_ids: [],
      segment_ids: [],
      signal_ids: input.signalIds,
      context_event_ids: input.contextEventIds,
    },
    agents: [
      {
        id: "temporal_reader",
        name: "Temporal context reader",
        objective: "Identify only concrete, cross-source relevance in the supplied evidence.",
        instructions: [
          "Treat older and newer durable signals equally; rank by relevance, confidence, and provenance.",
          "Distinguish the user's words from other people's or source claims.",
          "Do not turn calendar presence into an obligation or infer a life goal.",
          "Every finding must directly cite original evidence, not merely an agent result.",
        ].join(" "),
        model: { ...common, model: input.fastModel, max_output_tokens: 1_200, reasoning_effort: "medium" },
        depends_on: [],
      },
      {
        id: "interruption_critic",
        name: "Interruption and trust critic",
        objective: "Argue for silence unless an intervention is timely, specific, and evidence-backed.",
        instructions: [
          "Look for recency bias, sycophancy, repetition, surveillance creep, and unsupported personal claims.",
          "Reject generic encouragement, accountability language, and tasks the user did not request.",
          "Every finding must directly cite original evidence, not merely an agent result.",
        ].join(" "),
        model: { ...common, model: input.fastModel, max_output_tokens: 1_200, reasoning_effort: "medium" },
        depends_on: [],
      },
      {
        id: "synthesis",
        name: "Conservative synthesis",
        objective: "Produce at most one concise, optional, context-aware observation or produce no findings.",
        instructions: [
          "Resolve the two specialists conservatively. A finding must be specific enough to be useful now.",
          "Never issue an instruction, contact anyone, update memory, or claim certainty about the person.",
          "Write as a calm thought partner, not an accountability system.",
          "Every finding must cite at least one original context_event or signal ID directly.",
          "Use an empty findings array when silence is better.",
        ].join(" "),
        model: { ...common, model: input.reasoningModel, max_output_tokens: 1_600, reasoning_effort: "high" },
        depends_on: ["temporal_reader", "interruption_critic"],
      },
    ],
    synthesis_agent_id: "synthesis",
    token_budget: {
      max_input_tokens: 300_000,
      max_output_tokens: 5_000,
      max_total_tokens: 305_000,
    },
    max_concurrency: 2,
    max_retries_per_task: 1,
  });
}
