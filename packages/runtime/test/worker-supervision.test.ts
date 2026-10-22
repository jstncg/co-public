import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorAdapter } from "../src/connectors.ts";
import { DependencyError } from "../src/dependency-errors.ts";
import { stableId } from "../src/id.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { parseReleaseManifest } from "../src/releases.ts";
import { CoRuntime, SILENCE_RESPONSE_TOKEN } from "../src/runtime.ts";
import type { JobRecord, ProviderAdapter, ProviderRequest } from "../src/types.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { testConfig, testHome } from "./helpers.ts";

function memoryJob(runtime: CoRuntime, suffix: string): JobRecord {
  const source = runtime.store.appendEvent({
    tenantId: runtime.config.tenantId, stream: "test", type: "message.received",
    payload: { text: `remember that worker supervision continued ${suffix}` },
  });
  return runtime.store.enqueueJob(runtime.config.tenantId, "memory.extract", {
    input: `remember that worker supervision continued ${suffix}`, output: "", sourceEventId: source.id,
  });
}

function maintenancePhases(runtime: CoRuntime): string[] {
  return runtime.store.listEvents(runtime.config.tenantId, { type: "worker.maintenance_failed" })
    .map((event) => String((event.payload as { phase?: unknown }).phase));
}

function createOrphanedForegroundRun(runtime: CoRuntime, runId: string, externalId?: string): void {
  const session = runtime.store.ensureSession("test", "imessage", "member", { channel: "orphan-rail", peerId: "member" });
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  const source = runtime.store.appendEvent({
    tenantId: "test", stream: `session:${session.id}`, type: "message.received", at: old,
    payload: {
      channel: "orphan-rail", peerId: "member", text: "An orphaned foreground turn",
      externalId: externalId ?? null, metadata: {},
    },
  });
  runtime.store.createRun({
    id: runId, tenantId: "test", sessionId: session.id, kind: "foreground", status: "running", modelRole: "foreground",
    provider: "mock", model: "mock-1", input: "An orphaned foreground turn",
    state: {
      system: "test", messages: [{ id: `${runId}_input`, role: "user", parts: [{ type: "text", text: "An orphaned foreground turn" }], createdAt: old }],
      authorityToolNames: [], toolNames: [], modelRoute: { provider: "mock", model: "mock-1", maxOutputTokens: 128, reasoningEffort: "none" },
      iteration: 0, pendingCalls: [], nextToolIndex: 0, depth: 0, tokenBudget: 1_000,
    },
    inputTokens: 0, outputTokens: 0, createdAt: old, updatedAt: old,
  });
  runtime.store.appendEvent({
    tenantId: "test", stream: `run:${runId}`, type: "run.started", at: old, correlationId: runId,
    causationId: source.id, payload: { runId, sessionId: session.id, role: "foreground", depth: 0, toolNames: [] },
  });
}

test("background jobs cross the same provider cost ceiling before adapter execution", async () => {
  const home = testHome();
  let calls = 0;
  const provider: ProviderAdapter = {
    name: "openai-compatible",
    complete: async () => {
      calls += 1;
      return { text: '{"memories":[]}', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const route = {
    provider: "openai-compatible" as const, model: "cost-fixture", baseUrl: "https://fixture.invalid",
    maxOutputTokens: 512, reasoningEffort: "none" as const,
    costCeiling: { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 20, maxRequestUsd: 0.000001 },
  };
  const config = testConfig(home.path);
  config.models = { foreground: route, deliberation: route, background: route, critic: route };
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([provider]) });
  try {
    const job = memoryJob(runtime, "under a strict cost envelope");
    assert.equal(await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce(), true);
    const failed = runtime.store.getJob(job.id, "test");
    assert.equal(failed?.status, "failed");
    assert.match(failed?.lastError ?? "", /rejected before execution.*route ceiling/i);
    assert.equal(calls, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("orphaned-run recovery preserves explicit silence without attempting an empty text delivery", async () => {
  const home = testHome();
  const provider: ProviderAdapter = {
    name: "mock",
    complete: async () => ({ text: SILENCE_RESPONSE_TOKEN, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } }),
  };
  const runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([provider]) });
  const deliveries: Array<{ content: string; reaction?: unknown }> = [];
  runtime.connectors.register({
    id: "orphan-rail",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "orphan-rail", inboundConfigured: true, outboundConfigured: true }),
    verifyWebhook: () => true,
    parseWebhook: () => undefined,
    deliver: async (input) => {
      deliveries.push({ content: input.content, ...(input.reaction ? { reaction: input.reaction } : {}) });
      return { provider: "orphan-rail", messageId: "must-not-send" };
    },
    relationship: (peerId) => ({ channel: "imessage", peerId }),
  } satisfies ConnectorAdapter);
  try {
    createOrphanedForegroundRun(runtime, "run_orphaned_silence", "inbound-silence");
    assert.equal(await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce(), true);
    assert.equal(runtime.store.getRun("run_orphaned_silence", "test")?.status, "completed");
    assert.deepEqual(deliveries, []);
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_started" }).length, 0);
    assert.equal(runtime.store.listEvents("test", { type: "relationship.response_silenced" }).length, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("orphaned-run recovery emits exactly one native tapback against its relationship-bound inbound target", async () => {
  const home = testHome();
  const provider: ProviderAdapter = {
    name: "mock",
    complete: async () => ({ text: '<co:tapback type="love"/>', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } }),
  };
  const runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([provider]) });
  const deliveries: Array<{ content: string; reaction?: { type: string; targetMessageId: string } }> = [];
  runtime.connectors.register({
    id: "orphan-rail",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "orphan-rail", inboundConfigured: true, outboundConfigured: true }),
    verifyWebhook: () => true,
    parseWebhook: () => undefined,
    deliver: async (input) => {
      deliveries.push({ content: input.content, ...(input.reaction ? { reaction: input.reaction } : {}) });
      return input.reaction
        ? { provider: "orphan-rail", targetMessageId: input.reaction.targetMessageId, reactionType: input.reaction.type, status: "accepted" }
        : { provider: "orphan-rail", messageId: "must-not-send-text" };
    },
    relationship: (peerId) => ({ channel: "imessage", peerId }),
  } satisfies ConnectorAdapter);
  try {
    createOrphanedForegroundRun(runtime, "run_orphaned_tapback", "inbound-tapback");
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.store.getRun("run_orphaned_tapback", "test")?.status, "completed");
    assert.deepEqual(deliveries, [{ content: "", reaction: { type: "love", targetMessageId: "inbound-tapback" } }]);
    assert.equal(runtime.store.listEvents("test", { type: "message.reaction_accepted" }).length, 1);
    assert.equal(runtime.store.listEvents("test", { type: "relationship.reaction_sent" }).length, 1);
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_accepted" }).length, 0);
    assert.equal(await worker.runOnce(), true, "the queued memory projection may run without repeating the response effect");
    assert.equal(deliveries.length, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("orphaned-run recovery never degrades a targetless tapback into an empty text message", async () => {
  const home = testHome();
  const provider: ProviderAdapter = {
    name: "mock",
    complete: async () => ({ text: '<co:tapback type="question"/>', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } }),
  };
  const runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([provider]) });
  let deliveries = 0;
  runtime.connectors.register({
    id: "orphan-rail",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "orphan-rail", inboundConfigured: true, outboundConfigured: true }),
    verifyWebhook: () => true,
    parseWebhook: () => undefined,
    deliver: async () => {
      deliveries += 1;
      return { provider: "orphan-rail", messageId: "must-not-send" };
    },
    relationship: (peerId) => ({ channel: "imessage", peerId }),
  } satisfies ConnectorAdapter);
  try {
    createOrphanedForegroundRun(runtime, "run_orphaned_targetless_tapback");
    assert.equal(await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce(), true);
    assert.equal(runtime.store.getRun("run_orphaned_targetless_tapback", "test")?.status, "completed");
    assert.equal(deliveries, 0);
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_started" }).length, 0);
    const unavailable = runtime.store.listEvents("test", { type: "relationship.reaction_unavailable" });
    assert.equal(unavailable.length, 1);
    assert.match(String((unavailable[0]!.payload as { reason?: unknown }).reason), /no relationship-bound inbound message target/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("worker maintenance phases are isolated and useful queued work still executes", async (context) => {
  const cases: Array<{
    name: string;
    phase: string;
    break(runtime: CoRuntime): () => void;
  }> = [
    {
      name: "stale job sweep", phase: "stale-job-sweep",
      break: (runtime) => {
        const original = runtime.store.requeueStaleJobs.bind(runtime.store);
        runtime.store.requeueStaleJobs = () => { throw new Error("fixture stale-job failure"); };
        return () => { runtime.store.requeueStaleJobs = original; };
      },
    },
    {
      name: "stale run scan", phase: "stale-run-scan",
      break: (runtime) => {
        const original = runtime.store.findStaleRunId.bind(runtime.store);
        runtime.store.findStaleRunId = () => { throw new Error("fixture stale-run failure"); };
        return () => { runtime.store.findStaleRunId = original; };
      },
    },
    {
      name: "schedule materialization", phase: "schedule-materialization",
      break: (runtime) => {
        const original = runtime.scheduler.materializeDue.bind(runtime.scheduler);
        runtime.scheduler.materializeDue = () => { throw new Error("fixture schedule failure"); };
        return () => { runtime.scheduler.materializeDue = original; };
      },
    },
  ];

  for (const fixture of cases) {
    await context.test(fixture.name, async () => {
      const home = testHome();
      const runtime = new CoRuntime({ config: testConfig(home.path) });
      const restore = fixture.break(runtime);
      try {
        const job = memoryJob(runtime, fixture.phase);
        assert.equal(await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce(), true);
        assert.equal(runtime.store.getJob(job.id, "test")?.status, "completed");
        assert.ok(maintenancePhases(runtime).includes(fixture.phase));
      } finally {
        restore();
        runtime.close();
        home.cleanup();
      }
    });
  }
});

test("an exhausted pre-transport relationship dispatch creates one owned repair item", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const session = runtime.store.ensureSession("test", "imessage", "member");
    const source = runtime.store.appendEvent({
      tenantId: "test", stream: `session:${session.id}`, type: "message.received", payload: { text: "Please follow up" },
    });
    const runId = "run_relationship_exhausted";
    const deliveryKey = "requested-result";
    const deliveryIntentId = stableId("evt", `delivery-intent:test:${runId}:imessage:member:${deliveryKey}`);
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    const admission = worker.relationshipArbiter.consider({
      tenantId: "test", sessionId: session.id, sourceEventId: source.id, runId, deliveryKey, deliveryIntentId,
      deliveryClass: "requested_result", urgency: 0.9, contentDigest: stableId("content", "A result"),
      authorityRef: `inbound:${source.id}`,
    }, { authorized: true, fresh: true, reason: "fixture authority" });
    assert.equal(admission.decision, "admitted");
    runtime.store.db.prepare(`UPDATE relationship_admissions SET status='held',lease_token=NULL,lease_expires_at=NULL
      WHERE tenant_id=? AND id=?`).run("test", admission.record.id);
    const queued = runtime.store.enqueueJob("test", "relationship.dispatch", {
      tenantId: "test", sessionId: session.id, sourceEventId: source.id, runId, channel: "imessage", peerId: "member",
      content: "A result", deliveryKey, deliveryClass: "requested_result", urgency: 0.9,
      authorityRef: `inbound:${source.id}`, releaseId: "release_fixture", admissionId: admission.record.id,
    }, { maxAttempts: 16, releaseId: "release_fixture" });
    const exhausted = { ...queued, attempts: 16, maxAttempts: 16, lastError: "relationship remained occupied" };
    const terminalize = worker as unknown as { terminalizeExhaustedJob(job: JobRecord, reason: string): void };
    terminalize.terminalizeExhaustedJob(exhausted, exhausted.lastError);
    terminalize.terminalizeExhaustedJob(exhausted, exhausted.lastError);

    assert.equal(worker.relationshipArbiter.get("test", admission.record.id)?.status, "held");
    assert.equal(runtime.store.listEvents("test", { type: "relationship.dispatch_abandoned" }).length, 1);
    const repairs = runtime.office.listAttention("test").filter((item) => item.title === "Relationship delivery needs repair");
    assert.equal(repairs.length, 1);
    assert.match(repairs[0]?.content ?? "", /requested result delivery/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("relationship accounting distinguishes requested, optional, and scheduled responses", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null }) as unknown as {
      responseDeliveryClass(tenantId: string, runId: string, input: string, scheduled?: boolean): string;
    };
    assert.equal(worker.responseDeliveryClass("test", "missing-run", "What did I miss?"), "requested_reply");
    assert.equal(worker.responseDeliveryClass("test", "missing-run", "I keep returning to this idea."), "optional_reply");
    assert.equal(worker.responseDeliveryClass("test", "missing-run", "Send the scheduled result", true), "accepted_burden_repair");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("claim, malformed claim, finish, and attention failures stay supervised", async (context) => {
  await context.test("claim failure", async () => {
    const home = testHome();
    const runtime = new CoRuntime({ config: testConfig(home.path) });
    const original = runtime.store.claimJob.bind(runtime.store);
    try {
      const job = memoryJob(runtime, "claim");
      runtime.store.claimJob = () => { throw new Error("fixture claim failure"); };
      const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
      assert.equal(await worker.runOnce(), false);
      runtime.store.claimJob = original;
      assert.equal(await worker.runOnce(), true);
      assert.equal(runtime.store.getJob(job.id, "test")?.status, "completed");
      assert.ok(maintenancePhases(runtime).includes("job-claim"));
    } finally {
      runtime.store.claimJob = original;
      runtime.close();
      home.cleanup();
    }
  });

  await context.test("claim without lease", async () => {
    const home = testHome();
    const runtime = new CoRuntime({ config: testConfig(home.path) });
    const original = runtime.store.claimJob.bind(runtime.store);
    try {
      const job = memoryJob(runtime, "missing lease");
      runtime.store.claimJob = (...args) => {
        const claimed = original(...args);
        if (!claimed) return undefined;
        const { leaseToken: _omitted, ...withoutLease } = claimed;
        return withoutLease;
      };
      assert.equal(await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce(), true);
      assert.equal(runtime.store.getJob(job.id, "test")?.status, "failed");
      assert.ok(maintenancePhases(runtime).includes("job-claim"));
    } finally {
      runtime.store.claimJob = original;
      runtime.close();
      home.cleanup();
    }
  });

  await context.test("finish failure", async () => {
    const home = testHome();
    const runtime = new CoRuntime({ config: testConfig(home.path) });
    const original = runtime.store.finishJob.bind(runtime.store);
    try {
      const job = memoryJob(runtime, "finish");
      runtime.store.finishJob = () => { throw new Error("fixture finish failure"); };
      const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
      assert.equal(await worker.runOnce(), true);
      assert.equal(runtime.store.getJob(job.id, "test")?.status, "running");
      assert.ok(maintenancePhases(runtime).includes("job-finish"));

      runtime.store.finishJob = original;
      runtime.store.db.prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?")
        .run(new Date(Date.now() - 1_000).toISOString(), job.id);
      assert.equal(await worker.runOnce(), true);
      assert.equal(runtime.store.getJob(job.id, "test")?.status, "completed");
    } finally {
      runtime.store.finishJob = original;
      runtime.close();
      home.cleanup();
    }
  });

  await context.test("attention delivery failure", async () => {
    const home = testHome();
    const runtime = new CoRuntime({ config: testConfig(home.path) });
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    const mutable = worker as unknown as { deliverOneIntervention(): Promise<boolean> };
    mutable.deliverOneIntervention = async () => { throw new Error("fixture attention failure"); };
    try {
      assert.equal(await worker.runOnce(), false);
      assert.ok(maintenancePhases(runtime).includes("attention-delivery"));
    } finally {
      runtime.close();
      home.cleanup();
    }
  });
});

test("proactive delivery retries are persisted, delayed, and eventually provider-accepted", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  let attempts = 0;
  const connector: ConnectorAdapter = {
    id: "retry-rail",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "retry-rail", inboundConfigured: false, outboundConfigured: true }),
    verifyWebhook: () => false,
    parseWebhook: () => undefined,
    deliver: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new DependencyError({
          service: "fixture", kind: "rate_limited", message: "retry later", retryable: true,
          uncertain: false, retryAfterMs: 60_000,
        });
      }
      return { provider: "retry-rail", messageId: "confirmed-2" };
    },
  };
  runtime.connectors.register(connector);
  try {
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "calendar:return", type: "calendar.changed", payload: {} });
    const decision = new RuntimeWorker(runtime, { videoAnalyzer: null }).attention.evaluate("test", {
      sourceEventId: source.id, topicKey: "durable-retry", evidence: 2, novelty: 1, urgency: 1,
      usefulness: 1, actionability: 1, confidence: 0.99, interruptionCost: 0.01,
      content: "Your return window closes today.", channel: "retry-rail", peerId: "member",
    });
    assert.equal(decision.send, true);
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    assert.equal(await worker.runOnce(), true);
    const pending = runtime.store.db.prepare(`SELECT id,decision,sent_at,delivery_attempts,next_attempt_at,last_delivery_error
      FROM interventions WHERE tenant_id=? AND topic_key=?`).get("test", "durable-retry") as {
        id: string; decision: string; sent_at: string | null; delivery_attempts: number;
        next_attempt_at: string | null; last_delivery_error: string | null;
      };
    assert.equal(pending.decision, "send");
    assert.equal(pending.sent_at, null);
    assert.equal(pending.delivery_attempts, 1);
    assert.ok(Date.parse(pending.next_attempt_at ?? "") > Date.now() + 50_000);
    assert.match(pending.last_delivery_error ?? "", /retry later/);
    assert.equal(await worker.runOnce(), false, "a daemon pass before the persisted due time does not hammer the connector");
    assert.equal(attempts, 1);

    runtime.store.db.prepare("UPDATE interventions SET next_attempt_at=? WHERE id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), pending.id);
    runtime.store.db.prepare("UPDATE relationship_admissions SET not_before=? WHERE tenant_id=? AND intervention_id=? AND status='held'")
      .run(new Date(Date.now() - 1_000).toISOString(), "test", pending.id);
    assert.equal(await worker.runOnce(), true);
    const delivered = runtime.store.db.prepare(`SELECT accepted_at,sent_at,next_attempt_at,last_delivery_error
      FROM interventions WHERE id=?`).get(pending.id) as { accepted_at: string | null; sent_at: string | null; next_attempt_at: string | null; last_delivery_error: string | null };
    assert.ok(delivered.accepted_at);
    assert.equal(delivered.sent_at, null, "provider acceptance is not member delivery evidence");
    assert.equal(delivered.next_attempt_at, null);
    assert.equal(delivered.last_delivery_error, null);
    assert.equal(attempts, 2);
    assert.equal(runtime.store.listEvents("test", { type: "intervention.delivery_retry_scheduled" }).length, 1);
    assert.equal(runtime.store.listEvents("test", { type: "intervention.accepted" }).length, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("proactive delivery yields to a live owner conversation unless the signal is urgent", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  const delivered: string[] = [];
  runtime.connectors.register({
    id: "live-context-rail",
    inboundPrincipal: "member",
    status: () => ({ id: "live-context-rail", inboundConfigured: true, outboundConfigured: true }),
    verifyWebhook: () => false,
    parseWebhook: () => undefined,
    relationship: (peerId) => ({ channel: "imessage", peerId }),
    deliver: async (input) => {
      delivered.push(input.content);
      return { provider: "live-context-rail", messageId: `live-${delivered.length}` };
    },
  });
  try {
    const session = runtime.store.ensureSession("test", "imessage", "member", { channel: "live-context-rail", peerId: "member" });
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "calendar:context", type: "calendar.changed", payload: {} });
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    assert.equal(worker.attention.evaluate("test", {
      sourceEventId: source.id, topicKey: "nonurgent-context", evidence: 2, novelty: 1, urgency: 0.5,
      usefulness: 1, actionability: 1, confidence: 0.99, interruptionCost: 0.01,
      content: "A useful but nonurgent observation.", channel: "live-context-rail", peerId: "member",
    }).send, true);
    const ownerAt = new Date(Date.now() + 1_000).toISOString();
    const ownerEvent = runtime.store.appendEvent({
      tenantId: "test", stream: `session:${session.id}`, type: "message.received", at: ownerAt,
      payload: { channel: "live-context-rail", peerId: "member", text: "I am talking to you right now." },
    });
    runtime.store.addMessage("test", session.id, {
      id: "live_context_owner_message", role: "user",
      parts: [{ type: "text", text: "I am talking to you right now." }], createdAt: ownerAt,
    }, ownerEvent.id);

    assert.equal(await worker.runOnce(), true);
    const held = runtime.store.db.prepare(`SELECT decision,next_attempt_at,attention_reserved_at,reason
      FROM interventions WHERE tenant_id=? AND topic_key=?`).get("test", "nonurgent-context") as {
        decision: string; next_attempt_at: string | null; attention_reserved_at: string | null; reason: string;
      };
    assert.equal(held.decision, "held");
    assert.ok(Date.parse(held.next_attempt_at ?? "") > Date.now() + 14 * 60_000);
    assert.equal(held.attention_reserved_at, null, "a live-conversation hold releases the daily attention reservation");
    assert.match(held.reason, /^temporary attention hold: active relationship conversation/);
    assert.deepEqual(delivered, []);
    assert.equal(runtime.store.listEvents("test", { type: "intervention.held_for_live_conversation" }).length, 1);

    const urgentSource = runtime.store.appendEvent({ tenantId: "test", stream: "calendar:urgent", type: "calendar.changed", payload: {} });
    assert.equal(worker.attention.evaluate("test", {
      sourceEventId: urgentSource.id, topicKey: "urgent-context", evidence: 2, novelty: 1, urgency: 0.95,
      usefulness: 1, actionability: 1, confidence: 0.99, interruptionCost: 0.01,
      content: "Your return window closes now.", channel: "live-context-rail", peerId: "member",
    }).send, true);
    assert.equal(await worker.runOnce(), true);
    assert.deepEqual(delivered, ["Your return window closes now."]);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("proactive delivery exhausts a bounded retry budget and becomes held work", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  const connector: ConnectorAdapter = {
    id: "dead-rail",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "dead-rail", inboundConfigured: false, outboundConfigured: true }),
    verifyWebhook: () => false,
    parseWebhook: () => undefined,
    deliver: async () => { throw new DependencyError({ service: "fixture", kind: "unavailable", message: "still down", retryable: true }); },
  };
  runtime.connectors.register(connector);
  try {
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "calendar:return", type: "calendar.changed", payload: {} });
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    const decision = worker.attention.evaluate("test", {
      sourceEventId: source.id, topicKey: "bounded-retry", evidence: 2, novelty: 1, urgency: 1,
      usefulness: 1, actionability: 1, confidence: 0.99, interruptionCost: 0.01,
      content: "This cannot be delivered.", channel: "dead-rail", peerId: "member",
    });
    assert.equal(decision.send, true);
    runtime.store.db.prepare("UPDATE interventions SET delivery_attempts=7 WHERE tenant_id=? AND topic_key=?")
      .run("test", "bounded-retry");
    assert.equal(await worker.runOnce(), true);
    const intervention = runtime.store.db.prepare(`SELECT decision,sent_at,delivery_attempts,next_attempt_at
      FROM interventions WHERE tenant_id=? AND topic_key=?`).get("test", "bounded-retry") as {
        decision: string; sent_at: string | null; delivery_attempts: number; next_attempt_at: string | null;
      };
    assert.equal(intervention.decision, "held");
    assert.equal(intervention.sent_at, null);
    assert.equal(intervention.delivery_attempts, 8);
    assert.equal(intervention.next_attempt_at, null);
    assert.equal(runtime.store.listEvents("test", { type: "intervention.delivery_abandoned" }).length, 1);
    assert.ok(runtime.office.listAttention("test").some((item) => /could not be delivered/.test(item.title)));
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("an explicit connector smoke writes one durable receipt and deduplicates the operator key", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  let calls = 0;
  runtime.connectors.register({
    id: "smoke-rail",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "smoke-rail", inboundConfigured: false, outboundConfigured: true }),
    verifyWebhook: () => false,
    parseWebhook: () => undefined,
    relationship: (peerId) => ({ channel: "imessage", peerId }),
    deliver: async () => { calls += 1; return { provider: "smoke-rail", messageId: `smoke-${calls}` }; },
  });
  try {
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    const input = { tenantId: "test", channel: "smoke-rail", peerId: "+15550001111", content: "Receipt-backed smoke", idempotencyKey: "release-27" };
    const first = await worker.smokeConnector(input);
    const repeated = await worker.smokeConnector(input);
    assert.equal(first.outcome, "accepted");
    assert.equal(repeated.outcome, "accepted");
    assert.equal(repeated.receiptEventId, first.receiptEventId);
    assert.equal(calls, 1);
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_accepted" }).length, 1);
    const session = runtime.store.ensureSession("test", "imessage", "+15550001111");
    assert.equal(runtime.store.listMessages("test", session.id).filter((message) => message.role === "assistant").length, 1);

    const addMessage = runtime.store.addMessage.bind(runtime.store);
    runtime.store.addMessage = () => { throw new Error("fixture projection failure"); };
    const projectionFailure = await worker.smokeConnector({ ...input, content: "Second accepted smoke", idempotencyKey: "release-27-projection" });
    runtime.store.addMessage = addMessage;
    assert.equal(projectionFailure.outcome, "accepted");
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_accepted" }).length, 2);
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_uncertain" }).length, 0);
    assert.ok(maintenancePhases(runtime).includes("relationship-message-canonicalization"));
    const repaired = await worker.smokeConnector({ ...input, content: "Second accepted smoke", idempotencyKey: "release-27-projection" });
    assert.equal(repaired.outcome, "accepted");
    assert.equal(calls, 2, "projection repair must reuse acceptance without another provider call");
    assert.equal(runtime.store.listMessages("test", session.id).filter((message) => message.role === "assistant").length, 2);

    await worker.smokeConnector({ ...input, content: "Same legitimate reply", idempotencyKey: "same-text-one" });
    await worker.smokeConnector({ ...input, content: "Same legitimate reply", idempotencyKey: "same-text-two" });
    assert.equal(calls, 4);
    assert.equal(runtime.store.listMessages("test", session.id).filter((message) => message.role === "assistant").length, 4,
      "distinct deliveries with identical text remain distinct conversation turns");
    await assert.rejects(
      worker.smokeConnector({ ...input, content: "changed content", idempotencyKey: "same-text-one" }),
      /rebound to different content or routing/,
    );
    assert.equal(calls, 4);
    await assert.rejects(worker.smokeConnector({ ...input, tenantId: "neighbor" }), /tenant does not match/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("concurrent proactive workers cannot submit the same outbound effect twice", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  let calls = 0;
  let releaseDelivery!: () => void;
  const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
  runtime.connectors.register({
    id: "concurrent-rail",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "concurrent-rail", inboundConfigured: false, outboundConfigured: true }),
    verifyWebhook: () => false,
    parseWebhook: () => undefined,
    relationship: (peerId) => ({ channel: "imessage", peerId }),
    deliver: async () => {
      calls += 1;
      await deliveryGate;
      return { provider: "concurrent-rail", messageId: "only-once" };
    },
  });
  try {
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "calendar:race", type: "calendar.changed", payload: {} });
    const firstWorker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    const secondWorker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    assert.equal(firstWorker.attention.evaluate("test", {
      sourceEventId: source.id, topicKey: "delivery-race", evidence: 2, novelty: 1, urgency: 1,
      usefulness: 1, actionability: 1, confidence: 0.99, interruptionCost: 0.01,
      content: "One message, even with two workers.", channel: "concurrent-rail", peerId: "member",
    }).send, true);
    const firstPass = firstWorker.runOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await secondWorker.runOnce(), true);
    assert.equal(calls, 1);
    releaseDelivery();
    assert.equal(await firstPass, true);
    const intervention = runtime.store.db.prepare("SELECT accepted_at,sent_at FROM interventions WHERE tenant_id=? AND topic_key=?")
      .get("test", "delivery-race") as { accepted_at: string | null; sent_at: string | null };
    assert.ok(intervention.accepted_at);
    assert.equal(intervention.sent_at, null);
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_accepted" }).length, 1);
    assert.equal(runtime.store.listMessages("test", runtime.store.ensureSession("test", "imessage", "member").id)
      .filter((message) => message.role === "assistant").length, 1);
  } finally {
    releaseDelivery();
    runtime.close();
    home.cleanup();
  }
});

test("a definitive connector rejection is held and is not retried", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  let calls = 0;
  runtime.connectors.register({
    id: "permanent-rail",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "permanent-rail", inboundConfigured: false, outboundConfigured: true }),
    verifyWebhook: () => false,
    parseWebhook: () => undefined,
    deliver: async () => {
      calls += 1;
      throw new DependencyError({ service: "permanent-rail", kind: "authentication", message: "credential rejected", retryable: false, uncertain: false });
    },
  });
  try {
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "calendar:failure", type: "calendar.changed", payload: {} });
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    assert.equal(worker.attention.evaluate("test", {
      sourceEventId: source.id, topicKey: "permanent-delivery", evidence: 2, novelty: 1, urgency: 1,
      usefulness: 1, actionability: 1, confidence: 0.99, interruptionCost: 0.01,
      content: "This route is invalid.", channel: "permanent-rail", peerId: "member",
    }).send, true);
    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), false);
    assert.equal(calls, 1);
    const intervention = runtime.store.db.prepare("SELECT decision,sent_at,last_delivery_error FROM interventions WHERE tenant_id=? AND topic_key=?")
      .get("test", "permanent-delivery") as { decision: string; sent_at: string | null; last_delivery_error: string | null };
    assert.equal(intervention.decision, "held");
    assert.equal(intervention.sent_at, null);
    assert.match(intervention.last_delivery_error ?? "", /credential rejected/);
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_failed" }).length, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a queued background job retains its assigned behavior release across rollback", async () => {
  const home = testHome();
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    name: "openai-compatible",
    complete: async (request) => {
      requests.push(request);
      return {
        text: JSON.stringify({
          disposition: "discard", kind: "none", title: "No warranted consequence",
          objective: "Leave the accepted intelligence without follow-through.",
          rationale: "The source does not justify any useful additional consequence.",
          memberDelta: "There is no concrete member delta beyond the supplied source.", content: "",
          confidence: 0, novelty: 0, usefulness: 0, urgency: 0,
        }),
        toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      };
    },
  };
  const route = {
    provider: "openai-compatible" as const, model: "stable-model", baseUrl: "https://fixture.invalid",
    maxOutputTokens: 512, reasoningEffort: "none" as const,
  };
  const operatorConfig = { ...testConfig(home.path), tenantId: "operator", models: { foreground: route, deliberation: route, background: route, critic: route } };
  const operator = new CoRuntime({ config: operatorConfig, providers: new ProviderRegistry([provider]) });
  let tenantRuntime: CoRuntime | undefined;
  try {
    const candidate = operator.releases.stage("operator", parseReleaseManifest({
      version: 1, label: "background-candidate", distributionId: operator.distribution.id,
      systemPrompt: "PINNED BACKGROUND CANDIDATE PROMPT",
      models: {
        foreground: { ...route, model: "candidate-foreground" },
        deliberation: { ...route, model: "candidate-deliberation" },
        background: { ...route, model: "candidate-background" },
        critic: { ...route, model: "candidate-critic" },
      },
      skills: operator.skills.skills.map((skill) => ({ name: skill.name, version: skill.version })),
      autoApproveRisks: [],
    }));
    operator.releases.canary("operator", candidate.id, 9_999);
    let tenantId = "";
    for (let index = 0; index < 2_000; index += 1) {
      const possible = `background-canary-${index}`;
      if (operator.releases.assign(possible).release.id === candidate.id) {
        tenantId = possible;
        break;
      }
    }
    assert.ok(tenantId);
    tenantRuntime = new CoRuntime({
      config: { ...operatorConfig, tenantId }, providers: new ProviderRegistry([provider]),
    });
    const source = tenantRuntime.store.appendEvent({ tenantId, stream: "fixture", type: "ambient.usefulness_assessed", payload: { useful: false } });
    const job = tenantRuntime.store.enqueueJob(tenantId, "consequence.plan", {
      sourceKind: "ambient", sourceId: source.id, sourceEventId: source.id,
    }, { releaseId: candidate.id });

    operator.releases.rollback("operator");
    assert.equal(operator.releases.assign("after-rollback").release.manifest.models.background.model, "stable-model");
    assert.equal(await new RuntimeWorker(tenantRuntime, { videoAnalyzer: null }).runOnce(), true);
    const completedJob = tenantRuntime.store.getJob(job.id, tenantId);
    assert.equal(completedJob?.status, "completed", JSON.stringify(completedJob));
    assert.equal(requests.at(-1)?.route.model, "candidate-background");
    assert.match(requests.at(-1)?.system ?? "", /PINNED BACKGROUND CANDIDATE PROMPT/);
  } finally {
    tenantRuntime?.close();
    operator.close();
    home.cleanup();
  }
});
