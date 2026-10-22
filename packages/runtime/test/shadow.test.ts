import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorRegistry, type ConnectorAdapter } from "../src/connectors.ts";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { testConfig, testHome } from "./helpers.ts";

test("shadow connector guard covers direct adapters and late registration", async () => {
  const home = testHome();
  try {
    let sends = 0;
    const adapter: ConnectorAdapter = {
      id: "test", inboundPrincipal: "member",
      status: () => ({ id: "test", inboundConfigured: true, outboundConfigured: true }),
      verifyWebhook: () => true, parseWebhook: () => undefined,
      deliver: async () => { sends += 1; return {}; },
      relationship: (peerId) => ({ channel: "imessage", peerId }),
    };
    const registry = new ConnectorRegistry({ ...testConfig(home.path), mode: "shadow" }, []);
    registry.register(adapter);
    assert.equal(registry.canDeliver("test"), false);
    assert.equal(registry.status[0]?.outboundConfigured, false);
    assert.deepEqual(registry.relationship("test", "peer"), { channel: "imessage", peerId: "peer" });
    await assert.rejects(registry.deliver("test", { peerId: "peer", content: "no" }));
    await assert.rejects(registry.webhook("test")!.deliver({ peerId: "peer", content: "no" }), /Shadow/);
    assert.equal(sends, 0);
  } finally { home.cleanup(); }
});

test("shadow composes durable queued turns but cannot execute even read-labelled tools", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: { ...testConfig(home.path), mode: "shadow" } });
  try {
    const result = await runtime.turn({ tenantId: "test", channel: "cli", peerId: "p", text: '[[tool:clock.now {}]]' });
    assert.equal(result.status, "failed");
    assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS n FROM tool_receipts").get()?.n, 0);
    const job = runtime.store.enqueueJob("test", "channel.turn", { channel: "cli", peerId: "p", text: "compose this privately" });
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    await worker.drain();
    assert.equal(runtime.store.getJob(job.id, "test")?.status, "completed");
    assert.equal(runtime.store.listRuns("test").some((run) => run.output === "Mock response: compose this privately"), true);
    assert.equal(runtime.store.listEvents("test", { type: "message.delivery_accepted" }).length, 0);
  } finally { runtime.close(); home.cleanup(); }
});

test("shadow database cannot silently become live, or adopt an active live database", () => {
  for (const initialMode of ["shadow", "live"] as const) {
    const home = testHome();
    try {
      const config = testConfig(home.path);
      const first = new CoRuntime({ config: { ...config, mode: initialMode } });
      first.store.appendEvent({ tenantId: "test", stream: "test", type: "test.fixture", payload: {} });
      first.close();
      assert.throws(() => new CoRuntime({ config: { ...config, mode: initialMode === "shadow" ? "live" : "shadow" } }), /Shadow/);
      const reopened = new CoRuntime({ config: { ...config, mode: initialMode } });
      reopened.close();
    } finally { home.cleanup(); }
  }
});

test("shadow rejects executable providers and integrations before initialization", () => {
  const home = testHome();
  try {
    const config = { ...testConfig(home.path), mode: "shadow" as const };
    assert.throws(() => new CoRuntime({ config: { ...config, execution: { ...config.execution, backend: "local" } } }), /disabled/);
    assert.throws(() => new CoRuntime({ config: { ...config, models: {
      ...config.models, foreground: { ...config.models.foreground, provider: "codex-cli" },
    } } }), /explicit API/);
  } finally { home.cleanup(); }
});

test("shadow rejects legacy background jobs before readers or action managers can run", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: { ...testConfig(home.path), mode: "shadow" } });
  let reads = 0;
  try {
    const job = runtime.store.enqueueJob("test", "content.enrich", { url: "https://example.test/video" });
    await new RuntimeWorker(runtime, { videoAnalyzer: null, contentEnricher: async () => { reads += 1; throw new Error("must not run"); } }).runOnce();
    assert.equal(reads, 0);
    assert.equal(runtime.store.getJob(job.id, "test")?.status, "failed");
    assert.match(runtime.store.getJob(job.id, "test")?.lastError ?? "", /Shadow mode rejects/);
    await runtime.turn({ tenantId: "test", channel: "cli", peerId: "p", text: "https://example.test/article" });
    assert.equal(runtime.store.listJobs("test").length, 1, "shadow turns cannot generate detached enrichment or inference jobs");
  } finally { runtime.close(); home.cleanup(); }
});

test("shadow HTTP accepts authenticated composition, not actions or email verification", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: { ...testConfig(home.path), mode: "shadow", serverToken: "test-token" } });
  const server = createRuntimeServer(runtime);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    for (const path of ["/v1/email-verifications", "/v1/events", "/v1/credentials", "/webhooks/linq", "/v1/work-orders"]) {
      assert.equal((await fetch(base + path, { method: "POST", headers, body: "{}" })).status, 403);
    }
    assert.equal((await fetch(base + "/v1/chat", { method: "POST", body: '{}' })).status, 401);
    assert.equal((await fetch(base + "/v1/chat", { method: "POST", headers, body: JSON.stringify({ message: "hello" }) })).status, 200);
    assert.equal(runtime.email.status.configured, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close(); home.cleanup();
  }
});
