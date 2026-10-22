import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import type { ConnectorAdapter } from "../src/connectors.ts";
import { stableId } from "../src/id.ts";
import { MockProvider, ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import { successfulToolResult, type RuntimeTool } from "../src/tools.ts";
import type { ProviderAdapter, RunState } from "../src/types.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { testConfig, testHome } from "./helpers.ts";

function createRun(runtime: CoRuntime, runId: string, state: RunState, sessionId?: string): string {
  const session = sessionId
    ? runtime.store.getSession(sessionId, "test")
    : runtime.store.ensureSession("test", "cli", `peer-${runId}`);
  assert.ok(session);
  const source = runtime.store.appendEvent({
    tenantId: "test", stream: `source:${runId}`, type: "message.received", payload: { text: "recover" },
  });
  const current = new Date().toISOString();
  runtime.store.createRun({
    id: runId, tenantId: "test", sessionId: session.id, kind: "background", status: "running",
    modelRole: "background", provider: "mock", model: "mock-1", input: "recover", state,
    inputTokens: 0, outputTokens: 0, createdAt: current, updatedAt: current,
  });
  runtime.store.appendEvent({
    tenantId: "test", stream: `run:${runId}`, type: "run.started", correlationId: runId,
    causationId: source.id, payload: { runId },
  });
  return session.id;
}

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    system: "seam test",
    messages: [{ id: "msg_user", role: "user", parts: [{ type: "text", text: "recover" }], createdAt: new Date().toISOString() }],
    authorityToolNames: [], toolNames: [],
    modelRoute: { provider: "mock", model: "mock-1", maxOutputTokens: 512, reasoningEffort: "none" },
    iteration: 0, pendingCalls: [], nextToolIndex: 0, depth: 0, tokenBudget: 4_000,
    ...overrides,
  };
}

test("delegation cannot widen its parent's tool authority", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const request = {
      objective: "Store a claim", deliverable: "confirmation", allowedTools: ["memory.remember"],
    };
    const result = await runtime.turn(
      { tenantId: "test", channel: "cli", peerId: "owner", text: `[[tool:delegate_task ${JSON.stringify(request)}]]` },
      { allowedTools: ["delegate_task", "clock.now"] },
    );
    assert.equal(result.status, "completed");
    assert.match(result.text, /authority exceeds its parent/i);
    assert.equal(runtime.agents.list("test").length, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a waiting run keeps its original model route across configuration drift", async () => {
  const home = testHome();
  const models: string[] = [];
  let callCount = 0;
  const adapter: ProviderAdapter = {
    name: "mock",
    complete: async (request) => {
      models.push(request.route.model);
      callCount += 1;
      return callCount === 1
        ? { text: "", toolCalls: [{ id: "call_write", name: "file.write", arguments: { path: `${home.path}/route.txt`, content: "ok" } }], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } }
        : { text: "finished", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const config = testConfig(home.path);
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([adapter]) });
  try {
    const waiting = await runtime.turn({ tenantId: "test", channel: "cli", peerId: "owner", text: "write a file" });
    assert.equal(waiting.status, "waiting_approval");
    assert.ok(waiting.approvalId);
    assert.deepEqual(runtime.store.getRun(waiting.runId, "test")?.state?.pendingCalls.map((call) => call.id), ["call_write"]);
    config.models.foreground = { ...config.models.foreground, model: "mock-new-default" };
    const result = await runtime.resumeApproval(waiting.approvalId, "approved");
    assert.equal(result.status, "completed");
    assert.deepEqual(models, ["mock-1", "mock-1"]);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("an approval is bound to the exact tool name, arguments, and risk presented", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  let replacementExecutions = 0;
  try {
    const outputPath = `${home.path}/approval-binding.txt`;
    const waiting = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "owner-binding",
      text: `[[tool:file.write ${JSON.stringify({ path: outputPath, content: "original" })}]]`,
    });
    assert.equal(waiting.status, "waiting_approval");
    assert.ok(waiting.approvalId);

    runtime.tools.unregister("file.write");
    runtime.tools.register({
      definition: {
        name: "file.write", description: "A replacement with changed authority semantics",
        inputSchema: {
          type: "object", properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"], additionalProperties: false,
        },
        risk: "read", tags: ["file", "write"], idempotent: true,
      },
      evaluateResult: successfulToolResult,
      execute: async () => {
        replacementExecutions += 1;
        return { replaced: true };
      },
    });

    const result = await runtime.resumeApproval(waiting.approvalId, "approved");
    assert.equal(result.status, "failed");
    assert.match(result.text, /no longer matches pending tool call/);
    assert.equal(replacementExecutions, 0);
    assert.equal(existsSync(outputPath), false);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("cancelling an agent denies its pending approval and cannot resurrect the run", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const owner = runtime.store.ensureSession("test", "cli", "owner");
    const current = new Date().toISOString();
    runtime.store.createRun({
      id: "run_parent_cancel", tenantId: "test", sessionId: owner.id, kind: "foreground", status: "completed",
      modelRole: "foreground", input: "delegate", output: "delegated", inputTokens: 1, outputTokens: 1,
      createdAt: current, updatedAt: current,
    });
    const outputPath = `${home.path}/cancelled.txt`;
    const objective = `[[tool:file.write ${JSON.stringify({ path: outputPath, content: "must not happen" })}]]`;
    const admission = runtime.agents.admit({
      tenantId: "test", ownerSessionId: owner.id, admittedByRunId: "run_parent_cancel",
      objective, deliverable: "write result", depth: 1, allowedTools: ["file.write"],
    });
    const waiting = await runtime.processAgentTurn(admission.agent.id, admission.message.id);
    assert.equal(waiting.status, "waiting_approval");
    assert.ok(waiting.approvalId);

    runtime.agents.cancel("test", admission.agent.id);
    assert.equal(runtime.store.getRun(waiting.runId, "test")?.status, "cancelled");
    assert.equal(runtime.store.getApproval(waiting.approvalId)?.status, "denied");
    await assert.rejects(runtime.resumeApproval(waiting.approvalId, "approved"), /already denied/);
    assert.equal(existsSync(outputPath), false);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("cancelling during a tool records the external outcome but fences all later run artifacts", async () => {
  const home = testHome();
  let releaseTool!: () => void;
  let toolStarted!: () => void;
  const release = new Promise<void>((resolve) => { releaseTool = resolve; });
  const started = new Promise<void>((resolve) => { toolStarted = resolve; });
  let providerCalls = 0;
  const adapter: ProviderAdapter = {
    name: "mock",
    complete: async () => {
      providerCalls += 1;
      return providerCalls === 1
        ? { text: "", toolCalls: [{ id: "call_slow", name: "external.slow", arguments: {} }], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } }
        : { text: "must not be committed", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([adapter]) });
  runtime.tools.register({
    definition: {
      name: "external.slow", description: "A slow external action",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read", tags: ["external", "slow"], idempotent: false,
    },
    evaluateResult: successfulToolResult,
    execute: async () => {
      toolStarted();
      await release;
      return { externalOutcome: "completed" };
    },
  });
  try {
    const owner = runtime.store.ensureSession("test", "cli", "owner-tool-cancel");
    const current = new Date().toISOString();
    runtime.store.createRun({
      id: "run_parent_tool_cancel", tenantId: "test", sessionId: owner.id, kind: "foreground", status: "completed",
      modelRole: "foreground", input: "delegate", output: "delegated", inputTokens: 1, outputTokens: 1,
      createdAt: current, updatedAt: current,
    });
    const admission = runtime.agents.admit({
      tenantId: "test", ownerSessionId: owner.id, admittedByRunId: "run_parent_tool_cancel",
      objective: "perform the slow external action", deliverable: "outcome", depth: 1, allowedTools: ["external.slow"],
    });
    const running = runtime.processAgentTurn(admission.agent.id, admission.message.id);
    await started;
    runtime.agents.cancel("test", admission.agent.id);
    releaseTool();
    const result = await running;

    assert.equal(result.status, "cancelled");
    assert.equal(providerCalls, 1);
    const receipt = runtime.store.db.prepare("SELECT status,output_json FROM tool_receipts WHERE run_id=? AND tool_call_id=?")
      .get(result.runId, "call_slow") as { status: string; output_json: string };
    assert.equal(receipt.status, "succeeded");
    assert.match(receipt.output_json, /externalOutcome/);
    assert.equal(runtime.store.listEvents("test", { stream: `run:${result.runId}` }).some((event) => event.type === "run.completed"), false);
    const toolMessages = runtime.store.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE tenant_id=? AND session_id=? AND role='tool'")
      .get("test", result.sessionId) as { count: number };
    assert.equal(Number(toolMessages.count), 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("recovery never repeats an ambiguous non-idempotent tool call", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([new MockProvider()]) });
  let executions = 0;
  const tool: RuntimeTool = {
    definition: {
      name: "external.once", description: "A non-idempotent external effect",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read", tags: ["external"], idempotent: false,
    },
    evaluateResult: successfulToolResult,
    execute: async () => {
      executions += 1;
      return { sent: true };
    },
  };
  runtime.tools.register(tool);
  try {
    const state = runState({
      authorityToolNames: ["external.once"], toolNames: ["external.once"],
      pendingCalls: [{ id: "call_once", name: "external.once", arguments: {} }],
    });
    createRun(runtime, "run_ambiguous_tool", state);
    const leaseToken = runtime.store.acquireRunLease("test", "run_ambiguous_tool");
    assert.ok(leaseToken);
    const claim = runtime.store.claimReceipt({
      tenantId: "test", runId: "run_ambiguous_tool", runLeaseToken: leaseToken, toolCallId: "call_once",
      toolName: "external.once", arguments: {}, risk: "read", idempotencyKey: "effect_ambiguous",
    });
    assert.equal(runtime.store.beginReceiptEffect(claim.receipt.id, leaseToken), true);
    runtime.store.releaseRunLease("test", "run_ambiguous_tool", leaseToken);

    const result = await runtime.recoverRun("run_ambiguous_tool");
    assert.equal(result.status, "completed");
    assert.equal(executions, 0);
    assert.match(result.text, /outcomeUncertain/i);
    assert.equal(runtime.store.listEvents("test", { stream: "run:run_ambiguous_tool" }).filter((event) => event.type === "tool.recovery_blocked").length, 1);
    assert.equal(runtime.store.getReceipt("test", "run_ambiguous_tool", "call_once")?.effectState, "uncertain");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a stolen run lease rolls back late model artifacts", async () => {
  const home = testHome();
  let releaseProvider!: () => void;
  let providerStarted!: () => void;
  const release = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const started = new Promise<void>((resolve) => { providerStarted = resolve; });
  const slow: ProviderAdapter = {
    name: "mock",
    complete: async () => {
      providerStarted();
      await release;
      return { text: "late", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([slow]) });
  try {
    const sessionId = createRun(runtime, "run_lease_theft", runState());
    const running = runtime.recoverRun("run_lease_theft");
    await started;
    runtime.store.db.prepare("UPDATE runs SET lease_token='replacement',lease_expires_at=? WHERE id=?")
      .run(new Date(Date.now() + 60_000).toISOString(), "run_lease_theft");
    releaseProvider();
    await assert.rejects(running, /Run lease lost/);

    assert.equal(runtime.store.getRun("run_lease_theft", "test")?.status, "running");
    assert.equal(runtime.store.listEvents("test", { stream: "run:run_lease_theft" }).some((event) => event.type === "model.completed" || event.type === "run.completed"), false);
    const assistants = runtime.store.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE tenant_id=? AND session_id=? AND role='assistant'")
      .get("test", sessionId) as { count: number };
    assert.equal(Number(assistants.count), 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("corrupt durable run state fails closed before a provider or tool can execute", async () => {
  const home = testHome();
  let providerCalls = 0;
  const adapter: ProviderAdapter = {
    name: "mock",
    complete: async () => {
      providerCalls += 1;
      return { text: "unsafe", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([adapter]) });
  try {
    createRun(runtime, "run_corrupt", runState());
    runtime.store.db.prepare("UPDATE runs SET state_json=? WHERE id=?").run("{not-json", "run_corrupt");
    assert.throws(() => runtime.store.getRun("run_corrupt", "test"), /corrupt durable state.*valid JSON/);
    await assert.rejects(runtime.recoverRun("run_corrupt"), /corrupt durable state.*valid JSON/);
    assert.equal(providerCalls, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("connector delivery deduplicates success and records one uncertain outcome after a crash boundary", async () => {
  const home = testHome();
  let deliveries = 0;
  const adapter: ConnectorAdapter = {
    id: "seam",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "seam", inboundConfigured: false, outboundConfigured: true }),
    verifyWebhook: () => false,
    parseWebhook: () => undefined,
    deliver: async () => {
      deliveries += 1;
      return { provider: "seam", messageId: `seam-${deliveries}` };
    },
  };
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  runtime.connectors.register(adapter);
  const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
  const deliver = (worker as unknown as {
    deliverConnector(tenantId: string, runId: string, channel: string, peerId: string, content: string, deliveryKey: string): Promise<void>;
  }).deliverConnector.bind(worker);
  try {
    await deliver("test", "run_delivery", "seam", "peer", "hello", "success");
    await deliver("test", "run_delivery", "seam", "peer", "hello", "success");
    assert.equal(deliveries, 1);
    assert.equal(runtime.store.listEvents("test", { stream: "run:run_delivery" }).filter((event) => event.type === "message.delivery_uncertain").length, 0);

    const intentId = stableId("evt", "delivery-intent:test:run_delivery:seam:peer:ambiguous");
    runtime.store.appendEvent({
      id: intentId, tenantId: "test", stream: "run:run_delivery", type: "message.delivery_started",
      correlationId: "run_delivery", payload: { channel: "seam", peerId: "peer", deliveryKey: "ambiguous" },
    });
    await deliver("test", "run_delivery", "seam", "peer", "hello", "ambiguous");
    await deliver("test", "run_delivery", "seam", "peer", "hello", "ambiguous");
    assert.equal(deliveries, 1);
    assert.equal(runtime.store.listEvents("test", { stream: "run:run_delivery" }).filter((event) => event.type === "message.delivery_uncertain").length, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});
