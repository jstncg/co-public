import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import { successfulToolResult } from "../src/tools.ts";
import type { JsonObject, ProviderAdapter, ProviderRequest, ProviderResponse, ToolCallPart, ToolResultPart } from "../src/types.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { CURRENT_SCHEMA_VERSION, SqliteStore } from "../src/store.ts";
import { testConfig, testHome } from "./helpers.ts";

function response(toolCalls: ToolCallPart[] = [], text = ""): ProviderResponse {
  return { text, toolCalls, usage: { inputTokens: 10, outputTokens: 10, reasoningTokens: 0 } };
}

function results(request: ProviderRequest): ToolResultPart[] {
  return request.messages.flatMap((message) => message.parts.filter((part): part is ToolResultPart => part.type === "tool_result"));
}

test("a persistent scout survives ticks, binds observations to read receipts, and emits only real changes", async () => {
  const home = testHome();
  let calendarOutput: JsonObject = { events: [{ id: "event-1", title: "Dinner", startsAt: "2026-09-04T02:00:00Z" }] };
  let readWindowHours = 48;
  const provider: ProviderAdapter = {
    name: "mock",
    complete: async (request) => {
      const toolResults = results(request);
      if (!toolResults.some((item) => item.name === "calendar.read")) {
        return response([{ type: "tool_call", id: "calendar-read", name: "calendar.read", arguments: { windowHours: readWindowHours } }]);
      }
      if (!toolResults.some((item) => item.name === "scout.observation.record")) {
        const scoutId = request.messages.findLast((message) => message.role === "user")?.parts
          .filter((part) => part.type === "text").map((part) => part.text).join(" ").match(/SCOUT (sct_[a-z0-9]+)/)?.[1];
        assert.ok(scoutId);
        return response([{
          type: "tool_call", id: "observation", name: "scout.observation.record",
          arguments: { scoutId, retrievalToolCallId: "calendar-read", summary: "The next 48 hours contain one dinner event beginning at 02:00 UTC." },
        }]);
      }
      return response([], "The scheduled read and observation were recorded.");
    },
  };
  const runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([provider]) });
  runtime.tools.register({
    definition: {
      name: "calendar.read", description: "Read the selected calendar window.",
      inputSchema: { type: "object", properties: { windowHours: { type: "integer", minimum: 1, maximum: 168 } }, required: ["windowHours"], additionalProperties: false },
      risk: "read", tags: ["mcp", "calendar", "scout-source"], idempotent: true,
    },
    execute: async () => calendarOutput,
    evaluateResult: successfulToolResult,
  });
  try {
    const session = runtime.store.ensureSession("test", "imessage", "+15555550100");
    const source = runtime.store.appendEvent({ tenantId: "test", stream: `session:${session.id}`, type: "message.received", payload: { text: "Keep an eye on the next two days of my calendar." } });
    const releaseId = runtime.releases.assign("test").release.id;
    const scout = runtime.scouts.create({
      tenantId: "test", sourceEventId: source.id, sessionId: session.id, releaseId, name: "Near-term calendar",
      objective: "Watch the next 48 hours for a material calendar change worth evaluating.",
      readToolName: "calendar.read", readArguments: { windowHours: 48 }, intervalMinutes: 15,
      channel: "imessage", peerId: "+15555550100", firstRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.scouts.runs("test", scout.id)[0]?.status, "completed");
    const first = runtime.scouts.observations("test", scout.id)[0];
    assert.equal(first?.changed, true);
    assert.ok(first?.sourceEventId);
    assert.equal(runtime.store.getReceipt("test", first?.runId as string, "calendar-read")?.status, "succeeded");
    assert.equal(runtime.store.listJobs("test").filter((job) => job.type === "ambient.evaluate" && job.status === "queued").length, 1);
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_accepted" }).length, 0, "the scout work order has no member-facing mouth");

    await worker.drain(10);
    runtime.store.db.prepare("UPDATE scouts SET next_run_at=? WHERE tenant_id=? AND id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), "test", scout.id);
    assert.equal(await worker.runOnce(), true);
    const observations = runtime.scouts.observations("test", scout.id);
    assert.equal(observations.length, 2);
    assert.equal(observations.filter((item) => item.changed).length, 1);
    assert.equal(runtime.store.listEvents("test", { type: "scout.observed" }).length, 1);
    assert.equal(runtime.store.listEvents("test", { type: "scout.unchanged" }).length, 1);

    calendarOutput = { events: [{ id: "event-1", title: "Dinner moved", startsAt: "2026-09-04T03:00:00Z" }] };
    runtime.store.db.prepare("UPDATE scouts SET next_run_at=? WHERE tenant_id=? AND id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), "test", scout.id);
    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.scouts.observations("test", scout.id).filter((item) => item.changed).length, 2);
    assert.ok(Date.parse(runtime.scouts.get("test", scout.id)?.nextRunAt ?? "") > Date.now());

    await worker.drain(10);
    calendarOutput = { truncated: true, preview: "Only the first part of the calendar response was returned." };
    runtime.store.db.prepare("UPDATE scouts SET next_run_at=? WHERE tenant_id=? AND id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), "test", scout.id);
    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.scouts.observations("test", scout.id).length, 3, "a truncated snapshot does not become an observation");
    assert.equal(runtime.scouts.runs("test", scout.id)[0]?.status, "needs_input");
    const failedObservation = runtime.store.db.prepare("SELECT status,error FROM tool_receipts WHERE tenant_id=? AND run_id=? AND tool_name='scout.observation.record'")
      .get("test", runtime.workOrders.get("test", runtime.scouts.runs("test", scout.id)[0]!.workOrderId)!.runId!) as { status: string; error: string };
    assert.equal(failedObservation.status, "failed");
    assert.match(failedObservation.error, /truncated sensor result/);

    readWindowHours = 72;
    calendarOutput = { events: [] };
    runtime.store.db.prepare("UPDATE scouts SET next_run_at=? WHERE tenant_id=? AND id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), "test", scout.id);
    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.scouts.observations("test", scout.id).length, 3);
    const widenedRun = runtime.scouts.runs("test", scout.id)[0]!;
    const widenedReceipt = runtime.store.db.prepare("SELECT status,error FROM tool_receipts WHERE tenant_id=? AND run_id=? AND tool_name='scout.observation.record'")
      .get("test", runtime.workOrders.get("test", widenedRun.workOrderId)!.runId!) as { status: string; error: string };
    assert.equal(widenedReceipt.status, "failed");
    assert.match(widenedReceipt.error, /differ from the snapshotted sensor scope/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("scout creation accepts only validated selected read sensors", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const result = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "local",
      text: `[[tool:scout.create ${JSON.stringify({
        name: "Unsafe local watch", objective: "Continuously inspect a local file without an operator-selected sensor boundary.",
        readToolName: "file.read", readArguments: { path: `${home.path}/anything` }, everyMinutes: 15,
      })}]]`,
    });
    const receipt = runtime.store.db.prepare("SELECT status,error FROM tool_receipts WHERE tenant_id=? AND run_id=?")
      .get("test", result.runId) as { status: string; error: string };
    assert.equal(receipt.status, "failed");
    assert.match(receipt.error, /operator-selected MCP or scout-source sensor/);
    assert.equal(runtime.scouts.list("test").length, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a forged scout observation cannot borrow a receipt from another run", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const session = runtime.store.ensureSession("test", "internal", "scout-fixture");
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "conversation", type: "message.received", payload: { text: "Watch this source." } });
    const releaseId = runtime.releases.assign("test").release.id;
    const scout = runtime.scouts.create({
      tenantId: "test", sourceEventId: source.id, sessionId: session.id, releaseId, name: "Fixture scout",
      objective: "Watch one selected external source for a material change.", readToolName: "sensor.read", readArguments: {}, intervalMinutes: 60,
    });
    assert.throws(() => runtime.scouts.recordObservation({
      tenantId: "test", scoutId: scout.id, runId: "unbound-run", retrievalToolCallId: "read", summary: "This fabricated observation has no bound scheduled run receipt.",
    }), /not bound to this scout's scheduled work-order run/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("scout identity is restart-durable and idempotency keys cannot be rebound", () => {
  const home = testHome();
  const config = testConfig(home.path);
  let scoutId = "";
  try {
    const firstRuntime = new CoRuntime({ config });
    const session = firstRuntime.store.ensureSession("test", "imessage", "+15555550123");
    const source = firstRuntime.store.appendEvent({ tenantId: "test", stream: "conversation", type: "message.received", payload: { text: "Watch the inbox for a time-sensitive reply." } });
    const releaseId = firstRuntime.releases.assign("test").release.id;
    const input = {
      tenantId: "test", sourceEventId: source.id, sessionId: session.id, releaseId, name: "Reply watch",
      objective: "Watch the selected inbox view for one time-sensitive reply.", readToolName: "mail.read", readArguments: { label: "inbox" },
      intervalMinutes: 15, idempotencyKey: "reply-watch",
    };
    const scout = firstRuntime.scouts.create(input);
    scoutId = scout.id;
    assert.equal(firstRuntime.scouts.create(input).id, scout.id);
    assert.throws(() => firstRuntime.scouts.create({ ...input, objective: "Silently rebind the same identity to different work." }), /reused with different content/);
    firstRuntime.close();

    const reopened = new CoRuntime({ config });
    try {
      assert.equal(reopened.scouts.get("test", scoutId)?.objective, input.objective);
      assert.equal((reopened.store.getEvent("test", source.id)?.payload as JsonObject | undefined)?.text, "Watch the inbox for a time-sensitive reply.");
    } finally {
      reopened.close();
    }
  } finally {
    home.cleanup();
  }
});

test("three consecutive failed observations stop a scout until an operator deliberately repairs it", async () => {
  const home = testHome();
  const provider: ProviderAdapter = {
    name: "mock",
    complete: async () => response([], "The sensor observation could not be established."),
  };
  let runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([provider]) });
  const registerSensor = (): void => runtime.tools.register({
    definition: {
      name: "calendar.read", description: "Read the selected calendar window.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read", tags: ["mcp", "calendar", "scout-source"], idempotent: true,
    },
    execute: async () => ({ events: [] }),
    evaluateResult: successfulToolResult,
  });
  try {
    registerSensor();
    const session = runtime.store.ensureSession("test", "imessage", "+15555550999");
    const source = runtime.store.appendEvent({
      tenantId: "test", stream: `session:${session.id}`, type: "message.received",
      payload: { text: "Watch my calendar, but stop if the connection is broken." },
    });
    const releaseId = runtime.releases.assign("test").release.id;
    const scout = runtime.scouts.create({
      tenantId: "test", sourceEventId: source.id, sessionId: session.id, releaseId,
      name: "Calendar watch", objective: "Watch the selected calendar for a material change.",
      readToolName: "calendar.read", readArguments: {}, intervalMinutes: 15,
      firstRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    for (let expectedFailures = 1; expectedFailures <= 2; expectedFailures += 1) {
      runtime.store.db.prepare("UPDATE scouts SET next_run_at=? WHERE tenant_id=? AND id=?")
        .run(new Date(Date.now() - 1_000).toISOString(), "test", scout.id);
      assert.equal(await worker.runOnce(), true);
      assert.equal(runtime.scouts.get("test", scout.id)?.consecutiveFailures, expectedFailures);
    }

    // Simulate a process loss after the work order became terminal but before
    // its scout projection was synchronized. Restart reconciliation must count
    // this exact failure once, stop the schedule, and create the repair item.
    runtime.store.db.prepare("UPDATE scouts SET next_run_at=? WHERE tenant_id=? AND id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), "test", scout.id);
    assert.equal(runtime.scouts.materializeDue("test"), 1);
    const thirdRun = runtime.scouts.runs("test", scout.id)[0];
    assert.ok(thirdRun);
    runtime.workOrders.failClosed("test", thirdRun.workOrderId, "The selected calendar dependency remained unavailable.");
    assert.equal(runtime.scouts.get("test", scout.id)?.consecutiveFailures, 2);
    runtime.close();
    runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([provider]) });
    registerSensor();
    assert.equal(runtime.scouts.materializeDue("test"), 0);
    assert.equal(runtime.scouts.get("test", scout.id)?.status, "repair_required");
    assert.equal(runtime.scouts.get("test", scout.id)?.consecutiveFailures, 3);
    assert.equal(runtime.scouts.runs("test", scout.id).length, 3);
    assert.equal(runtime.store.listEvents("test", { type: "scout.repair_required" }).length, 1);
    assert.equal(runtime.office.listAttention("test", "open").filter((item) => item.title === "Calendar watch needs repair").length, 1);
    runtime.store.db.prepare("UPDATE scouts SET next_run_at=? WHERE tenant_id=? AND id=?")
      .run(new Date(Date.now() - 60_000).toISOString(), "test", scout.id);
    assert.equal(runtime.scouts.materializeDue("test"), 0, "repair-required scouts do not admit endless scheduled work");
    assert.equal(runtime.scouts.runs("test", scout.id).length, 3);
    assert.throws(() => runtime.scouts.transition("test", scout.id, "active"), /operator repair acknowledgment/);

    assert.equal(runtime.scouts.runs("test", scout.id).length, 3, "restart preserves every failed run");
    assert.equal(runtime.scouts.materializeDue("test"), 0);
    assert.equal(await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce(), true, "the orphaned terminal work job is safely drained");
    assert.equal(runtime.scouts.get("test", scout.id)?.status, "repair_required");
    assert.equal(runtime.scouts.runs("test", scout.id).length, 3);

    const resumed = runtime.scouts.resumeAfterRepair("test", scout.id);
    assert.equal(resumed.status, "active");
    assert.equal(resumed.consecutiveFailures, 0);
    assert.equal(runtime.office.listAttention("test", "open").filter((item) => item.title === "Calendar watch needs repair").length, 0);
    assert.equal(runtime.office.listAttention("test", "acted").filter((item) => item.title === "Calendar watch needs repair").length, 1);
    assert.equal(runtime.store.listEvents("test", { type: "scout.repair_acknowledged" }).length, 1);

    assert.equal(await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce(), true);
    assert.equal(runtime.scouts.runs("test", scout.id).length, 4);
    assert.equal(runtime.scouts.get("test", scout.id)?.status, "active");
    assert.equal(runtime.scouts.get("test", scout.id)?.consecutiveFailures, 1);
    assert.equal(runtime.store.listEvents("test", { type: "scout.run_needs_input" }).length, 3);
    assert.equal(runtime.store.listEvents("test", { type: "scout.run_failed" }).length, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a preserved legacy scout cannot run or resume until an operator pins an assigned release", () => {
  const home = testHome();
  const config = testConfig(home.path);
  let runtime = new CoRuntime({ config });
  try {
    const originalReleaseId = runtime.releases.assign("test").release.id;
    const session = runtime.store.ensureSession("test", "internal", "legacy-scout");
    const source = runtime.store.appendEvent({
      tenantId: "test", stream: `session:${session.id}`, type: "message.received",
      payload: { text: "This scout predates behavior-release pinning." },
    });
    const scout = runtime.scouts.create({
      tenantId: "test", sourceEventId: source.id, sessionId: session.id, releaseId: originalReleaseId,
      name: "Preserved legacy watch", objective: "Watch one bounded source under known behavior.",
      readToolName: "sensor.read", readArguments: {}, intervalMinutes: 60,
      firstRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    runtime.store.db.prepare("UPDATE scouts SET release_id=NULL WHERE tenant_id=? AND id=?").run("test", scout.id);
    runtime.close();

    runtime = new CoRuntime({ config });
    assert.equal(runtime.scouts.materializeDue("test"), 0);
    const held = runtime.scouts.get("test", scout.id);
    assert.equal(held?.status, "repair_required");
    assert.equal(held?.releaseId, undefined);
    assert.equal(runtime.scouts.runs("test", scout.id).length, 0);
    assert.equal(runtime.store.listJobs("test").filter((job) => job.type === "work.execute").length, 0);
    assert.equal(runtime.store.listEvents("test", { type: "scout.release_binding_required" }).length, 1);
    assert.equal(runtime.office.listAttention("test", "open").filter((item) => item.title === "Preserved legacy watch needs a behavior release").length, 1);
    assert.throws(() => runtime.scouts.resumeAfterRepair("test", scout.id), /explicitly bound/);
    assert.throws(() => runtime.scouts.resumeAfterRepair("test", scout.id, "rel_unassigned"), /never assigned/);

    const resumed = runtime.scouts.resumeAfterRepair("test", scout.id, originalReleaseId);
    assert.equal(resumed.status, "active");
    assert.equal(resumed.releaseId, originalReleaseId);
    const repaired = runtime.store.listEvents("test", { type: "scout.repair_acknowledged" }).at(-1);
    const repairedPayload = repaired?.payload as JsonObject | undefined;
    assert.equal(repairedPayload?.releaseBoundDuringRepair, true);
    assert.equal(repairedPayload?.releaseId, originalReleaseId);
    assert.equal(runtime.office.listAttention("test", "open").filter((item) => item.title === "Preserved legacy watch needs a behavior release").length, 0);
    assert.equal(runtime.scouts.materializeDue("test"), 1);
    const admitted = runtime.store.listJobs("test").find((job) => job.type === "work.execute");
    assert.equal(admitted?.releaseId, originalReleaseId);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("recurring scout work stays pinned to the release that created the scout", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const original = runtime.releases.assign("test").release;
    const session = runtime.store.ensureSession("test", "internal", "release-scout");
    const source = runtime.store.appendEvent({
      tenantId: "test", stream: "conversation", type: "message.received", payload: { text: "Keep watching under this behavior release." },
    });
    const scout = runtime.scouts.create({
      tenantId: "test", sourceEventId: source.id, sessionId: session.id, releaseId: original.id,
      name: "Release-pinned watch", objective: "Watch one selected source without silently changing behavior.",
      readToolName: "sensor.read", readArguments: {}, intervalMinutes: 60,
      firstRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const next = runtime.releases.stage("test", {
      ...original.manifest, label: "later behavior", systemPrompt: `${original.manifest.systemPrompt}\nLater behavior revision.`,
    });
    runtime.releases.canary("test", next.id, 5_000);
    runtime.releases.promote("test", next.id);
    assert.equal(runtime.releases.assign("test").release.id, next.id);

    assert.equal(runtime.scouts.materializeDue("test"), 1);
    const scoutRun = runtime.scouts.runs("test", scout.id)[0];
    assert.ok(scoutRun);
    const job = runtime.store.listJobs("test").find((candidate) => candidate.type === "work.execute"
      && candidate.payload.workOrderId === scoutRun.workOrderId);
    assert.equal(runtime.scouts.get("test", scout.id)?.releaseId, original.id);
    assert.equal(job?.releaseId, original.id);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("event wakeups are durable, coalesced, and catch up once when a change lands during the snapshot read", async () => {
  const home = testHome();
  let scoutId = "";
  let injectDuringRead = true;
  const provider: ProviderAdapter = {
    name: "mock",
    complete: async (request) => {
      const toolResults = results(request);
      if (!toolResults.some((item) => item.name === "mail.read")) {
        return response([{ type: "tool_call", id: "mail-read", name: "mail.read", arguments: { label: "inbox" } }]);
      }
      if (!toolResults.some((item) => item.name === "scout.observation.record")) {
        return response([{ type: "tool_call", id: "mail-observation", name: "scout.observation.record",
          arguments: { scoutId, retrievalToolCallId: "mail-read", summary: "The selected inbox snapshot was read completely and its current state was recorded." } }]);
      }
      return response([], "The source snapshot and observation are complete.");
    },
  };
  const runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([provider]) });
  runtime.tools.register({
    definition: { name: "mail.read", description: "Read the selected inbox snapshot.", inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false },
      risk: "read", tags: ["mcp", "email", "scout-source"], idempotent: true },
    execute: async () => {
      if (injectDuringRead) {
        injectDuringRead = false;
        const source = runtime.store.appendEvent({ tenantId: "test", stream: "source:mail", type: "mail.changed", payload: { delivery: 3 } });
        runtime.scouts.wake({ tenantId: "test", scoutId, sourceEventId: source.id, sourceCursor: "cursor-3" });
      }
      return { messages: [{ id: "mail-1", subject: "Time-sensitive reply" }] };
    }, evaluateResult: successfulToolResult,
  });
  try {
    const session = runtime.store.ensureSession("test", "imessage", "+15555550100");
    const origin = runtime.store.appendEvent({ tenantId: "test", stream: "conversation", type: "message.received", payload: { text: "Watch this inbox quietly." } });
    const scout = runtime.scouts.create({ tenantId: "test", sourceEventId: origin.id, sessionId: session.id,
      releaseId: runtime.releases.assign("test").release.id, name: "Inbox changes", objective: "Read the selected inbox after source notifications and assess only material changes.",
      readToolName: "mail.read", readArguments: { label: "inbox" }, intervalMinutes: 15, wakeMode: "event",
      firstRunAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() });
    scoutId = scout.id;
    const firstSource = runtime.store.appendEvent({ tenantId: "test", stream: "source:mail", type: "mail.changed", payload: { delivery: 1 } });
    const secondSource = runtime.store.appendEvent({ tenantId: "test", stream: "source:mail", type: "mail.changed", payload: { delivery: 2 } });
    assert.deepEqual(runtime.scouts.wake({ tenantId: "test", scoutId, sourceEventId: firstSource.id, sourceCursor: "cursor-1" }),
      { accepted: true, coalesced: false, scout: runtime.scouts.get("test", scoutId) });
    assert.equal(runtime.scouts.wake({ tenantId: "test", scoutId, sourceEventId: secondSource.id, sourceCursor: "cursor-2" }).coalesced, true);
    assert.equal(runtime.scouts.wake({ tenantId: "test", scoutId, sourceEventId: firstSource.id, sourceCursor: "cursor-1" }).accepted, false);
    assert.equal(runtime.scouts.get("test", scoutId)?.wakeGeneration, 2);
    assert.equal(runtime.scouts.materializeDue("test"), 1);
    assert.equal(runtime.scouts.runs("test", scoutId)[0]?.triggerKind, "event");

    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    assert.equal(await worker.runOnce(), true);
    const afterRead = runtime.scouts.get("test", scoutId)!;
    assert.equal(afterRead.wakeGeneration, 3);
    assert.equal(afterRead.processedWakeGeneration, 2, "the read acknowledges only event generations present when it was admitted");
    assert.equal(afterRead.sourceCursor, "cursor-3");
    assert.equal(runtime.scouts.materializeDue("test"), 1, "one catch-up snapshot is admitted after the in-flight event");
    assert.equal(runtime.scouts.runs("test", scoutId)[0]?.triggerKind, "catch_up");
    assert.equal(runtime.scouts.runs("test", scoutId).length, 2);
    assert.equal(runtime.store.listEvents("test", { type: "scout.source_wake_accepted" }).length, 3);
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_accepted" }).length, 0);
    assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM outbound_deliveries WHERE tenant_id=?").get("test")!.count, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("source health distinguishes quiet success from failure and expiry stops work without messaging", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const session = runtime.store.ensureSession("test", "internal", "health-fixture");
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "conversation", type: "message.received", payload: { text: "Watch this temporarily." } });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const scout = runtime.scouts.create({ tenantId: "test", sourceEventId: source.id, sessionId: session.id,
      releaseId: runtime.releases.assign("test").release.id, name: "Temporary watch", objective: "Watch one bounded source only until its useful window closes.",
      readToolName: "sensor.read", readArguments: {}, intervalMinutes: 15, freshnessMinutes: 30, expiresAt });
    assert.equal(runtime.scouts.health(scout), "never_synced");
    runtime.store.db.prepare("UPDATE scouts SET last_success_at=? WHERE tenant_id=? AND id=?")
      .run(new Date(Date.now() - 31 * 60_000).toISOString(), "test", scout.id);
    assert.equal(runtime.scouts.health(runtime.scouts.get("test", scout.id)!), "stale");
    runtime.store.db.prepare("UPDATE scouts SET last_success_at=?,consecutive_failures=1 WHERE tenant_id=? AND id=?")
      .run(new Date().toISOString(), "test", scout.id);
    assert.equal(runtime.scouts.health(runtime.scouts.get("test", scout.id)!), "degraded");
    const repairEvent = runtime.store.appendEvent({ tenantId: "test", stream: `scout:${scout.id}`, type: "scout.repair_required", payload: { scoutId: scout.id } });
    runtime.office.raiseAttention({ tenantId: "test", sourceEventId: repairEvent.id, title: "Temporary watch needs repair",
      content: "The temporary source is unavailable.", reason: "Repair only while the watch remains useful.", mode: "hold", priority: 80 });
    assert.equal(runtime.scouts.expireDue("test", new Date(Date.now() + 61_000).toISOString()), 1);
    const expired = runtime.scouts.get("test", scout.id)!;
    assert.equal(expired.status, "expired");
    assert.equal(runtime.scouts.health(expired), "expired");
    assert.equal(runtime.scouts.materializeDue("test"), 0);
    assert.equal(runtime.office.listAttention("test", "open").length, 0);
    assert.equal(runtime.office.listAttention("test", "dismissed").filter((item) => item.title === "Temporary watch needs repair").length, 1);
    assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM outbound_deliveries WHERE tenant_id=?").get("test")!.count, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("the authenticated source-wake API persists and deduplicates hints without bypassing the snapshot read", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  const server = createRuntimeServer(runtime);
  try {
    const session = runtime.store.ensureSession("test", "internal", "api-wake-fixture");
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "conversation", type: "message.received", payload: { text: "Watch the source through its event feed." } });
    const scout = runtime.scouts.create({ tenantId: "test", sourceEventId: source.id, sessionId: session.id,
      releaseId: runtime.releases.assign("test").release.id, name: "Event source", objective: "Use source hints to trigger one bounded authoritative snapshot read.",
      readToolName: "sensor.read", readArguments: {}, intervalMinutes: 60, wakeMode: "event",
      firstRunAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = () => fetch(`${base}/v1/scouts/${scout.id}/wakes`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ externalId: "provider-delivery-1", type: "mail.changed", cursor: "opaque-provider-cursor", payload: { mailbox: "inbox" } }) });
    const first = await request();
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json() as { accepted: boolean; duplicate: boolean; coalesced: boolean },
      { accepted: true, duplicate: false, coalesced: false, scout: runtime.scouts.asJson(runtime.scouts.get("test", scout.id)!) });
    const duplicate = await request();
    assert.equal(duplicate.status, 202);
    const duplicateBody = await duplicate.json() as { accepted: boolean; duplicate: boolean; coalesced: boolean };
    assert.equal(duplicateBody.accepted, false);
    assert.equal(duplicateBody.duplicate, true);
    assert.equal(duplicateBody.coalesced, true);
    const retainedHint = runtime.store.listEvents("test", { type: "mail.changed" }).at(-1);
    assert.ok(retainedHint);
    assert.equal(JSON.stringify(retainedHint.payload).includes("mailbox"), false, "raw provider hint content is not retained");
    assert.match(String((retainedHint.payload as JsonObject).payloadDigest), /^[a-f0-9]{64}$/);
    const rebound = await fetch(`${base}/v1/scouts/${scout.id}/wakes`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ externalId: "provider-delivery-1", type: "mail.changed", cursor: "different-cursor", payload: { mailbox: "inbox" } }) });
    assert.equal(rebound.status, 409);
    assert.equal(runtime.scouts.get("test", scout.id)?.sourceCursor, "opaque-provider-cursor");
    assert.equal(runtime.scouts.runs("test", scout.id).length, 0, "a hint does not pretend the source has been read");
    assert.equal(runtime.store.listJobs("test").filter((job) => job.type === "ambient.evaluate").length, 0,
      "source hints do not create one inference job per event");
    assert.equal(runtime.scouts.materializeDue("test"), 1);
    assert.equal(runtime.scouts.runs("test", scout.id)[0]?.triggerKind, "event");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    home.cleanup();
  }
});

test("a v54 scout database gains wake state additively without losing its prior watch", () => {
  const home = testHome();
  const path = `${home.path}/runtime.sqlite`;
  let store = new SqliteStore(path);
  try {
    const session = store.ensureSession("test", "internal", "migration-fixture");
    const source = store.appendEvent({ id: "evt_before_source_health", tenantId: "test", stream: "conversation", type: "message.received", payload: { text: "Keep the old watch." } });
    const current = new Date().toISOString();
    store.db.prepare(`INSERT INTO scouts(
      id,tenant_id,idempotency_key,name,objective,status,read_tool_name,read_arguments_json,interval_minutes,next_run_at,
      source_event_id,session_id,release_id,wake_mode,freshness_minutes,consecutive_failures,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "sct_preserved", "test", "preserved", "Preserved watch", "Keep the old bounded source watch intact.", "paused",
      "sensor.read", "{}", 60, current, source.id, session.id, null, "poll", 180, 0, current, current,
    );
    store.db.exec(`
      DROP INDEX scouts_tenant_expiry;
      ALTER TABLE scouts DROP COLUMN processed_wake_generation;
      ALTER TABLE scouts DROP COLUMN wake_generation;
      ALTER TABLE scouts DROP COLUMN last_source_seq;
      ALTER TABLE scouts DROP COLUMN source_watermark_at;
      ALTER TABLE scouts DROP COLUMN source_cursor;
      ALTER TABLE scouts DROP COLUMN last_attempt_at;
      ALTER TABLE scouts DROP COLUMN expires_at;
      ALTER TABLE scouts DROP COLUMN freshness_minutes;
      ALTER TABLE scouts DROP COLUMN wake_mode;
      ALTER TABLE scout_runs DROP COLUMN wake_generation;
      ALTER TABLE scout_runs DROP COLUMN trigger_kind;
      DELETE FROM schema_migrations WHERE version=55;
      PRAGMA user_version=54;
    `);
    assert.ok(session.id && source.id);
    store.close();
    store = new SqliteStore(path);
    assert.equal(store.schemaVersion(), CURRENT_SCHEMA_VERSION);
    assert.ok(store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=55").get());
    assert.ok(store.getEvent("test", "evt_before_source_health"));
    const preserved = store.db.prepare("SELECT name,wake_mode,freshness_minutes FROM scouts WHERE tenant_id=? AND id=?").get("test", "sct_preserved") as { name: string; wake_mode: string; freshness_minutes: number };
    assert.equal(preserved.name, "Preserved watch");
    assert.equal(preserved.wake_mode, "poll");
    assert.equal(preserved.freshness_minutes, 180);
  } finally {
    store.close();
    home.cleanup();
  }
});
