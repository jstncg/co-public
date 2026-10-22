import assert from "node:assert/strict";
import test from "node:test";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { CURRENT_SCHEMA_VERSION } from "../src/store.ts";
import type { ProviderAdapter } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

test("office records preserve provenance from standing mandate through prepared work and attention", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "session:source", type: "message.received", payload: { text: "Keep an eye on the launch" } });
    const mandate = runtime.office.proposeMandate({
      tenantId: "test", name: "Launch desk", serviceContract: "Watch launch readiness and prepare useful work without sending it.",
      authority: { mayPrepare: true, maySend: false }, delivery: { default: "digest" }, sourceEventId: source.id,
    });
    assert.equal(mandate.status, "proposed");
    assert.equal(runtime.office.transitionMandate("test", mandate.id, "active").status, "active");

    const matter = runtime.office.createMatter({ tenantId: "test", mandateId: mandate.id, title: "August launch", summary: "Readiness and open launch risks", priority: 80, sourceEventId: source.id });
    const artifact = runtime.office.prepareArtifact({ tenantId: "test", matterId: matter.id, kind: "brief", title: "Launch brief", content: "Current readiness and decisions.", sourceEventIds: [source.id] });
    const attention = runtime.office.raiseAttention({ tenantId: "test", matterId: matter.id, artifactId: artifact.id, sourceEventId: source.id, title: "Launch decision", content: "A decision is ready", reason: "The prepared brief narrowed the decision", mode: "digest", priority: 75 });
    assert.equal(runtime.office.raiseAttention({ tenantId: "test", sourceEventId: source.id, title: "Launch decision", content: "Duplicate", reason: "Same source" }).id, attention.id);
    runtime.store.appendEvent({ tenantId: "test", stream: "calendar", type: "calendar.changed", payload: { title: "Launch review", startsAt: new Date(Date.now() + 60 * 60_000).toISOString() } });

    const today = runtime.office.today("test");
    assert.equal((today.attention as unknown[]).length, 1);
    assert.equal((today.prepared as unknown[]).length, 1);
    assert.equal((today.activeMandates as unknown[]).length, 1);
    assert.equal((today.calendar as unknown[]).length, 1);
    const whyMatter = runtime.office.why("test", matter.id);
    assert.deepEqual(whyMatter.evidenceEventIds, [source.id]);
    const whyArtifact = runtime.office.why("test", artifact.id);
    assert.equal((whyArtifact.sourceEvents as unknown[]).length, 1);

    assert.equal(runtime.office.resolveAttention("test", attention.id, "acted").status, "acted");
    assert.equal(runtime.office.markArtifact("test", artifact.id, "used").status, "used");
    assert.throws(() => runtime.office.markArtifact("test", artifact.id, "reviewed"), /cannot move/);
    assert.equal(runtime.office.updateMatter("test", matter.id, { status: "completed", evidenceEventId: source.id }).status, "completed");
    assert.equal(runtime.store.listEvents("test", { stream: `matter:${matter.id}` }).length >= 2, true);
    assert.ok(runtime.store.getEvent("test", source.id), "source event is never erased");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("foreground office context includes a bounded preview of current prepared work only", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    assert.equal(runtime.office.promptContext("test"), "", "prepared work participates in the empty-context decision");
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "session:source", type: "message.received", payload: { text: "Prepare this" } });
    const current = runtime.office.prepareArtifact({
      tenantId: "test", kind: "brief", title: "Useful current brief", content: `Use this completed research.${"x".repeat(1_500)}`,
      sourceEventIds: [source.id],
    });
    const used = runtime.office.prepareArtifact({ tenantId: "test", kind: "draft", title: "Already sent", content: "USED_SECRET", sourceEventIds: [source.id] });
    const retired = runtime.office.prepareArtifact({ tenantId: "test", kind: "draft", title: "Superseded", content: "RETIRED_SECRET", sourceEventIds: [source.id] });
    runtime.office.markArtifact("test", used.id, "used");
    runtime.office.markArtifact("test", retired.id, "retired");

    const currentContext = runtime.office.promptContext("test");
    assert.match(currentContext, new RegExp(`Prepared artifact ${current.id} \\[brief; updated .+\\]: Useful current brief`));
    assert.match(currentContext, /Preview: Use this completed research\./);
    assert.equal(currentContext.includes("USED_SECRET"), false);
    assert.equal(currentContext.includes("RETIRED_SECRET"), false);
    assert.equal(currentContext.includes("x".repeat(1_001)), false, "artifact previews are bounded");

    for (let index = 0; index < 5; index += 1) {
      runtime.office.prepareArtifact({ tenantId: "test", kind: "note", title: `Overflow ${index}`, content: `overflow ${index}`, sourceEventIds: [source.id] });
    }

    const context = runtime.office.promptContext("test");
    assert.equal((context.match(/- Prepared artifact /g) ?? []).length, 5, "prepared work has a fixed foreground bound");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("run cancellation is tenant-scoped, denies pending approval, and retains durable state for inspection", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const session = runtime.store.ensureSession("test", "cli", "cancel");
    const current = new Date().toISOString();
    runtime.store.createRun({
      id: "run_cancel_direct", tenantId: "test", sessionId: session.id, kind: "foreground", status: "waiting_approval", modelRole: "foreground",
      input: "write", state: { system: "test", messages: [], authorityToolNames: ["file.write"], toolNames: ["file.write"], modelRoute: runtime.config.models.foreground, iteration: 0, pendingCalls: [], nextToolIndex: 0, depth: 0, tokenBudget: 1_000 },
      inputTokens: 0, outputTokens: 0, createdAt: current, updatedAt: current,
    });
    const approval = runtime.store.createApproval({ tenantId: "test", runId: "run_cancel_direct", toolCallId: "call_1", toolName: "file.write", arguments: { path: "/tmp/no" }, risk: "destructive", reason: "test" });
    const cancelled = runtime.cancelRun("run_cancel_direct");
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.state, "cancellation retains recoverable inspection state");
    assert.equal(runtime.store.getApproval(approval.id)?.status, "denied");
    assert.equal(runtime.store.listEvents("test", { stream: "run:run_cancel_direct", type: "run.cancelled" }).length, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("HTTP exposes daemon attachment, run control, and office projections", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  const server = createRuntimeServer(runtime);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const identity = await fetch(`${base}/v1/runtime`);
    assert.deepEqual(await identity.json(), { tenantId: "test", profileId: null, distribution: "co", schemaVersion: CURRENT_SCHEMA_VERSION, mode: "live" });
    const chat = await fetch(`${base}/v1/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hello", channel: "cli", peerId: "office-test", externalId: "turn-1" }) });
    assert.equal(chat.status, 200);
    const result = await chat.json() as { runId: string };
    const attached = await fetch(`${base}/v1/chat/status?externalId=turn-1&channel=cli&peerId=office-test`);
    const status = await attached.json() as { run: { id: string }; events: unknown[] };
    assert.equal(status.run.id, result.runId);
    assert.equal(status.events.length > 0, true);
    const personalModel = await fetch(`${base}/v1/personal-model?kind=thought`);
    assert.equal((await personalModel.json() as { nodes: unknown[] }).nodes.length, 1);

    const mandateResponse = await fetch(`${base}/v1/mandates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Research desk", serviceContract: "Prepare research; never publish." }) });
    assert.equal(mandateResponse.status, 201);
    const mandate = await mandateResponse.json() as { id: string };
    const approved = await fetch(`${base}/v1/mandates/${mandate.id}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve" }) });
    assert.equal((await approved.json() as { status: string }).status, "active");

    const promiseSession = runtime.store.ensureSession("test", "imessage", "promise-api");
    const promiseSource = runtime.store.appendEvent({ tenantId: "test", stream: `session:${promiseSession.id}`, type: "message.received", payload: { text: "follow up tomorrow" } });
    const promise = runtime.office.acceptPromise({
      tenantId: "test", sourceEventId: promiseSource.id, sessionId: promiseSession.id,
      objective: "follow up on the decision", dueAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const promises = await fetch(`${base}/v1/promises`);
    assert.equal((await promises.json() as Array<{ id: string }>).some((item) => item.id === promise.id), true);
    const released = await fetch(`${base}/v1/promises/${promise.id}/actions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "release", resolution: "The member withdrew the request." }),
    });
    assert.equal((await released.json() as { status: string }).status, "released");
    const releasedPromises = await fetch(`${base}/v1/promises?status=released`);
    assert.equal((await releasedPromises.json() as Array<{ id: string }>).some((item) => item.id === promise.id), true);
    const promiseWhy = await fetch(`${base}/v1/why/${promise.id}`);
    assert.equal((await promiseWhy.json() as { kind: string }).kind, "promise");

    const today = await fetch(`${base}/v1/today`);
    assert.equal(((await today.json() as { activeMandates: unknown[] }).activeMandates).length, 1);
    const why = await fetch(`${base}/v1/why/${mandate.id}`);
    assert.equal((await why.json() as { kind: string }).kind, "mandate");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    home.cleanup();
  }
});

test("a useful intervention without an authorized delivery path is held in the office inbox", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "calendar", type: "calendar.changed", payload: { title: "Flight changed" } });
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    const decision = worker.attention.evaluate("test", {
      sourceEventId: source.id, topicKey: "travel", evidence: 2, novelty: 1, urgency: 1, usefulness: 1,
      actionability: 1, confidence: 1, interruptionCost: 0.1, content: "Your flight time changed.", channel: "unconfigured", peerId: "person",
    });
    assert.equal(decision.send, true);
    assert.equal(await worker.runOnce(), true);
    const held = runtime.office.listAttention("test");
    assert.equal(held.length, 1);
    assert.equal(held[0]?.sourceEventId, source.id);
    assert.equal(held[0]?.mode, "hold");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("daemon run control cancels an in-flight provider and fences its late result", async () => {
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
  const server = createRuntimeServer(runtime);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const chat = fetch(`${base}/v1/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "wait", channel: "cli", peerId: "cancel-http", externalId: "cancel-turn" }) });
    await started;
    const attached = await fetch(`${base}/v1/chat/status?externalId=cancel-turn&channel=cli&peerId=cancel-http`);
    const status = await attached.json() as { run: { id: string } };
    const cancelled = await fetch(`${base}/v1/runs/${status.run.id}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
    assert.equal((await cancelled.json() as { status: string }).status, "cancelled");
    releaseProvider();
    const result = await (await chat).json() as { status: string; text: string };
    assert.equal(result.status, "cancelled");
    assert.equal(result.text, "Run cancelled.");
    assert.equal(runtime.store.getRun(status.run.id, "test")?.output, undefined);
  } finally {
    releaseProvider?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    home.cleanup();
  }
});
