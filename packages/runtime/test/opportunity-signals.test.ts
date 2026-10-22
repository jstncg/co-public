import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import type { JsonObject, ProviderAdapter } from "../src/types.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { testConfig, testHome } from "./helpers.ts";

type SignalKind = "expiry" | "coincidence" | "person_event" | "cross_domain_pattern" | "business_opportunity";

function providerFor(kind: SignalKind, invalid?: "one-evidence" | "past-deadline"): ProviderAdapter {
  return {
    name: "openai-compatible",
    complete: async (request) => {
      assert.equal(request.tools.length, 0);
      const prompt = request.messages.flatMap((message) => message.parts.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n");
      assert.match(prompt, /Silence is the default/);
      const allowedMatch = prompt.match(/ALLOWED EVIDENCE IDS: (\[[^\n]+\])/);
      const allowed = allowedMatch ? JSON.parse(allowedMatch[1] as string) as string[] : [];
      const needsSeveral = kind === "coincidence" || kind === "cross_domain_pattern" || kind === "business_opportunity";
      const evidenceEventIds = invalid === "one-evidence" || !needsSeveral ? allowed.slice(0, 1) : allowed.slice(0, 2);
      return {
        text: JSON.stringify({
          useful: true, signalKind: kind, topicKey: `fixture-${kind}`,
          reply: `A specific ${kind.replaceAll("_", " ")} changed what is available now.`, evidenceEventIds,
          deadlineAt: kind === "expiry" ? new Date(Date.now() + (invalid === "past-deadline" ? -1 : 2) * 86_400_000).toISOString() : null,
          entity: kind === "person_event" ? "Relevant founder dinner" : null,
          changedImplication: `The ${kind.replaceAll("_", " ")} creates a concrete option that did not exist in the member's prior plan.`,
          novelty: 0.92, urgency: kind === "expiry" ? 0.95 : 0.7, usefulness: 0.93,
          actionability: 0.85, confidence: 0.9, interruptionCost: 0.08,
        }),
        toolCalls: [], usage: { inputTokens: 100, outputTokens: 60, reasoningTokens: 0 },
      };
    },
  };
}

async function scan(kind: SignalKind, invalid?: "one-evidence" | "past-deadline", relatedTrust: "owner" | "agent" = "owner"): Promise<JsonObject | undefined> {
  const home = testHome();
  const config = testConfig(home.path);
  config.models.background = { ...config.models.background, provider: "openai-compatible", model: "fixture" };
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([providerFor(kind, invalid)]) });
  try {
    const marker = `signal-${kind}`;
    const prior = runtime.store.appendEvent({
      tenantId: "test", stream: "conversation", type: "message.received", at: "2026-06-01T00:00:00.000Z",
      payload: { text: `${marker} appeared in an earlier product conversation` },
    });
    runtime.store.indexEvidence({
      tenantId: "test", sourceEventId: prior.id, kind: relatedTrust === "owner" ? "conversation.user" : "conversation.assistant", trustClass: relatedTrust,
      content: `${marker} appeared in an earlier product conversation`, observedAt: prior.at,
    });
    const current = runtime.store.appendEvent({
      tenantId: "test", stream: "calendar:fixture", type: "calendar.changed",
      payload: { marker, detail: "A newly observed outside-world change with exact timing and provenance." },
    });
    runtime.store.enqueueJob("test", "ambient.evaluate", { eventId: current.id }, { idempotencyKey: `scan:${kind}:${invalid ?? "valid"}` });
    assert.equal(await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce(), true);
    const assessed = runtime.store.listEvents("test", { type: "ambient.usefulness_assessed" })[0];
    return assessed?.payload as JsonObject | undefined;
  } finally {
    runtime.close();
    home.cleanup();
  }
}

test("unknown-unknown scanning recognizes every product signal class with bounded evidence", async () => {
  for (const kind of ["expiry", "coincidence", "person_event", "cross_domain_pattern", "business_opportunity"] as const) {
    const result = await scan(kind);
    assert.equal(result?.signalKind, kind);
    assert.equal(Array.isArray(result?.evidenceEventIds), true);
    assert.equal(typeof result?.changedImplication, "string");
  }
});

test("unknown-unknown scanning rejects unsupported multi-source and expired claims before attention", async () => {
  assert.equal(await scan("coincidence", "one-evidence"), undefined);
  assert.equal(await scan("cross_domain_pattern", "one-evidence"), undefined);
  assert.equal(await scan("business_opportunity", "one-evidence"), undefined);
  assert.equal(await scan("expiry", "past-deadline"), undefined);
  assert.equal(await scan("cross_domain_pattern", undefined, "agent"), undefined, "prior assistant prose cannot launder itself into independent support");
});
