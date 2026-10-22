import assert from "node:assert/strict";
import test from "node:test";
import { CoRuntime } from "../src/runtime.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { ResponsibilityManager } from "../src/responsibilities.ts";
import { SqliteStore } from "../src/store.ts";
import { createRuntimeServer } from "../src/server.ts";
import type { ProviderRequest, ProviderResponse } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

function fixture(modelCallLimit = 10, tokenLimit = 1_000_000, toolCallLimit = 20) {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  const session = runtime.store.ensureSession("test", "cli", "responsibility-owner");
  const event = runtime.store.appendEvent({ tenantId: "test", stream: `session:${session.id}`, type: "message.received", payload: { text: "Investigate this within the agreed budget." } });
  const admission = { tenantId: "test", ownerSessionId: session.id, sourceEventId: event.id, objective: "Investigate a concrete decision and preserve the evidence.",
    tokenLimit, modelCallLimit, toolCallLimit, deadlineAt: new Date(Date.now() + 86_400_000).toISOString(), idempotencyKey: "responsibility-fixture" };
  const responsibilityId = runtime.responsibilities.create(admission);
  const seed = async () => {
    const run = await runtime.turn({ tenantId: "test", channel: "cli", peerId: "seed", text: "seed" }, { kind: "background", inputPrincipal: "agent" });
    runtime.responsibilities.bind("test", "run", run.runId, responsibilityId);
    return run.runId;
  };
  const request: ProviderRequest = { tenantId: "test", system: "Bounded fixture", messages: [], tools: [], route: {
    provider: "mock", model: "fixture", reasoningEffort: "none", maxOutputTokens: 128,
  } };
  const response: ProviderResponse = { text: "A verified fixture response.", toolCalls: [], usage: { inputTokens: 20, outputTokens: 10, reasoningTokens: 0 } };
  return { home, runtime, session, event, admission, responsibilityId, seed, request, response,
    close: () => { runtime.close(); home.cleanup(); } };
}

test("work orders and retained specialists share one durable allowance across follow-ups", async () => {
  const f = fixture(3);
  try {
    const work = await f.runtime.submitWorkOrder({ responsibilityId: f.responsibilityId, evidencePolicy: "run", allowedTools: ["delegate_task"],
      objective: '[[tool:delegate_task {"objective":"Inspect one counterexample","deliverable":"A compact evidenced finding","allowedTools":[]}]]' });
    await new RuntimeWorker(f.runtime, { videoAnalyzer: null }).drain(8);
    const agent = f.runtime.agents.list("test")[0]!;
    assert.ok(agent);
    assert.equal(f.runtime.responsibilities.forEntity("test", "agent", agent.id), f.responsibilityId);
    assert.equal(f.runtime.responsibilities.forEntity("test", "work_order", work.workOrder.id), f.responsibilityId);
    assert.equal(f.runtime.responsibilities.forEntity("test", "run", agent.lastRunId!), f.responsibilityId);
    assert.equal(agent.status, "idle");
    assert.equal(f.runtime.agentMonitor.retained("test", agent.id)?.responsibilityId, f.responsibilityId);
    assert.equal(f.runtime.responsibilities.usage("test", f.responsibilityId).modelCalls, 3);
    f.runtime.agents.sendFromOwner({ tenantId: "test", targetAgentId: agent.id, content: "Try another angle." });
    await new RuntimeWorker(f.runtime, { videoAnalyzer: null }).drain(5);
    assert.equal(f.runtime.responsibilities.usage("test", f.responsibilityId).modelCalls, 3, "a fresh child turn does not receive a fresh overall budget");
    assert.equal(f.runtime.agents.get("test", agent.id)?.status, "failed");
    assert.equal(f.runtime.store.getRun(f.runtime.agents.get("test", agent.id)!.lastRunId!, "test")?.status, "failed");
  } finally { f.close(); }
});

test("concurrent database connections reserve capacity before either provider returns", async () => {
  const f = fixture(1);
  const secondStore = new SqliteStore(f.runtime.config.dbPath);
  const second = new ResponsibilityManager(secondStore);
  try {
    const runId = await f.seed();
    let finish!: () => void;
    let calls = 0;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const first = f.runtime.responsibilities.withRun("test", runId, () => f.runtime.responsibilities.complete(f.request, async () => {
      calls++; await waiting; return f.response;
    }));
    try {
      await assert.rejects(second.withRun("test", runId, () => second.complete(f.request, async () => { calls++; return f.response; })), /budget exhausted/);
    } finally { finish(); }
    await first;
    assert.equal(calls, 1);
    assert.deepEqual(second.usage("test", f.responsibilityId), { chargedTokens: 30, modelCalls: 1, toolCalls: 0 });
  } finally { secondStore.close(); f.close(); }
});

test("failed provider attempts retain their reservation across database reopen", async () => {
  const f = fixture(1);
  try {
    const runId = await f.seed();
    await assert.rejects(f.runtime.responsibilities.withRun("test", runId, () => f.runtime.responsibilities.complete(f.request, async () => {
      throw new Error("transport disappeared before usage was received");
    })), /transport disappeared/);
    assert.ok(f.runtime.responsibilities.usage("test", f.responsibilityId).chargedTokens > 4_096);
    const reopened = new SqliteStore(f.runtime.config.dbPath);
    try {
      const manager = new ResponsibilityManager(reopened);
      await assert.rejects(manager.withRun("test", runId, () => manager.complete(f.request, async () => f.response)), /budget exhausted/);
      assert.equal(reopened.db.prepare("SELECT state FROM responsibility_reservations").get()!.state, "uncertain");
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("cancelling the responsibility during inference discards the answer without refunding measured work", async () => {
  const f = fixture();
  try {
    const runId = await f.seed();
    await assert.rejects(f.runtime.responsibilities.withRun("test", runId, () => f.runtime.responsibilities.complete(f.request, async () => {
      f.runtime.responsibilities.cancel("test", f.responsibilityId);
      return f.response;
    })), /cancelled/);
    assert.equal(f.runtime.responsibilities.usage("test", f.responsibilityId).chargedTokens, 30);
    assert.throws(() => f.runtime.responsibilities.beforeTool("test", runId, "file.write"), /cancelled/);
    assert.equal(f.runtime.responsibilities.usage("test", f.responsibilityId).toolCalls, 0);
  } finally { f.close(); }
});

test("insufficient token capacity and detached admissions fail before any provider or tool work", async () => {
  const f = fixture(10, 100);
  try {
    const runId = await f.seed();
    let called = false;
    await assert.rejects(f.runtime.responsibilities.withRun("test", runId, () => f.runtime.responsibilities.complete(f.request, async () => {
      called = true; return f.response;
    })), /budget exhausted/);
    assert.equal(called, false);
    assert.throws(() => f.runtime.responsibilities.beforeTool("test", runId, "scout.create"), /no responsibility propagation/);
    assert.equal(f.runtime.responsibilities.usage("test", f.responsibilityId).modelCalls, 0);
  } finally { f.close(); }
});

test("responsibility identity is immutable, tenant-scoped, and portable", async () => {
  const f = fixture();
  const destinationHome = testHome();
  const destination = new CoRuntime({ config: testConfig(destinationHome.path) });
  try {
    assert.equal(f.runtime.responsibilities.create(f.admission), f.responsibilityId);
    assert.throws(() => f.runtime.responsibilities.create({ ...f.admission, tokenLimit: 2_000_000 }), /rebound/);
    const runId = await f.seed();
    await f.runtime.responsibilities.withRun("test", runId, () => f.runtime.responsibilities.complete(f.request, async () => f.response));
    const other = f.runtime.responsibilities.create({ ...f.admission, idempotencyKey: "different" });
    assert.throws(() => f.runtime.responsibilities.bind("test", "run", runId, other), /rebound/);
    assert.throws(() => f.runtime.responsibilities.bind("other", "run", runId, f.responsibilityId), /missing/);
    destination.tenantLifecycle.restoreExport({ tenantId: "test", bundle: f.runtime.tenantLifecycle.createExport("test"), confirmation: "RESTORE:test" });
    assert.equal(destination.responsibilities.forEntity("test", "run", runId), f.responsibilityId);
    assert.deepEqual(destination.responsibilities.usage("test", f.responsibilityId), { chargedTokens: 30, modelCalls: 1, toolCalls: 0 });
  } finally { destination.close(); destinationHome.cleanup(); f.close(); }
});

test("cancellation prevents queued descendant execution without deleting agent history", async () => {
  const f = fixture();
  try {
    const root = await f.runtime.turn({ tenantId: "test", channel: "cli", peerId: "responsibility-owner",
      text: '[[tool:delegate_task {"objective":"Inspect a source","deliverable":"A bounded source note","allowedTools":[]}]]' },
      { kind: "background", inputPrincipal: "agent", responsibilityId: f.responsibilityId, allowedTools: ["delegate_task"] });
    const agent = f.runtime.agents.list("test")[0]!;
    assert.ok(agent);
    f.runtime.responsibilities.cancel("test", f.responsibilityId);
    await new RuntimeWorker(f.runtime, { videoAnalyzer: null }).drain(10);
    assert.equal(f.runtime.responsibilities.usage("test", f.responsibilityId).modelCalls, 2);
    assert.equal(f.runtime.agents.get("test", agent.id)?.status, "failed");
    assert.ok(f.runtime.agents.messages("test", agent.id).length);
    assert.equal(f.runtime.store.getRun(root.runId, "test")?.status, "completed", "cancellation does not rewrite already-completed parent history");
  } finally { f.close(); }
});

test("operator HTTP can create, inspect, bind and cancel a responsibility but requires authentication", async () => {
  const f = fixture();
  f.runtime.config.serverToken = "responsibility-test-token";
  const server = createRuntimeServer(f.runtime);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/v1/responsibilities/${f.responsibilityId}`)).status, 401);
    const headers = { authorization: `Bearer ${f.runtime.config.serverToken}`, "content-type": "application/json" };
    const created = await fetch(`${base}/v1/responsibilities`, { method: "POST", headers, body: JSON.stringify({ ...f.admission, idempotencyKey: "http" }) });
    assert.equal(created.status, 201);
    const body = await created.json() as { id: string };
    const work = await fetch(`${base}/v1/work-orders`, { method: "POST", headers, body: JSON.stringify({ responsibilityId: body.id,
      objective: "Prepare one bounded comparison.", evidencePolicy: "run", allowedTools: [] }) });
    assert.equal(work.status, 202);
    const workBody = await work.json() as { workOrder: { workOrderId: string } };
    assert.equal(f.runtime.responsibilities.forEntity("test", "work_order", workBody.workOrder.workOrderId), body.id);
    const cancelled = await fetch(`${base}/v1/responsibilities/${body.id}/actions`, { method: "POST", headers, body: JSON.stringify({ action: "cancel" }) });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as { status: string }).status, "cancelled");
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); f.close(); }
});

test("an expired responsibility terminates queued work before creating an orphaned run", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-05T12:00:00Z") });
  const f = fixture();
  try {
    const work = await f.runtime.submitWorkOrder({ responsibilityId: f.responsibilityId, objective: "Inspect a bounded option.", evidencePolicy: "run", allowedTools: [] });
    t.mock.timers.tick(86_400_001);
    const result = await f.runtime.executeWorkOrder(work.workOrder.id);
    assert.equal(result.status, "failed");
    assert.equal(result.runId, undefined);
    assert.match(result.failureReason ?? "", /expired/);
    assert.equal(f.runtime.responsibilities.usage("test", f.responsibilityId).modelCalls, 0);
  } finally { f.close(); }
});

test("work-order retries cannot add, remove, or replace their admitted responsibility", async () => {
  const f = fixture();
  try {
    const input = { objective: "A bounded comparison.", evidencePolicy: "run" as const, allowedTools: [], idempotencyKey: "stable-work" };
    const first = await f.runtime.submitWorkOrder(input);
    await assert.rejects(f.runtime.submitWorkOrder({ ...input, responsibilityId: f.responsibilityId }), /cannot change/);
    assert.equal(f.runtime.responsibilities.forEntity("test", "work_order", first.workOrder.id), undefined);
    const owned = { ...input, idempotencyKey: "owned-work", responsibilityId: f.responsibilityId };
    const admitted = await f.runtime.submitWorkOrder(owned);
    assert.equal((await f.runtime.submitWorkOrder(owned)).duplicate, true);
    await assert.rejects(f.runtime.submitWorkOrder({ ...input, idempotencyKey: "owned-work" }), /cannot change/);
    assert.equal(f.runtime.responsibilities.forEntity("test", "work_order", admitted.workOrder.id), f.responsibilityId);
  } finally { f.close(); }
});

test("corrupt accounting fails closed instead of becoming a zero-cost request", async () => {
  const f = fixture();
  try {
    const runId = await f.seed();
    await f.runtime.responsibilities.withRun("test", runId, () => f.runtime.responsibilities.complete(f.request, async () => f.response));
    f.runtime.store.db.prepare("UPDATE responsibility_reservations SET charged_tokens='damaged' WHERE responsibility_id=?").run(f.responsibilityId);
    let calls = 0;
    await assert.rejects(f.runtime.responsibilities.withRun("test", runId, () => f.runtime.responsibilities.complete(f.request, async () => {
      calls++; return f.response;
    })), /accounting is malformed/);
    assert.equal(calls, 0);
    assert.equal(f.runtime.store.db.prepare("SELECT charged_tokens FROM responsibility_reservations WHERE responsibility_id=?").get(f.responsibilityId)!.charged_tokens, "damaged");
  } finally { f.close(); }
});
