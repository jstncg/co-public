import assert from "node:assert/strict";
import test from "node:test";
import { CoRuntime } from "../src/runtime.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { successfulToolResult } from "../src/tools.ts";
import { RuntimeWorker } from "../src/worker.ts";
import type { ProviderRequest, ProviderResponse } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

function fixture() {
  const home = testHome();
  let calls = 0;
  let reads = 0;
  let beforeResponse: (() => void) | undefined;
  const runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([{
    name: "mock", complete: async (request: ProviderRequest): Promise<ProviderResponse> => {
      calls++;
      beforeResponse?.();
      const results = request.messages.flatMap((m) => m.parts.filter((p) => p.type === "tool_result"));
      const toolCalls: ProviderResponse["toolCalls"] = !results.length
        ? [{ id: "read", name: "source.read", arguments: {} }]
        : results.length === 1 && !results[0]?.isError
          ? [{ id: "observe", name: "scout.observation.record", arguments: {
            scoutId: scout.id, retrievalToolCallId: "read", summary: "The complete selected source contains no new appointments today.",
          } }] : [];
      return { text: toolCalls.length ? "" : "Finished checking the selected source.", toolCalls,
        usage: { inputTokens: 10, outputTokens: 10, reasoningTokens: 0 } };
    },
  }]) });
  runtime.tools.register({ definition: { name: "source.read", description: "Read a bounded source snapshot.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read", tags: ["scout-source"], idempotent: true },
    execute: async () => { reads++; return { appointments: [] }; }, evaluateResult: successfulToolResult });
  const session = runtime.store.ensureSession("test", "internal", "source-lifecycle");
  const source = runtime.store.appendEvent({ tenantId: "test", stream: `session:${session.id}`, type: "message.received", payload: { text: "Watch this temporarily." } });
  const scout = runtime.scouts.create({ tenantId: "test", sourceEventId: source.id, sessionId: session.id,
    releaseId: runtime.releases.assign("test").release.id, name: "Temporary source", objective: "Read this selected source while its useful window remains open.",
    readToolName: "source.read", readArguments: {}, intervalMinutes: 15, wakeMode: "hybrid" });
  return { home, runtime, scout, session, source, counts: () => ({ calls, reads }),
    beforeResponse: (callback: () => void) => { beforeResponse = callback; },
    close: () => { runtime.close(); home.cleanup(); } };
}

test("an expired watch cannot execute a previously admitted read or reopen a legacy repair", async () => {
  const f = fixture();
  try {
    assert.equal(f.runtime.scouts.materializeDue("test"), 1);
    const work = f.runtime.scouts.runs("test", f.scout.id)[0]!;
    f.runtime.store.db.prepare("UPDATE scouts SET expires_at=?,release_id=NULL WHERE id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), f.scout.id);
    assert.equal(f.runtime.scouts.materializeDue("test"), 0);
    assert.equal(f.runtime.scouts.get("test", f.scout.id)?.status, "expired");
    assert.equal((await f.runtime.executeWorkOrder(work.workOrderId)).status, "cancelled");
    assert.deepEqual(f.counts(), { calls: 0, reads: 0 });
    assert.equal(f.runtime.office.listAttention("test", "open").length, 0);
  } finally { f.close(); }
});

test("pausing a watch during a model call prevents its proposed source read", async () => {
  const f = fixture();
  try {
    f.runtime.scouts.materializeDue("test");
    const work = f.runtime.scouts.runs("test", f.scout.id)[0]!;
    f.beforeResponse(() => f.runtime.scouts.transition("test", f.scout.id, "paused"));
    await f.runtime.executeWorkOrder(work.workOrderId);
    assert.equal(f.counts().reads, 0, "the read checks current watch status immediately before execution");
    assert.equal(f.runtime.scouts.observations("test", f.scout.id).length, 0);
    assert.equal(f.runtime.store.listJobs("test").filter((j) => j.type === "ambient.evaluate").length, 0);
  } finally { f.close(); }
});

test("source wakeups still work after a portable restore remaps global event numbers", () => {
  const f = fixture();
  const destinationHome = testHome();
  const destination = new CoRuntime({ config: testConfig(destinationHome.path) });
  try {
    for (let index = 0; index < 80; index++) f.runtime.store.appendEvent({ tenantId: "other", stream: "unrelated", type: "fixture.event", payload: {} });
    const wake = f.runtime.store.appendEvent({ tenantId: "test", stream: "source:test", type: "source.changed", payload: {} });
    f.runtime.scouts.wake({ tenantId: "test", scoutId: f.scout.id, sourceEventId: wake.id, sourceCursor: "cursor-a" });
    const bundle = f.runtime.tenantLifecycle.createExport("test");
    destination.tenantLifecycle.restoreExport({ tenantId: "test", bundle, confirmation: "RESTORE:test" });
    const next = destination.store.appendEvent({ tenantId: "test", stream: "source:test", type: "source.changed", payload: {} });
    assert.ok(next.seq < wake.seq, "the fixture forces a destination with lower event numbers");
    assert.equal(destination.scouts.wake({ tenantId: "test", scoutId: f.scout.id, sourceEventId: next.id, sourceCursor: "cursor-b" }).accepted, true);
    assert.equal(destination.scouts.get("test", f.scout.id)?.sourceCursor, "cursor-b");
    assert.equal(destination.scouts.wake({ tenantId: "test", scoutId: f.scout.id, sourceEventId: wake.id }).accepted, false);
  } finally { destination.close(); destinationHome.cleanup(); f.close(); }
});

test("two database connections recheck in-flight admission after obtaining the write lock", () => {
  const f = fixture();
  const second = new CoRuntime({ config: testConfig(f.home.path) });
  try {
    const transaction = f.runtime.store.transaction.bind(f.runtime.store);
    let raced = false;
    f.runtime.store.transaction = (operation) => {
      if (!raced) {
        raced = true;
        assert.equal(second.scouts.materializeDue("test"), 1);
        const wake = second.store.appendEvent({ tenantId: "test", stream: "source:test", type: "source.changed", payload: {} });
        second.scouts.wake({ tenantId: "test", scoutId: f.scout.id, sourceEventId: wake.id });
        second.store.db.prepare("UPDATE scouts SET next_run_at=? WHERE id=?").run(new Date(Date.now() - 1).toISOString(), f.scout.id);
      }
      return transaction(operation);
    };
    assert.equal(f.runtime.scouts.materializeDue("test"), 0);
    assert.equal(f.runtime.scouts.runs("test", f.scout.id).length, 1);
  } finally { second.close(); f.close(); }
});

test("a wake in the same millisecond as admission gets a fresh catch-up identity", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-05T12:00:00Z") });
  const f = fixture();
  try {
    f.runtime.scouts.materializeDue("test");
    const first = f.runtime.scouts.runs("test", f.scout.id)[0]!;
    const wake = f.runtime.store.appendEvent({ tenantId: "test", stream: "source:test", type: "source.changed", payload: {} });
    f.runtime.scouts.wake({ tenantId: "test", scoutId: f.scout.id, sourceEventId: wake.id, sourceCursor: "cursor  with spaces" });
    f.runtime.workOrders.failClosed("test", first.workOrderId, "Interrupted snapshot must be retried from a fresh read.");
    t.mock.timers.tick(1);
    assert.equal(f.runtime.scouts.materializeDue("test"), 1);
    const runs = f.runtime.scouts.runs("test", f.scout.id);
    assert.equal(runs.length, 2);
    assert.notEqual(runs[0]?.workOrderId, first.workOrderId);
    assert.equal(runs[0]?.wakeGeneration, 1);
    assert.equal(f.runtime.scouts.get("test", f.scout.id)?.sourceCursor, "cursor  with spaces");
  } finally { f.close(); }
});

test("scout health listing does not load observation history", async () => {
  const f = fixture();
  try {
    await new RuntimeWorker(f.runtime, { videoAnalyzer: null }).runOnce();
    assert.equal(f.runtime.scouts.observations("test", f.scout.id).length, 1);
    const tool = f.runtime.tools.get("scout.list")!;
    f.runtime.scouts.observations = () => { throw new Error("list loaded observation history"); };
    const result = await tool.execute({ tenantId: "test", sessionId: f.session.id, runId: "fixture", sourceEventId: f.source.id,
      depth: 0, authorityToolNames: ["scout.list"], idempotencyKey: "list", receiptId: "receipt" }, {});
    assert.doesNotMatch(JSON.stringify(result), /complete selected source/);
  } finally { f.close(); }
});

test("one damaged source definition is held without starving another source or erasing raw state", () => {
  const f = fixture();
  try {
    const healthy = f.runtime.scouts.create({ tenantId: "test", sourceEventId: f.source.id, sessionId: f.session.id,
      releaseId: f.scout.releaseId!, name: "Unaffected source", objective: "Keep this separately authorized source functioning.",
      readToolName: "source.read", readArguments: {}, intervalMinutes: 15 });
    f.runtime.store.db.prepare("UPDATE scouts SET read_arguments_json=?,next_run_at=? WHERE id=?")
      .run('{"truncated":', new Date(Date.now() - 1_000).toISOString(), f.scout.id);
    assert.equal(f.runtime.scouts.materializeDue("test"), 1);
    assert.equal(f.runtime.scouts.runs("test", healthy.id).length, 1);
    const damaged = f.runtime.store.db.prepare("SELECT status,read_arguments_json FROM scouts WHERE id=?").get(f.scout.id)!;
    assert.equal(damaged.status, "repair_required");
    assert.equal(damaged.read_arguments_json, '{"truncated":');
    assert.equal(f.runtime.scouts.materializeDue("test"), 0);
    assert.equal(f.runtime.office.listAttention("test", "open").length, 1);
  } finally { f.close(); }
});
