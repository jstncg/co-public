import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { DependencyError } from "../src/dependency-errors.ts";
import type { ConnectorAdapter } from "../src/connectors.ts";
import { OpenAIProvider, ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import type { ProviderAdapter, ProviderRequest, RunState } from "../src/types.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { stableId } from "../src/id.ts";
import { writeFileDurably } from "../src/tools.ts";
import { testConfig, testHome } from "./helpers.ts";

function providerRequest(): ProviderRequest {
  return {
    route: { provider: "openai", model: "test", maxOutputTokens: 128, reasoningEffort: "none" },
    system: "test", messages: [], tools: [], tenantId: "test",
  };
}

function durableState(): RunState {
  return {
    system: "reliability test", messages: [], authorityToolNames: [], toolNames: [],
    modelRoute: { provider: "mock", model: "mock-1", maxOutputTokens: 128, reasoningEffort: "none" },
    iteration: 0, pendingCalls: [], nextToolIndex: 0, depth: 0, tokenBudget: 1_000,
  };
}

test("durable file replacement distinguishes pre-effect failure from post-rename uncertainty", () => {
  const home = testHome();
  const path = resolve(home.path, "durable-write.txt");
  try {
    assert.throws(() => writeFileDurably(path, "new durable content", {
      syncDirectory: () => { throw new Error("simulated directory fsync crash"); },
    }), (error: unknown) => error instanceof DependencyError && error.uncertain && !error.retryable);
    assert.equal(readFileSync(path, "utf8"), "new durable content", "the rename happened, so retry would risk repeating an already-applied effect");
    assert.equal(readdirSync(home.path).some((name) => name.endsWith(".tmp")), false);

    assert.throws(() => writeFileDurably(path, "must not replace", {
      rename: () => { throw new Error("simulated failure before rename"); },
    }), /before rename/);
    assert.equal(readFileSync(path, "utf8"), "new durable content", "a pre-rename failure leaves the old destination intact");
    assert.equal(readdirSync(home.path).some((name) => name.endsWith(".tmp")), false);
  } finally {
    home.cleanup();
  }
});

test("process failure is a failed receipt and cannot prove work-order completion", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.execution = {
    backend: "local", allowedCommands: [process.execPath], timeoutMs: 5_000, maxOutputBytes: 10_000, workspaceMode: "read-only",
  };
  config.autonomy.autoApproveRisks = [...config.autonomy.autoApproveRisks, "destructive"];
  const runtime = new CoRuntime({ config });
  try {
    const objective = `[[tool:process.run ${JSON.stringify({ command: process.execPath, args: ["-e", "process.exit(7)"], cwd: home.path })}]]`;
    const admission = await runtime.submitWorkOrder({
      objective, successContract: "The command exits successfully.", evidencePolicy: "tool",
      allowedTools: ["process.run"], requiredToolNames: ["process.run"],
    });
    await new RuntimeWorker(runtime, { videoAnalyzer: null }).drain(10);
    const workOrder = runtime.workOrders.get("test", admission.workOrder.id);
    assert.equal(workOrder?.status, "needs_input");
    assert.ok(workOrder?.runId);
    const receipt = runtime.store.db.prepare("SELECT status,effect_state,output_json,error FROM tool_receipts WHERE run_id=?")
      .get(workOrder.runId) as { status: string; effect_state: string; output_json: string; error: string };
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.effect_state, "failed");
    assert.equal((JSON.parse(receipt.output_json) as { exitCode: number }).exitCode, 7);
    assert.match(receipt.error, /code 7/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("rejected delegation is a failed semantic outcome rather than successful evidence", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const result = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "owner", text: '[[tool:delegate_task {"objective":"missing deliverable"}]]',
    });
    const receipt = runtime.store.db.prepare("SELECT status,error FROM tool_receipts WHERE run_id=?")
      .get(result.runId) as { status: string; error: string };
    assert.equal(receipt.status, "failed");
    assert.match(receipt.error, /requires objective and deliverable/);
    assert.equal(runtime.agents.list("test").length, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("accepted delegation cannot prove that delegated work is complete", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const admission = await runtime.submitWorkOrder({
      objective: '[[tool:delegate_task {"objective":"Research it","deliverable":"A cited answer","allowedTools":[]}]]',
      successContract: "The delegated research is complete.", evidencePolicy: "tool",
      allowedTools: ["delegate_task"], requiredToolNames: ["delegate_task"],
    });
    await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce();
    const workOrder = runtime.workOrders.get("test", admission.workOrder.id);
    assert.equal(workOrder?.status, "needs_input");
    assert.ok(workOrder?.runId);
    const receipt = runtime.store.db.prepare("SELECT status,evidence_scope,effect_state FROM tool_receipts WHERE run_id=?")
      .get(workOrder.runId) as { id?: string; status: string; evidence_scope: string; effect_state: string };
    assert.deepEqual({ ...receipt }, { status: "succeeded", evidence_scope: "request", effect_state: "accepted" });
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("operator reconciliation repairs an accepted effect and its evidence-gated work order without erasing history", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const admission = await runtime.submitWorkOrder({
      objective: '[[tool:delegate_task {"objective":"Research it","deliverable":"A cited answer","allowedTools":[]}]]',
      successContract: "The delegated result was independently inspected.", evidencePolicy: "tool",
      allowedTools: ["delegate_task"], requiredToolNames: ["delegate_task"],
    });
    await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce();
    const before = runtime.workOrders.get("test", admission.workOrder.id);
    assert.equal(before?.status, "needs_input");
    assert.ok(before?.runId);
    const receipt = runtime.store.db.prepare("SELECT id,status,effect_state FROM tool_receipts WHERE tenant_id=? AND run_id=?")
      .get("test", before.runId) as { id: string; status: string; effect_state: string };
    assert.deepEqual({ ...receipt }, { id: receipt.id, status: "succeeded", effect_state: "accepted" });
    runtime.store.db.prepare("UPDATE tool_receipts SET output_json='{' WHERE tenant_id=? AND id=?").run("test", receipt.id);
    assert.ok(runtime.store.scanCorruptJsonRows("test", 50) >= 1);
    const quarantinedReceipt = runtime.store.getReceiptById("test", receipt.id);
    assert.equal(quarantinedReceipt?.status, "uncertain");
    assert.equal(quarantinedReceipt?.effectState, "uncertain");
    assert.equal(quarantinedReceipt?.output, undefined);

    const reconciled = runtime.reconcileToolReceipt({
      receiptId: receipt.id,
      decision: "confirmed",
      reason: "Operator inspected the retained child output and confirmed the contracted result.",
      evidence: { inspection: "manual", retainedChild: true },
      output: { status: "completed", inspected: true },
    });
    assert.equal(reconciled.receipt.status, "succeeded");
    assert.equal(reconciled.receipt.effectState, "confirmed");
    assert.equal(reconciled.receipt.evidenceScope, "outcome");
    assert.equal(reconciled.workOrder?.status, "completed");
    const record = runtime.store.db.prepare(`SELECT decision,prior_status,prior_effect_state,reason,event_id
      FROM tool_receipt_reconciliations WHERE tenant_id=? AND receipt_id=?`).get("test", receipt.id) as Record<string, unknown>;
    assert.equal(record.decision, "confirmed");
    assert.equal(record.prior_status, "uncertain");
    assert.equal(record.prior_effect_state, "uncertain");
    assert.match(String(record.reason), /inspected/);
    assert.ok(runtime.store.getEvent("test", String(record.event_id)));
    assert.equal(runtime.store.listEvents("test", { type: "tool.receipt_reconciled" }).length, 1);
    assert.throws(() => runtime.reconcileToolReceipt({ receiptId: receipt.id, decision: "failed", reason: "conflict" }), /already reconciled/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("an effect claim is atomic and a replacement lease cannot claim the same call", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const session = runtime.store.ensureSession("test", "internal", "effect-fence");
    const old = new Date(Date.now() - 60_000).toISOString();
    runtime.store.createRun({
      id: "run_effect_fence", tenantId: "test", sessionId: session.id, kind: "background", status: "running",
      modelRole: "background", input: "effect", state: durableState(), inputTokens: 0, outputTokens: 0, createdAt: old, updatedAt: old,
    });
    const firstLease = runtime.store.acquireRunLease("test", "run_effect_fence", 30_000);
    assert.ok(firstLease);
    const first = runtime.store.claimReceipt({
      tenantId: "test", runId: "run_effect_fence", runLeaseToken: firstLease, toolCallId: "call_once",
      toolName: "fixture.effect", arguments: { value: 1 }, risk: "external-write", idempotencyKey: "effect_stable",
    });
    assert.equal(first.claimed, true);
    assert.equal(first.receipt.effectState, "not_started");
    assert.equal(runtime.store.beginReceiptEffect(first.receipt.id, firstLease), true);
    runtime.store.db.prepare("UPDATE runs SET lease_expires_at=? WHERE id=?").run(old, "run_effect_fence");
    const replacementLease = runtime.store.acquireRunLease("test", "run_effect_fence", 30_000);
    assert.ok(replacementLease);
    const replacement = runtime.store.claimReceipt({
      tenantId: "test", runId: "run_effect_fence", runLeaseToken: replacementLease, toolCallId: "call_once",
      toolName: "fixture.effect", arguments: { value: 1 }, risk: "external-write", idempotencyKey: "effect_stable",
    });
    assert.equal(replacement.claimed, false);
    assert.equal(replacement.receipt.id, first.receipt.id);
    assert.equal(replacement.receipt.effectState, "accepted");
    assert.equal(runtime.store.beginReceiptEffect(first.receipt.id, replacementLease), false, "a replacement lease cannot initiate an accepted effect");
    assert.equal(runtime.store.finishReceipt({
      receiptId: first.receipt.id, leaseToken: firstLease, status: "succeeded", evidenceScope: "outcome", output: { delivered: true },
    }), true, "the sole effect owner may still record the observed outcome");
    assert.equal(runtime.store.getReceipt("test", "run_effect_fence", "call_once")?.status, "succeeded");
    assert.equal(runtime.store.getReceipt("test", "run_effect_fence", "call_once")?.effectState, "confirmed");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a replacement lease may reclaim an effect only while it is durably not started", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const session = runtime.store.ensureSession("test", "internal", "effect-resume");
    const old = new Date(Date.now() - 60_000).toISOString();
    runtime.store.createRun({
      id: "run_effect_resume", tenantId: "test", sessionId: session.id, kind: "background", status: "running",
      modelRole: "background", input: "effect", state: durableState(), inputTokens: 0, outputTokens: 0, createdAt: old, updatedAt: old,
    });
    const firstLease = runtime.store.acquireRunLease("test", "run_effect_resume", 30_000);
    assert.ok(firstLease);
    const first = runtime.store.claimReceipt({
      tenantId: "test", runId: "run_effect_resume", runLeaseToken: firstLease, toolCallId: "call_resume",
      toolName: "fixture.effect", arguments: { value: 1 }, risk: "external-write", idempotencyKey: "effect_resume",
    });
    assert.equal(first.receipt.effectState, "not_started");
    runtime.store.db.prepare("UPDATE runs SET lease_expires_at=? WHERE id=?").run(old, "run_effect_resume");
    const replacementLease = runtime.store.acquireRunLease("test", "run_effect_resume", 30_000);
    assert.ok(replacementLease);
    const replacement = runtime.store.claimReceipt({
      tenantId: "test", runId: "run_effect_resume", runLeaseToken: replacementLease, toolCallId: "call_resume",
      toolName: "fixture.effect", arguments: { value: 1 }, risk: "external-write", idempotencyKey: "effect_resume",
    });
    assert.equal(replacement.claimed, true);
    assert.equal(runtime.store.beginReceiptEffect(replacement.receipt.id, firstLease), false);
    assert.equal(runtime.store.beginReceiptEffect(replacement.receipt.id, replacementLease), true);
    assert.equal(runtime.store.finishReceipt({
      receiptId: replacement.receipt.id, leaseToken: replacementLease, status: "succeeded", evidenceScope: "outcome", output: { delivered: true },
    }), true);
    assert.equal(runtime.store.getReceipt("test", "run_effect_resume", "call_resume")?.effectState, "confirmed");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a corrupt stale run is quarantined losslessly and does not stop later jobs", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const session = runtime.store.ensureSession("test", "internal", "poison");
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    runtime.store.createRun({
      id: "run_poison", tenantId: "test", sessionId: session.id, kind: "background", status: "running",
      modelRole: "background", input: "poison", state: durableState(), inputTokens: 0, outputTokens: 0, createdAt: old, updatedAt: old,
    });
    runtime.store.db.prepare("UPDATE runs SET state_json='{',updated_at=? WHERE id=?").run(old, "run_poison");
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "test", type: "message.received", payload: { text: "remember that recovery continued" } });
    const later = runtime.store.enqueueJob("test", "memory.extract", { input: "remember that recovery continued", output: "", sourceEventId: source.id });
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });

    assert.equal(await worker.runOnce(), true);
    const quarantined = runtime.store.db.prepare("SELECT state_json FROM run_state_quarantine WHERE run_id=?").get("run_poison") as { state_json: string };
    assert.equal(quarantined.state_json, "{");
    assert.equal(runtime.store.getRun("run_poison", "test")?.status, "failed");
    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.store.getJob(later.id, "test")?.status, "completed");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("corrupt jobs, events, and projections become inspectable without stopping useful work", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const corruptEvent = runtime.store.appendEvent({ tenantId: "test", stream: "test", type: "fixture.corrupt", payload: { valid: true } });
    const artifact = runtime.office.prepareArtifact({
      tenantId: "test", kind: "brief", title: "Corrupt projection fixture", content: "Preserve the artifact.", sourceEventIds: [corruptEvent.id],
    });
    const corruptJob = runtime.store.enqueueJob("test", "memory.extract", { input: "bad", output: "", sourceEventId: corruptEvent.id });
    runtime.store.db.prepare("UPDATE events SET payload_json='{' WHERE id=?").run(corruptEvent.id);
    runtime.store.db.prepare("UPDATE prepared_artifacts SET source_event_ids_json='[' WHERE id=?").run(artifact.id);
    runtime.store.db.prepare("UPDATE jobs SET payload_json='{' WHERE id=?").run(corruptJob.id);

    const validSource = runtime.store.appendEvent({ tenantId: "test", stream: "test", type: "message.received", payload: { text: "remember that the worker continued" } });
    const validJob = runtime.store.enqueueJob("test", "memory.extract", { input: "remember that the worker continued", output: "", sourceEventId: validSource.id });
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.store.getJob(corruptJob.id, "test")?.status, "failed");
    assert.equal(runtime.store.getJob(validJob.id, "test")?.status, "completed");

    const incidents = runtime.store.db.prepare(`SELECT record_kind,field_name,raw_value FROM recovery_quarantine
      WHERE tenant_id=? ORDER BY record_kind,field_name`).all("test") as Array<{ record_kind: string; field_name: string; raw_value: string }>;
    assert.deepEqual(incidents.map((row) => [row.record_kind, row.field_name]), [
      ["events", "payload_json"], ["jobs", "payload_json"], ["prepared_artifacts", "source_event_ids_json"],
    ]);
    assert.deepEqual(incidents.map((row) => row.raw_value), ["{", "{", "["]);
    assert.equal((runtime.store.db.prepare("SELECT payload_json FROM events WHERE id=?").get(corruptEvent.id) as { payload_json: string }).payload_json, "{");
    assert.equal((runtime.store.db.prepare("SELECT source_event_ids_json FROM prepared_artifacts WHERE id=?").get(artifact.id) as { source_event_ids_json: string }).source_event_ids_json, "[");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a quarantined corrupt work job terminalizes its accepted work order", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const admission = await runtime.submitWorkOrder({ objective: "Do not orphan this accepted work.", evidencePolicy: "run" });
    runtime.store.db.prepare("UPDATE jobs SET payload_json='{' WHERE id=?").run(admission.jobId);
    runtime.store.db.prepare(`INSERT INTO recovery_quarantine(
      id,tenant_id,record_kind,record_id,field_name,raw_value,reason,quarantined_at,remediated_at
    ) VALUES(?,?,?,?,?,?,?,?,NULL)`).run(
      stableId("quarantine", `test:jobs:${admission.jobId}:payload_json`), "test", "jobs", admission.jobId,
      "payload_json", "{", "simulated crash after quarantine marker", new Date().toISOString(),
    );
    assert.ok(runtime.store.scanCorruptJsonRows("test", 50) >= 1);
    const job = runtime.store.db.prepare("SELECT status,subject_type,subject_id FROM jobs WHERE id=?")
      .get(admission.jobId) as { status: string; subject_type: string; subject_id: string };
    assert.equal(job.status, "failed");
    assert.equal(job.subject_type, "work.execute");
    assert.equal(job.subject_id, admission.workOrder.id);
    const work = runtime.workOrders.get("test", admission.workOrder.id);
    assert.equal(work?.status, "failed");
    assert.match(work?.failureReason ?? "", /Recovery blocked/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a transient provider failure leaves durable work resumable and the job retries", async () => {
  const home = testHome();
  let calls = 0;
  const adapter: ProviderAdapter = {
    name: "openai-compatible",
    complete: async () => {
      calls += 1;
      if (calls === 1) throw new DependencyError({ service: "fixture", kind: "rate_limited", message: "429", retryable: true, httpStatus: 429 });
      return { text: "completed after retry", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const config = testConfig(home.path);
  const route = { provider: "openai-compatible" as const, model: "fixture", baseUrl: "https://fixture.invalid", maxOutputTokens: 128, reasoningEffort: "none" as const };
  config.models = { foreground: route, deliberation: route, background: route, critic: route };
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([adapter]) });
  try {
    const admission = await runtime.submitWorkOrder({ objective: "Complete after a transient dependency failure.", evidencePolicy: "run" });
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.workOrders.get("test", admission.workOrder.id)?.status, "running");
    const job = runtime.store.listJobs("test").find((candidate) => candidate.type === "work.execute");
    assert.equal(job?.status, "queued");
    runtime.store.db.prepare("UPDATE jobs SET run_after=? WHERE id=?").run(new Date(Date.now() - 1_000).toISOString(), job?.id);
    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.workOrders.get("test", admission.workOrder.id)?.status, "completed");
    assert.equal(runtime.store.getJob(job?.id ?? "", "test")?.status, "completed");
    assert.equal(calls, 2);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a queued retry is the sole recovery owner and exhaustion terminalizes its run", async () => {
  const home = testHome();
  let calls = 0;
  const adapter: ProviderAdapter = {
    name: "openai-compatible",
    complete: async () => {
      calls += 1;
      throw new DependencyError({
        service: "fixture", kind: "rate_limited", message: "wait one hour", retryable: true,
        httpStatus: 429, retryAfterMs: 60 * 60_000,
      });
    },
  };
  const config = testConfig(home.path);
  const route = { provider: "openai-compatible" as const, model: "fixture", baseUrl: "https://fixture.invalid", maxOutputTokens: 128, reasoningEffort: "none" as const };
  config.models = { foreground: route, deliberation: route, background: route, critic: route };
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([adapter]) });
  try {
    const admission = await runtime.submitWorkOrder({ objective: "Fail within a bounded retry budget.", evidencePolicy: "run" });
    runtime.store.db.prepare("UPDATE jobs SET max_attempts=2 WHERE id=?").run(admission.jobId);
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    assert.equal(await worker.runOnce(), true);
    const firstJob = runtime.store.getJob(admission.jobId, "test");
    const work = runtime.workOrders.get("test", admission.workOrder.id);
    assert.equal(firstJob?.status, "queued");
    assert.equal(firstJob?.attempts, 1);
    assert.ok(Date.parse(firstJob?.runAfter ?? "") > Date.now() + 59 * 60_000);
    assert.ok(work?.runId);
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    runtime.store.db.prepare("UPDATE runs SET updated_at=? WHERE id=?").run(old, work.runId);
    assert.equal(await worker.runOnce(), false, "Retry-After blocks both stale recovery and job claim");
    assert.equal(calls, 1);

    runtime.store.db.prepare("UPDATE runs SET updated_at=?,resume_not_before=? WHERE id=?").run(old, old, work.runId);
    runtime.store.db.prepare("UPDATE jobs SET run_after=? WHERE id=?").run(old, admission.jobId);
    assert.equal(await worker.runOnce(), true);
    assert.equal(calls, 2, "the due job resumed the run exactly once");
    assert.equal(runtime.store.getJob(admission.jobId, "test")?.status, "failed");
    assert.equal(runtime.workOrders.get("test", admission.workOrder.id)?.status, "failed");
    assert.equal(runtime.store.getRun(work.runId, "test")?.status, "cancelled");
    runtime.store.db.prepare("UPDATE runs SET updated_at=? WHERE id=?").run(old, work.runId);
    assert.equal(await worker.runOnce(), false);
    assert.equal(calls, 2, "an exhausted run cannot escape its job budget through stale recovery");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("worker lease theft is detected and stale ownership recovers through the composed worker", async () => {
  const home = testHome();
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolveWait) => { release = resolveWait; });
  const providerStarted = new Promise<void>((resolveWait) => { started = resolveWait; });
  let calls = 0;
  const adapter: ProviderAdapter = {
    name: "openai-compatible",
    complete: async () => {
      calls += 1;
      if (calls === 1) {
        started();
        await blocked;
        return { text: '{"memories":[{"kind":"fact","statement":"stale worker wrote this memory","confidence":0.9,"salience":0.9}]}', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
      }
      return { text: '{"memories":[{"kind":"fact","statement":"replacement worker wrote this memory","confidence":0.9,"salience":0.9}]}', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const config = testConfig(home.path);
  const route = { provider: "openai-compatible" as const, model: "fixture", baseUrl: "https://fixture.invalid", maxOutputTokens: 128, reasoningEffort: "none" as const };
  config.models = { foreground: route, deliberation: route, background: route, critic: route };
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([adapter]) });
  try {
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "test", type: "message.received", payload: { text: "a transient memory" } });
    const job = runtime.store.enqueueJob("test", "memory.extract", { input: "a transient memory", output: "", sourceEventId: source.id });
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    const running = worker.runOnce();
    await providerStarted;
    runtime.store.db.prepare("UPDATE jobs SET lease_token='replacement',lease_expires_at=? WHERE id=?")
      .run(new Date(Date.now() + 60_000).toISOString(), job.id);
    const realLeaseCheck = runtime.store.hasActiveJobLease.bind(runtime.store);
    runtime.store.hasActiveJobLease = () => true;
    release();
    assert.equal(await running, true);
    runtime.store.hasActiveJobLease = realLeaseCheck;
    assert.equal(runtime.store.getJob(job.id, "test")?.status, "running");
    assert.equal(runtime.store.listEvents("test", { stream: `job:${job.id}` }).filter((event) => event.type === "job.lease_lost").length, 1);
    assert.equal(runtime.memory.list("test", { status: "active", limit: 20 }).some((memory) => memory.statement.includes("stale worker")), false);

    runtime.store.db.prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), job.id);
    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.store.getJob(job.id, "test")?.status, "completed");
    assert.equal(calls, 2);
    const memories = runtime.memory.list("test", { status: "active", limit: 20 });
    assert.equal(memories.some((memory) => memory.statement.includes("replacement worker")), true);
    assert.equal(memories.some((memory) => memory.statement.includes("stale worker")), false);
  } finally {
    release?.();
    runtime.close();
    home.cleanup();
  }
});

test("provider adapters classify 429s and malformed successful responses", async () => {
  const originalFetch = globalThis.fetch;
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test";
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "slow down" } }), {
      status: 429, headers: { "retry-after": "2" },
    });
    await assert.rejects(new OpenAIProvider().complete(providerRequest()), (error: unknown) => {
      assert.ok(error instanceof DependencyError);
      assert.equal(error.kind, "rate_limited");
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterMs, 2_000);
      return true;
    });

    globalThis.fetch = async () => new Response("not-json", { status: 200 });
    await assert.rejects(new OpenAIProvider().complete(providerRequest()), (error: unknown) => {
      assert.ok(error instanceof DependencyError);
      assert.equal(error.kind, "malformed_response");
      return true;
    });

    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("body stream disconnected")); },
    }), { status: 200 });
    await assert.rejects(new OpenAIProvider().complete(providerRequest()), (error: unknown) => {
      assert.ok(error instanceof DependencyError);
      assert.equal(error.kind, "network");
      assert.equal(error.retryable, true);
      assert.match(error.message, /body stream disconnected/);
      return true;
    });

    for (const [status, kind] of [[408, "unavailable"], [503, "unavailable"]] as const) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "temporary" } }), { status });
      await assert.rejects(new OpenAIProvider().complete(providerRequest()), (error: unknown) => {
        assert.ok(error instanceof DependencyError);
        assert.equal(error.kind, kind);
        assert.equal(error.retryable, true);
        return true;
      });
    }

    globalThis.fetch = async () => { throw new TypeError("connection reset"); };
    await assert.rejects(new OpenAIProvider().complete(providerRequest()), (error: unknown) => {
      assert.ok(error instanceof DependencyError);
      assert.equal(error.kind, "network");
      assert.equal(error.retryable, true);
      return true;
    });

    globalThis.fetch = async () => { throw Object.assign(new Error("deadline"), { name: "TimeoutError" }); };
    await assert.rejects(new OpenAIProvider().complete(providerRequest()), (error: unknown) => {
      assert.ok(error instanceof DependencyError);
      assert.equal(error.kind, "timeout");
      return true;
    });

    globalThis.fetch = async () => new Response(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }), { status: 200 });
    await assert.rejects(new OpenAIProvider().complete(providerRequest()), (error: unknown) => {
      assert.ok(error instanceof DependencyError);
      assert.match(error.message, /incomplete response/);
      assert.equal(error.retryable, false);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  }
});

test("definitively rejected connector delivery retries while ambiguous delivery is held for reconciliation", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  let attempts = 0;
  const connector: ConnectorAdapter = {
    id: "reliable",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "reliable", inboundConfigured: false, outboundConfigured: true }),
    verifyWebhook: () => false,
    parseWebhook: () => undefined,
    deliver: async () => {
      attempts += 1;
      if (attempts === 1) throw new DependencyError({ service: "fixture", kind: "rate_limited", message: "rejected", retryable: true, uncertain: false });
      return { provider: "reliable", messageId: `reliable-${attempts}` };
    },
  };
  runtime.connectors.register(connector);
  const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
  const deliver = (worker as unknown as {
    deliverConnector(tenantId: string, runId: string, channel: string, peerId: string, content: string, deliveryKey: string): Promise<void>;
  }).deliverConnector.bind(worker);
  try {
    await assert.rejects(deliver("test", "run_delivery_retry", "reliable", "peer", "hello", "retry"), /rejected/);
    await deliver("test", "run_delivery_retry", "reliable", "peer", "hello", "retry");
    assert.equal(attempts, 2);
    const events = runtime.store.listEvents("test", { stream: "run:run_delivery_retry" });
    assert.equal(events.filter((event) => event.type === "message.delivery_retryable_failure").length, 1);
    assert.equal(events.filter((event) => event.type === "message.delivery_accepted").length, 1);
    assert.equal(events.filter((event) => event.type === "message.delivery_uncertain").length, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a provider acceptance event repairs an expired delivery projection after a crash", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  let providerCalls = 0;
  runtime.connectors.register({
    id: "acceptance-crash",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "acceptance-crash", inboundConfigured: false, outboundConfigured: true }),
    verifyWebhook: () => false,
    parseWebhook: () => undefined,
    deliver: async () => { providerCalls += 1; return { provider: "acceptance-crash", messageId: "must-not-repeat" }; },
  });
  const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
  const deliver = (worker as unknown as {
    deliverConnector(tenantId: string, runId: string, channel: string, peerId: string, content: string, deliveryKey: string): Promise<string>;
  }).deliverConnector.bind(worker);
  try {
    const runId = "run_acceptance_crash";
    const channel = "acceptance-crash";
    const peerId = "peer";
    const content = "accepted before projection commit";
    const deliveryKey = "crash-boundary";
    const intentId = stableId("evt", `delivery-intent:test:${runId}:${channel}:${peerId}:${deliveryKey}`);
    const requestDigest = stableId("delivery", JSON.stringify({ channel, peerId, content, deliveryKey, replyTo: null }));
    const claim = runtime.store.claimOutboundDelivery({ tenantId: "test", intentId, requestDigest, channel, peerId }, 10);
    assert.equal(claim.state, "claimed");
    assert.ok(claim.claimToken);
    assert.equal(runtime.store.beginOutboundDelivery(intentId, "test", claim.claimToken), true);
    runtime.store.appendEvent({
      id: intentId, tenantId: "test", stream: `run:${runId}`, type: "message.delivery_started", correlationId: runId,
      payload: { channel, peerId, content, deliveryKey, replyTo: null, requestDigest },
    });
    const acceptance = runtime.store.appendEvent({
      tenantId: "test", stream: `run:${runId}`, type: "message.delivery_accepted", correlationId: runId, causationId: intentId,
      payload: { channel, peerId, deliveryKey, providerReceipt: { provider: channel, messageId: "accepted-1" } },
    });
    runtime.store.db.prepare("UPDATE outbound_deliveries SET lease_expires_at=? WHERE tenant_id=? AND intent_id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), "test", intentId);

    assert.equal(await deliver("test", runId, channel, peerId, content, deliveryKey), "accepted");
    assert.equal(providerCalls, 0);
    const row = runtime.store.db.prepare("SELECT state,acceptance_event_id,last_error FROM outbound_deliveries WHERE tenant_id=? AND intent_id=?")
      .get("test", intentId) as { state: string; acceptance_event_id: string; last_error: string | null };
    assert.equal(row.state, "accepted");
    assert.equal(row.acceptance_event_id, acceptance.id);
    assert.equal(row.last_error, null);
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_uncertain" }).length, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a legacy acceptance without an exact digest cannot silently accept rebound content", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  let providerCalls = 0;
  runtime.connectors.register({
    id: "legacy-rail",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "legacy-rail", inboundConfigured: false, outboundConfigured: true }),
    verifyWebhook: () => false,
    parseWebhook: () => undefined,
    deliver: async () => { providerCalls += 1; return { provider: "legacy-rail", messageId: "must-not-send" }; },
  });
  const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
  const deliver = (worker as unknown as {
    deliverConnector(tenantId: string, runId: string, channel: string, peerId: string, content: string, deliveryKey: string): Promise<string>;
  }).deliverConnector.bind(worker);
  try {
    const runId = "run_legacy_acceptance";
    const channel = "legacy-rail";
    const peerId = "peer";
    const deliveryKey = "legacy-key";
    const intentId = stableId("evt", `delivery-intent:test:${runId}:${channel}:${peerId}:${deliveryKey}`);
    runtime.store.appendEvent({
      id: intentId, tenantId: "test", stream: `run:${runId}`, type: "message.delivery_started", correlationId: runId,
      payload: { channel, peerId, content: "the historical content", deliveryKey },
    });
    runtime.store.appendEvent({
      tenantId: "test", stream: `run:${runId}`, type: "message.delivery_accepted", correlationId: runId, causationId: intentId,
      payload: { channel, peerId, deliveryKey, providerReceipt: { provider: channel, messageId: "legacy-provider-id" } },
    });

    assert.equal(await deliver("test", runId, channel, peerId, "rebound content", deliveryKey), "uncertain");
    assert.equal(providerCalls, 0);
    assert.equal(runtime.store.getOutboundDeliveryState("test", intentId), "uncertain");
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_uncertain" }).length, 1);
    await assert.rejects(deliver("test", runId, channel, peerId, "different rebound content", deliveryKey), /rebound to different content/i);
    assert.equal(providerCalls, 0);
    const reconciled = runtime.reconcileOutboundDelivery({
      intentId, decision: "failed", reason: "Provider ledger proves the historical ID was not the rebound content.",
      evidence: { providerMessageId: "legacy-provider-id", matchedContent: false },
    });
    assert.equal(reconciled.state, "failed");
    assert.equal(runtime.store.getOutboundDeliveryState("test", intentId), "failed");
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_accepted" }).length, 1,
      "reconciliation preserves the legacy receipt instead of rewriting history");
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_reconciled" }).length, 1);
    const failureHistory = runtime.store.db.prepare(`SELECT prior_state,decision,evidence_json
      FROM outbound_delivery_reconciliations WHERE tenant_id=? AND intent_id=?`).get("test", intentId) as {
        prior_state: string; decision: string; evidence_json: string;
      };
    assert.equal(failureHistory.prior_state, "uncertain");
    assert.equal(failureHistory.decision, "failed");
    assert.equal((JSON.parse(failureHistory.evidence_json) as { matchedContent: boolean }).matchedContent, false);
    await assert.rejects(deliver("test", runId, channel, peerId, "rebound content", deliveryKey), /proved this message failed|definitively rejected/i);
    assert.equal(providerCalls, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("an ambiguous proactive delivery is held and is never marked sent or retried", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  let attempts = 0;
  const connector: ConnectorAdapter = {
    id: "ambiguous",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "ambiguous", inboundConfigured: false, outboundConfigured: true }),
    verifyWebhook: () => false,
    parseWebhook: () => undefined,
    deliver: async () => {
      attempts += 1;
      throw new DependencyError({ service: "fixture", kind: "network", message: "socket closed after write", retryable: true, uncertain: true });
    },
  };
  runtime.connectors.register(connector);
  const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
  try {
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "calendar:return", type: "calendar.changed", payload: {} });
    const decision = worker.attention.evaluate("test", {
      sourceEventId: source.id, topicKey: "return-window", evidence: 2, novelty: 1, urgency: 1,
      usefulness: 1, actionability: 1, confidence: 0.99, interruptionCost: 0.01,
      content: "Your return window closes today.", channel: "ambiguous", peerId: "member",
    });
    assert.equal(decision.send, true);
    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), false);
    assert.equal(attempts, 1);
    const intervention = runtime.store.db.prepare("SELECT id,decision,sent_at FROM interventions WHERE tenant_id=? AND topic_key=?")
      .get("test", "return-window") as { id: string; decision: string; sent_at: string | null };
    assert.equal(intervention.decision, "held");
    assert.equal(intervention.sent_at, null);
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_uncertain" }).length, 1);
    assert.equal(runtime.office.listAttention("test").some((item) => /reconciliation/i.test(item.title)), true);

    const intentId = stableId("evt", `delivery-intent:test:intervention:${intervention.id}:ambiguous:member:intervention:${intervention.id}`);
    const reconciliation = runtime.reconcileOutboundDelivery({
      intentId, decision: "accepted", providerMessageId: "ambiguous-provider-verified",
      reason: "Operator found the exact provider message in the sent-message ledger.",
      evidence: { source: "provider-ledger", checkedAt: new Date().toISOString() },
    });
    assert.equal(reconciliation.state, "accepted");
    assert.equal(reconciliation.applied, true);
    assert.equal(runtime.store.getOutboundDeliveryState("test", intentId), "accepted");
    const terminalIntervention = runtime.store.db.prepare("SELECT decision,accepted_at,sent_at FROM interventions WHERE tenant_id=? AND id=?")
      .get("test", intervention.id) as { decision: string; accepted_at: string | null; sent_at: string | null };
    assert.equal(terminalIntervention.decision, "send");
    assert.ok(terminalIntervention.accepted_at);
    assert.equal(terminalIntervention.sent_at, null);
    const reconciliationRow = runtime.store.db.prepare(`SELECT decision,prior_state,provider_message_id,reason
      FROM outbound_delivery_reconciliations WHERE tenant_id=? AND intent_id=?`).get("test", intentId) as {
        decision: string; prior_state: string; provider_message_id: string; reason: string;
      };
    assert.deepEqual({ ...reconciliationRow }, {
      decision: "accepted", prior_state: "uncertain", provider_message_id: "ambiguous-provider-verified",
      reason: "Operator found the exact provider message in the sent-message ledger.",
    });
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_uncertain" }).length, 1);
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_reconciled" }).length, 1);
    assert.equal(runtime.office.listAttention("test").some((item) => /reconciliation/i.test(item.title)), false);
    const message = runtime.store.db.prepare("SELECT delivery_state,event_id FROM messages WHERE tenant_id=? AND event_id=?")
      .get("test", reconciliation.eventId) as { delivery_state: string; event_id: string };
    assert.equal(message.delivery_state, "accepted");
    assert.equal(message.event_id, reconciliation.eventId);
    const replay = runtime.reconcileOutboundDelivery({
      intentId, decision: "accepted", providerMessageId: "ambiguous-provider-verified",
      reason: "Repeat the same verified operator decision.",
    });
    assert.equal(replay.applied, false);
    assert.throws(() => runtime.reconcileOutboundDelivery({
      intentId, decision: "failed", reason: "Conflicting history rewrite.",
    }), /already reconciled as accepted/);
    assert.equal(await worker.runOnce(), false);
    assert.equal(attempts, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("an accepted promise is durably scheduled before acknowledgement and repairs itself when overdue", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  const deliveries: string[] = [];
  const connector: ConnectorAdapter = {
    id: "promise-rail",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "promise-rail", inboundConfigured: false, outboundConfigured: true }),
    verifyWebhook: () => false,
    parseWebhook: () => undefined,
    relationship: (peerId) => ({ channel: "imessage", peerId }),
    deliver: async (input) => { deliveries.push(input.content); return { provider: "promise-rail", messageId: "repair-1" }; },
  };
  runtime.connectors.register(connector);
  try {
    const session = runtime.store.ensureSession("test", "imessage", "member", { channel: "promise-rail", peerId: "member" });
    const source = runtime.store.appendEvent({ tenantId: "test", stream: `session:${session.id}`, type: "message.received", payload: { text: "check this later" } });
    const promise = runtime.office.acceptPromise({
      tenantId: "test", sourceEventId: source.id, sessionId: session.id, objective: "check the filing result", dueAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const scheduled = runtime.store.listJobs("test").find((job) => job.type === "promise.check");
    assert.ok(scheduled);
    assert.equal(runtime.store.listEvents("test", { stream: `promise:${promise.id}` }).some((event) => event.type === "promise.accepted"), true);

    runtime.store.db.prepare("UPDATE promises SET due_at=? WHERE id=?").run(new Date(Date.now() - 1_000).toISOString(), promise.id);
    runtime.store.db.prepare("UPDATE jobs SET run_after=? WHERE id=?").run(new Date(Date.now() - 1_000).toISOString(), scheduled.id);
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.office.getPromise("test", promise.id)?.status, "overdue");
    assert.equal(deliveries.length, 1);
    assert.match(deliveries[0] ?? "", /do not have proof that it is done/);
    assert.equal(runtime.office.listAttention("test").some((item) => item.title === "Accepted promise needs repair"), true);
    assert.equal(await worker.runOnce(), false);
    assert.equal(deliveries.length, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a corrupt promise-check payload is rebuilt from its normalized subject instead of silently breaking the promise", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const session = runtime.store.ensureSession("test", "cli", "promise-corruption");
    const source = runtime.store.appendEvent({ tenantId: "test", stream: `session:${session.id}`, type: "message.received", payload: { text: "check later" } });
    const promise = runtime.office.acceptPromise({ tenantId: "test", sourceEventId: source.id, sessionId: session.id, objective: "check the durable thing", dueAt: new Date(Date.now() + 60_000).toISOString() });
    const job = runtime.store.listJobs("test").find((candidate) => candidate.type === "promise.check");
    assert.ok(job);
    const dueAt = new Date(Date.now() - 1_000).toISOString();
    runtime.store.db.prepare("UPDATE promises SET due_at=? WHERE tenant_id=? AND id=?").run(dueAt, "test", promise.id);
    runtime.store.db.prepare("UPDATE jobs SET run_after=? WHERE tenant_id=? AND id=?").run(dueAt, "test", job.id);
    runtime.store.db.prepare("UPDATE jobs SET payload_json='{' WHERE tenant_id=? AND id=?").run("test", job.id);
    assert.ok(runtime.store.scanCorruptJsonRows("test", 50) >= 1);
    const repaired = runtime.store.getJob(job.id, "test");
    assert.equal(repaired?.status, "queued");
    assert.deepEqual(repaired?.payload, { promiseId: promise.id });
    assert.equal(await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce(), true);
    assert.equal(runtime.office.getPromise("test", promise.id)?.status, "overdue");
    assert.equal(runtime.office.listAttention("test").some((item) => item.title === "Accepted promise needs repair"), true);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("malformed evidence requirements fail closed without escaping the worker loop", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const admission = await runtime.submitWorkOrder({
      objective: "Read the clock.", successContract: "A clock receipt exists.", requiredToolNames: ["clock.now"],
    });
    runtime.store.db.prepare("UPDATE work_orders SET evidence_requirements_json=? WHERE id=?")
      .run(JSON.stringify({ version: 1, minimumReceipts: 1, requiredToolNames: "clock.now" }), admission.workOrder.id);
    runtime.store.db.prepare("UPDATE jobs SET max_attempts=1 WHERE id=?").run(admission.jobId);
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    assert.equal(await worker.runOnce(), true);
    const raw = runtime.store.db.prepare("SELECT status,failure_reason FROM work_orders WHERE id=?")
      .get(admission.workOrder.id) as { status: string; failure_reason: string };
    assert.equal(raw.status, "failed");
    assert.match(raw.failure_reason, /corrupt evidence requirements/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("the worker materializes expired goal deadlines without waiting for a matching event", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const goal = runtime.goals.create({
      tenantId: "test", objective: "Expire independently", successContract: "Manual confirmation",
      gateType: "manual", deadlineAt: new Date(Date.now() - 1_000).toISOString(),
    });
    assert.equal(runtime.store.listJobs("test").length, 0);
    assert.equal(await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce(), true);
    assert.equal(runtime.goals.get("test", goal.id)?.status, "failed");
    assert.match(runtime.goals.get("test", goal.id)?.lastGateReason ?? "", /deadline reached/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("child admission is bounded per run and per tenant independently of execution width", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.autonomy.maxChildrenPerRun = 2;
  config.autonomy.maxQueuedChildren = 2;
  const runtime = new CoRuntime({ config });
  try {
    const tasks = [1, 2, 3].map((number) => ({ objective: `Research ${number}`, deliverable: `Finding ${number}`, allowedTools: [] }));
    const result = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "owner",
      text: `[[tool:delegate_task ${JSON.stringify({ tasks })}]]`,
    });
    const receipt = runtime.store.db.prepare("SELECT status,output_json FROM tool_receipts WHERE run_id=?")
      .get(result.runId) as { status: string; output_json: string };
    const output = JSON.parse(receipt.output_json) as { admitted: number; agents: Array<{ status: string }> };
    assert.equal(receipt.status, "failed");
    assert.equal(output.admitted, 2);
    assert.equal(output.agents.filter((agent) => agent.status === "failed").length, 1);
    assert.equal(runtime.agents.list("test").length, 2);
    assert.equal(runtime.store.listJobs("test").filter((job) => job.type === "agent.turn" && job.status === "queued").length, 2);
  } finally {
    runtime.close();
    home.cleanup();
  }
});
