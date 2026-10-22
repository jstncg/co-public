import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { AttentionGate } from "../src/attention.ts";
import type { ProviderAdapter } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

const route = { provider: "openai-compatible" as const, model: "semantic-fixture", maxOutputTokens: 512, reasoningEffort: "none" as const };

function text(request: Parameters<ProviderAdapter["complete"]>[0]): string {
  return request.messages.flatMap((message) => message.parts.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n");
}

test("optional foreground paraphrases are citation-suppressed while explicit requests add no verifier call", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.models = { foreground: route, deliberation: route, background: route, critic: route };
  let priorEventId = "";
  let foregroundCalls = 0;
  let verifierCalls = 0;
  const adapter: ProviderAdapter = {
    name: "openai-compatible",
    complete: async (request) => {
      if (request.system.includes("semantic knownness verifier")) {
        verifierCalls += 1;
        assert.match(text(request), new RegExp(priorEventId));
        return {
          text: JSON.stringify({ relation: "restatement", matchedEventId: priorEventId, reason: "The candidate repeats the owner's conclusion using different words." }),
          toolCalls: [], usage: { inputTokens: 5, outputTokens: 5, reasoningTokens: 0 },
        };
      }
      foregroundCalls += 1;
      return {
        text: "Status and outside approval are not what give the work its energy.",
        toolCalls: [], usage: { inputTokens: 5, outputTokens: 5, reasoningTokens: 0 },
      };
    },
  };
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([adapter]) });
  try {
    const prior = runtime.store.appendEvent({
      tenantId: "test", stream: "session:prior", type: "message.received",
      payload: { text: "I come alive when I originate the premise myself, regardless of prestige." },
    });
    priorEventId = prior.id;
    runtime.store.indexEvidence({
      tenantId: "test", sourceEventId: prior.id, kind: "conversation.user", trustClass: "owner",
      content: "I come alive when I originate the premise myself, regardless of prestige.", observedAt: prior.at,
    });
    const optional = await runtime.turn({ tenantId: "test", channel: "imessage", peerId: "member", text: "Dropping another note here." });
    assert.equal(optional.text, "");
    assert.equal(verifierCalls, 1);
    const check = runtime.store.listEvents("test", { type: "knownness.semantic_checked" })[0];
    assert.equal((check!.payload as { matchedEventId?: string }).matchedEventId, prior.id);

    const requested = await runtime.turn({ tenantId: "test", channel: "imessage", peerId: "member", text: "What did I conclude about this work?" });
    assert.match(requested.text, /outside approval/);
    assert.equal(foregroundCalls, 2);
    assert.equal(verifierCalls, 1, "an explicit request must not pay for or be swallowed by semantic knownness");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a failed foreground verifier leaves uncertainty and fails optional prose closed", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.models = { foreground: route, deliberation: route, background: route, critic: route };
  let calls = 0;
  const adapter: ProviderAdapter = {
    name: "openai-compatible",
    complete: async (request) => {
      calls += 1;
      if (request.system.includes("semantic knownness verifier")) throw new Error("fixture outage");
      return { text: "A differently worded optional observation.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([adapter]) });
  try {
    const prior = runtime.store.appendEvent({ tenantId: "test", stream: "prior", type: "message.received", payload: { text: "A prior owner statement with unrelated vocabulary." } });
    runtime.store.indexEvidence({ tenantId: "test", sourceEventId: prior.id, kind: "conversation.user", trustClass: "owner", content: "A prior owner statement with unrelated vocabulary.", observedAt: prior.at });
    const result = await runtime.turn({ tenantId: "test", channel: "imessage", peerId: "member", text: "Just noting today." });
    assert.equal(result.text, "");
    assert.equal(calls, 2);
    const check = runtime.store.listEvents("test", { type: "knownness.semantic_checked" })[0];
    assert.equal((check!.payload as { status?: string }).status, "uncertain");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("ambient operational paraphrases are suppressed and weak candidates never invoke the verifier", async () => {
  for (const weak of [false, true]) {
    const home = testHome();
    const config = testConfig(home.path);
    config.models = { foreground: route, deliberation: route, background: route, critic: route };
    let priorEventId = "";
    let verifierCalls = 0;
    const adapter: ProviderAdapter = {
      name: "openai-compatible",
      complete: async (request) => {
        if (request.system.includes("semantic knownness verifier")) {
          verifierCalls += 1;
          return {
            text: JSON.stringify({ relation: "restatement", matchedEventId: priorEventId, reason: "The deadline and completed preparation were already stated by the owner." }),
            toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
          };
        }
        const allowed = JSON.parse(text(request).match(/ALLOWED EVIDENCE IDS: (\[[^\n]+\])/)?.[1] ?? "[]") as string[];
        return {
          text: JSON.stringify({
            useful: true, signalKind: "expiry", topicKey: "parcel-cutoff",
            reply: "The merchant cutoff is tomorrow, but the handoff has already been arranged.", evidenceEventIds: allowed,
            deadlineAt: new Date(Date.now() + 86_400_000).toISOString(), entity: null,
            changedImplication: "The parcel handoff has already been arranged before the merchant cutoff.",
            novelty: weak ? 0.1 : 0.92, urgency: weak ? 0.1 : 0.9, usefulness: weak ? 0.1 : 0.95,
            actionability: weak ? 0.1 : 0.9, confidence: weak ? 0.4 : 0.95, interruptionCost: 0.05,
          }),
          toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
        };
      },
    };
    const runtime = new CoRuntime({ config, providers: new ProviderRegistry([adapter]) });
    try {
      const prior = runtime.store.appendEvent({
        tenantId: "test", stream: "conversation", type: "message.received", at: "2026-09-01T00:00:00.000Z",
        payload: { text: "parcel-cutoff: I already scheduled the return dropoff before Friday." },
      });
      priorEventId = prior.id;
      runtime.store.indexEvidence({ tenantId: "test", sourceEventId: prior.id, kind: "conversation.user", trustClass: "owner", content: "parcel-cutoff: I already scheduled the return dropoff before Friday.", observedAt: prior.at });
      const current = runtime.store.appendEvent({ tenantId: "test", stream: "calendar", type: "calendar.changed", payload: { marker: "parcel-cutoff", deadline: "tomorrow" } });
      runtime.store.enqueueJob("test", "ambient.evaluate", { eventId: current.id });
      assert.equal(await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce(), true);
      assert.equal(verifierCalls, weak ? 0 : 1);
      const intervention = runtime.store.db.prepare("SELECT decision FROM interventions WHERE tenant_id='test'").get() as { decision: string };
      assert.equal(intervention.decision, "silence");
      assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM attention_items WHERE tenant_id='test'").get()!.count, 0);
    } finally {
      runtime.close();
      home.cleanup();
    }
  }
});

test("enriched media paraphrases are semantically checked against the exact owner note", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.models = { foreground: route, deliberation: route, background: route, critic: route };
  let ownerEventId = "";
  let verifierCalls = 0;
  const adapter: ProviderAdapter = {
    name: "openai-compatible",
    complete: async (request) => {
      if (request.system.includes("semantic knownness verifier")) {
        verifierCalls += 1;
        assert.match(text(request), new RegExp(ownerEventId));
        return {
          text: JSON.stringify({ relation: "restatement", matchedEventId: ownerEventId, reason: "The owner already supplied the same practical conclusion." }),
          toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
        };
      }
      return {
        text: JSON.stringify({
          useful: true, topicKey: "source-conclusion", reply: "Prestige does not create momentum; originating the premise does.",
          evidence: 2, novelty: 0.9, urgency: 0.7, usefulness: 0.95, actionability: 0.7, confidence: 0.95, interruptionCost: 0.05,
        }),
        toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      };
    },
  };
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([adapter]) });
  try {
    const url = "https://example.com/source";
    const owner = runtime.store.appendEvent({ tenantId: "test", stream: "conversation", type: "message.received", payload: { text: "I get momentum from inventing the premise, not from status." } });
    ownerEventId = owner.id;
    runtime.store.indexEvidence({ tenantId: "test", sourceEventId: owner.id, kind: "conversation.user", trustClass: "owner", content: "I get momentum from inventing the premise, not from status.", observedAt: owner.at });
    runtime.store.enqueueJob("test", "content.enrich", { url, sourceEventId: owner.id, userNote: "I get momentum from inventing the premise, not from status." });
    const worker = new RuntimeWorker(runtime, {
      videoAnalyzer: null,
      contentEnricher: async () => ({
        kind: "article", url, title: "Creative work", content: "A sufficiently long source argues that self-directed ideas create more durable creative energy than external acclaim.",
        coverage: "fulltext", deferred: false, metadata: { pipelineVersion: 3, coverage: "fulltext", deferred: false },
      }),
    });
    assert.equal(await worker.runOnce(), true);
    assert.equal(verifierCalls, 1);
    const intervention = runtime.store.db.prepare("SELECT decision FROM interventions WHERE tenant_id='test'").get() as { decision: string };
    assert.equal(intervention.decision, "silence");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("an aged hold is semantically revalidated before connector delivery", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.models = { foreground: route, deliberation: route, background: route, critic: route };
  config.autonomy = { ...config.autonomy, quietHoursStart: 0, quietHoursEnd: 24 };
  let ownerEventId = "";
  const adapter: ProviderAdapter = {
    name: "openai-compatible",
    complete: async () => ({
      text: JSON.stringify({ relation: "restatement", matchedEventId: ownerEventId, reason: "The owner has since stated the same deadline implication." }),
      toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
    }),
  };
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([adapter]) });
  try {
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "calendar", type: "calendar.changed", payload: { deadline: "Friday" } });
    const gate = new AttentionGate(config, runtime.store, runtime.outcomeLearner);
    const held = gate.evaluate("test", {
      sourceEventId: source.id, topicKey: "return-window", evidence: 2, novelty: 0.95, urgency: 0.8,
      usefulness: 1, actionability: 0.9, confidence: 0.95, interruptionCost: 0.02,
      content: "The merchant's parcel cutoff is Friday, so the handoff must happen first.",
    });
    assert.equal(held.send, false);
    const owner = runtime.store.appendEvent({ tenantId: "test", stream: "conversation", type: "message.received", payload: { text: "I already arranged the return dropoff before the end-of-week deadline." } });
    ownerEventId = owner.id;
    runtime.store.indexEvidence({ tenantId: "test", sourceEventId: owner.id, kind: "conversation.user", trustClass: "owner", content: "I already arranged the return dropoff before the end-of-week deadline.", observedAt: owner.at });
    runtime.store.db.prepare("UPDATE interventions SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE source_event_id=?").run(source.id);
    config.autonomy.quietHoursEnd = 0;
    assert.equal(await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce(), true);
    const row = runtime.store.db.prepare("SELECT decision,reason FROM interventions WHERE source_event_id=?").get(source.id) as { decision: string; reason: string };
    assert.equal(row.decision, "silence");
    assert.match(row.reason, /semantic revalidation/);
    assert.equal(runtime.store.listEvents("test", { type: "knownness.semantic_checked" }).length, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});
