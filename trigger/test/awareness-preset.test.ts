import { describe, expect, it } from "vitest";
import {
  awarenessProviderFromEnvironment,
  buildAwarenessCollaborationRequest,
} from "../src/lib/awareness-preset";

const userId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";

describe("awareness collaboration preset", () => {
  it("fails closed when provider credentials or model routing are absent", () => {
    expect(awarenessProviderFromEnvironment({ CO_AWARENESS_PROVIDER: "openai" })).toBeNull();
    expect(awarenessProviderFromEnvironment({
      CO_AWARENESS_PROVIDER: "openai",
      OPENAI_API_KEY: "test",
      MODEL_FAST: "fast",
      MODEL_REASONING: "reasoning",
    })).toBe("openai");
  });

  it("builds a bounded, model-agnostic, proposal-only collaboration", () => {
    const request = buildAwarenessCollaborationRequest({
      userId,
      triggerEventId: eventId,
      contextEventIds: [eventId],
      signalIds: [],
      provider: "anthropic",
      fastModel: "fast-from-env",
      reasoningModel: "reasoning-from-env",
      evaluatedAt: "2026-07-30T19:00:00.000Z",
    });
    expect(request.agents.map((agent) => agent.model.model)).toEqual([
      "fast-from-env", "fast-from-env", "reasoning-from-env",
    ]);
    expect(request.max_concurrency).toBe(2);
    expect(request.agents[2]?.instructions).toContain("empty findings");
    expect(JSON.stringify(request)).not.toContain("send a message");
    expect(JSON.stringify(request)).not.toContain("Denn");
  });
});
