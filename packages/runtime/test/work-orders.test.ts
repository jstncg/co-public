import assert from "node:assert/strict";
import test from "node:test";
import { CoRuntime } from "../src/runtime.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { createRuntimeServer } from "../src/server.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { successfulToolResult } from "../src/tools.ts";
import type { ConnectorAdapter } from "../src/connectors.ts";
import type { ProviderAdapter } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

test("work orders execute asynchronously and require successful tool evidence by default", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const admission = await runtime.submitWorkOrder({
      objective: '[[tool:artifact.prepare {"kind":"brief","title":"Proof","content":"Verified local work."}]]',
      successContract: "A prepared artifact exists.", requiredToolNames: ["artifact.prepare"], idempotencyKey: "proof-1",
    });
    assert.equal(admission.workOrder.status, "queued");
    assert.equal(admission.duplicate, false);
    assert.equal((await runtime.submitWorkOrder({
      objective: '[[tool:artifact.prepare {"kind":"brief","title":"Proof","content":"Verified local work."}]]',
      successContract: "A prepared artifact exists.", requiredToolNames: ["artifact.prepare"], idempotencyKey: "proof-1",
    })).duplicate, true);

    const session = runtime.store.ensureSession("test", "imessage", "member");
    const source = runtime.store.appendEvent({
      tenantId: "test", stream: `session:${session.id}`, type: "message.received", payload: { text: "Tell me when the proof is ready." },
    });
    const promise = runtime.office.acceptPromise({
      tenantId: "test", sourceEventId: source.id, sessionId: session.id,
      objective: "tell the member when the proof is ready", dueAt: new Date(Date.now() + 60_000).toISOString(),
      workOrderId: admission.workOrder.id,
    });

    await new RuntimeWorker(runtime).drain(10);
    const completed = runtime.workOrders.get("test", admission.workOrder.id);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.evidenceIds.length, 1);
    assert.equal(runtime.office.listArtifacts("test").some((artifact) => artifact.title === "Proof"), true);
    assert.ok(completed?.runId);
    const workStarted = runtime.store.listEvents("test", { stream: `run:${completed?.runId}` })
      .find((event) => event.type === "run.started");
    const workInstruction = workStarted?.causationId ? runtime.store.getEvent("test", workStarted.causationId) : undefined;
    assert.equal(workInstruction?.type, "work.instruction_received");
    assert.equal(runtime.store.db.prepare("SELECT trust_class FROM evidence WHERE tenant_id=? AND source_event_id=?")
      .get("test", workInstruction?.id)?.trust_class, "agent", "runtime-authored work instructions cannot become owner evidence");
    assert.equal(runtime.store.listEvents("test", { stream: `work-order:${completed?.id}` }).some((event) => event.type === "work_order.completed"), true);
    assert.equal(runtime.office.getPromise("test", promise.id)?.status, "completed");
    assert.equal(runtime.store.listEvents("test", { stream: `promise:${promise.id}` }).some((event) => event.type === "promise.completed"), true);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("work orders do not call text-only output completion when receipts are required", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const admission = await runtime.submitWorkOrder({ objective: "Describe what you might do without using a tool.", requiredToolNames: ["clock.now"] });
    await new RuntimeWorker(runtime).drain(10);
    const workOrder = runtime.workOrders.get("test", admission.workOrder.id);
    assert.equal(workOrder?.status, "needs_input");
    assert.match(workOrder?.failureReason ?? "", /0\/1 required tool receipts/i);
    assert.deepEqual(workOrder?.evidenceIds, []);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a preparatory receipt cannot satisfy a contract requiring a different tool", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const admission = await runtime.submitWorkOrder({
      objective: "[[tool:artifact.list_prepared {}]]", successContract: "A new artifact is prepared.",
      allowedTools: ["artifact.list_prepared", "artifact.prepare"], requiredToolNames: ["artifact.prepare"],
    });
    await new RuntimeWorker(runtime).drain(10);
    const workOrder = runtime.workOrders.get("test", admission.workOrder.id);
    assert.equal(workOrder?.status, "needs_input");
    assert.equal(workOrder?.evidenceIds.length, 1, "the preparatory receipt remains visible");
    assert.match(workOrder?.failureReason ?? "", /missing successful receipts for artifact\.prepare/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("exact tool requirements still apply when a completed run is otherwise sufficient", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const admission = await runtime.submitWorkOrder({
      objective: "Return a bounded analysis without reading a file.", successContract: "The required source was inspected.",
      evidencePolicy: "run", allowedTools: ["file.read"], requiredToolNames: ["file.read"],
    });
    await new RuntimeWorker(runtime).drain(10);
    const workOrder = runtime.workOrders.get("test", admission.workOrder.id);
    assert.equal(workOrder?.status, "needs_input");
    assert.deepEqual(workOrder?.evidenceIds, [workOrder?.runId]);
    assert.match(workOrder?.failureReason ?? "", /missing successful receipts for file\.read/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("cancelling an in-flight work order fences its provider result", async () => {
  const home = testHome();
  let releaseProvider!: () => void;
  let markStarted!: () => void;
  const release = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const provider: ProviderAdapter = {
    name: "mock",
    complete: async () => {
      markStarted();
      await release;
      return { text: "late result", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([provider]) });
  try {
    const admission = await runtime.submitWorkOrder({ objective: "Wait for the provider.", evidencePolicy: "run" });
    const execution = runtime.executeWorkOrder(admission.workOrder.id);
    await started;
    const inFlight = runtime.workOrders.get("test", admission.workOrder.id);
    assert.ok(inFlight?.runId, "the run is bound before provider work starts");
    assert.equal(runtime.cancelWorkOrder(admission.workOrder.id).status, "cancelled");
    releaseProvider();
    const result = await execution;
    assert.equal(result.status, "cancelled");
    assert.equal(runtime.store.getRun(inFlight?.runId as string, "test")?.status, "cancelled");
    assert.equal(runtime.store.getRun(inFlight?.runId as string, "test")?.output, undefined);
  } finally {
    releaseProvider?.();
    runtime.close();
    home.cleanup();
  }
});

test("a foreground conversation can hand off durable work without widening its authority", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const objective = '[[tool:artifact.prepare {"kind":"brief","title":"Hand-off","content":"Prepared asynchronously."}]]';
    const request = `[[tool:work.submit ${JSON.stringify({ objective, successContract: "A prepared hand-off artifact exists.", evidencePolicy: "tool", requiredToolNames: ["artifact.prepare"] })}]]`;
    const turn = await runtime.turn({ tenantId: "test", channel: "sendblue", peerId: "peer", externalId: "handoff-1", text: request });
    assert.equal(turn.status, "completed");
    const admitted = runtime.workOrders.list("test");
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0]?.allowedTools.includes("work.submit"), false);
    await new RuntimeWorker(runtime).drain(20);
    assert.equal(runtime.workOrders.get("test", admitted[0]?.id as string)?.status, "completed");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("external work pauses for approval and only completes with an external-write receipt", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  runtime.tools.register({
    definition: {
      name: "fixture.send", description: "Send a fixture", inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false },
      risk: "external-write", tags: ["send", "external"], idempotent: true,
    },
    evaluateResult: successfulToolResult,
    execute: async (_context, arguments_) => ({ delivered: true, content: arguments_.content ?? null }),
  });
  try {
    const admission = await runtime.submitWorkOrder({
      objective: '[[tool:fixture.send {"content":"hello"}]]', successContract: "The message is delivered.",
      evidencePolicy: "external-write", allowedTools: ["fixture.send"], requiredToolNames: ["fixture.send"],
    });
    await new RuntimeWorker(runtime).drain(10);
    const waiting = runtime.workOrders.get("test", admission.workOrder.id);
    assert.equal(waiting?.status, "waiting_approval");
    assert.ok(waiting?.approvalId);
    const admittedJob = runtime.store.listJobs("test").find((job) => job.type === "work.execute");
    assert.equal(admittedJob?.status, "completed", "the admission job hands continuation to the durable approval instead of polling");
    const pendingApproval = runtime.store.getApproval(waiting?.approvalId as string);
    assert.equal(pendingApproval?.status, "pending");
    assert.equal(pendingApproval?.runId, waiting?.runId);
    await runtime.resumeApproval(waiting?.approvalId as string, "approved");
    const completed = runtime.workOrders.get("test", admission.workOrder.id);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.evidenceIds.length, 1);
    const receiptId = completed?.evidenceIds[0];
    assert.ok(receiptId);
    const receipt = runtime.store.db.prepare("SELECT risk,status,effect_state FROM tool_receipts WHERE id=?").get(receiptId) as { risk: string; status: string; effect_state: string };
    assert.equal(receipt.risk, "external-write");
    assert.equal(receipt.status, "succeeded");
    assert.equal(receipt.effect_state, "confirmed");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("run-only evidence cannot hide an unconfirmed consequential effect", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.autonomy.autoApproveRisks = [...config.autonomy.autoApproveRisks, "external-write"];
  const runtime = new CoRuntime({ config });
  runtime.tools.register({
    definition: {
      name: "fixture.queued", description: "Queue an external fixture", inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "external-write", tags: ["fixture", "queue"], idempotent: true,
    },
    execute: async () => ({ accepted: true, status: "queued" }),
    evaluateResult: () => ({ status: "succeeded", evidenceScope: "request" }),
  });
  try {
    const admission = await runtime.submitWorkOrder({
      objective: "[[tool:fixture.queued {}]]", successContract: "The external outcome is complete.", evidencePolicy: "run",
      allowedTools: ["fixture.queued"],
    });
    await new RuntimeWorker(runtime, { videoAnalyzer: null }).drain(10);
    const workOrder = runtime.workOrders.get("test", admission.workOrder.id);
    assert.equal(workOrder?.status, "needs_input");
    assert.match(workOrder?.failureReason ?? "", /unconfirmed consequential outcomes/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("connector-originated work returns approval and completion to the originating conversation", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  const deliveries: string[] = [];
  const connector: ConnectorAdapter = {
    id: "fixture",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "fixture", inboundConfigured: true, outboundConfigured: true }),
    verifyWebhook: () => true,
    parseWebhook: () => undefined,
    deliver: async (input) => { deliveries.push(input.content); return { provider: "fixture", messageId: `fixture-${deliveries.length}` }; },
  };
  runtime.connectors.register(connector);
  runtime.tools.register({
    definition: {
      name: "fixture.publish", description: "Publish a fixture", inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false },
      risk: "external-write", tags: ["publish", "external"], idempotent: true,
    },
    evaluateResult: successfulToolResult,
    execute: async () => ({ published: true }),
  });
  try {
    const objective = '[[tool:fixture.publish {"content":"release"}]]';
    const handoff = `[[tool:work.submit ${JSON.stringify({ objective, successContract: "The release is published.", evidencePolicy: "external-write", allowedTools: ["fixture.publish"], requiredToolNames: ["fixture.publish"] })}]]`;
    await runtime.turn({ tenantId: "test", channel: "fixture", peerId: "operator", externalId: "connector-work", text: handoff });
    const worker = new RuntimeWorker(runtime);
    await worker.runOnce();
    const waiting = runtime.workOrders.list("test")[0];
    assert.equal(waiting?.status, "waiting_approval");
    assert.match(deliveries[0] ?? "", new RegExp(`approve ${waiting?.approvalId}`));
    runtime.store.enqueueJob("test", "approval.decide", {
      approvalId: waiting?.approvalId as string, decision: "approved", channel: "fixture", peerId: "operator", externalId: "approval-message",
    });
    await worker.drain(10);
    assert.equal(runtime.workOrders.get("test", waiting?.id as string)?.status, "completed");
    assert.match(deliveries.at(-1) ?? "", /Done/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("work-order HTTP admission is asynchronous, idempotent, inspectable, and cancellable", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  const server = createRuntimeServer(runtime);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({ objective: "Do bounded work", evidencePolicy: "run", idempotencyKey: "api-proof" });
    const first = await fetch(`${base}/v1/work-orders`, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    assert.equal(first.status, 202);
    const admitted = await first.json() as { duplicate: boolean; workOrder: { workOrderId: string; status: string } };
    assert.equal(admitted.duplicate, false);
    assert.equal(admitted.workOrder.status, "queued");
    const duplicate = await fetch(`${base}/v1/work-orders`, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true);
    const inspected = await fetch(`${base}/v1/work-orders/${admitted.workOrder.workOrderId}`);
    assert.equal((await inspected.json() as { status: string }).status, "queued");
    const cancelled = await fetch(`${base}/v1/work-orders/${admitted.workOrder.workOrderId}/actions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }),
    });
    assert.equal((await cancelled.json() as { status: string }).status, "cancelled");
    assert.equal(runtime.store.listJobs("test").find((job) => job.type === "work.execute")?.status, "cancelled");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    home.cleanup();
  }
});
