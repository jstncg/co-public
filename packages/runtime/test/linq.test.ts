import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { LinqAdapter, parseLinqEvent, verifyLinqWebhook } from "../src/linq.ts";
import { DependencyError } from "../src/dependency-errors.ts";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import { RuntimeWorker } from "../src/worker.ts";
import type { ConnectorAdapter } from "../src/connectors.ts";
import { testConfig, testHome } from "./helpers.ts";

const CHAT = "8f392755-6865-4b18-880a-227f9d8b458f";
const PEER = "+12025559876";
const LINE = "+12025551234";
const KEY = Buffer.from("kqzvxhbtmpcnwjlrgsdfyaeouiKQZVXH");
const SECRET = `whsec_${KEY.toString("base64")}`;

function inbound(messageId = "m-1", content = "Hello!"): Record<string, unknown> {
  return {
    id: `webhook-${messageId}`,
    webhook_version: "2026-02-03",
    event_type: "message.received",
    data: {
      chat: { id: CHAT, is_group: false, owner_handle: { handle: LINE, is_me: true } },
      id: messageId,
      direction: "inbound",
      sender_handle: { handle: PEER, is_me: false },
      parts: [{ type: "text", value: content }, { type: "media", url: "https://cdn.linqapp.com/a/photo.jpg", mime_type: "image/jpeg" }],
    },
  };
}

function signature(raw: Buffer, messageId: string, timestamp: number): Record<string, string> {
  const digest = createHmac("sha256", KEY).update(Buffer.concat([Buffer.from(`${messageId}.${timestamp}.`), raw])).digest("base64");
  return { "webhook-id": messageId, "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${digest}` };
}

test("Linq verifies the exact raw webhook bytes and rejects stale or changed bodies", () => {
  const raw = Buffer.from(JSON.stringify(inbound()));
  const now = 9_000_000;
  const headers = signature(raw, "evt-1", 9_000);
  assert.equal(verifyLinqWebhook(SECRET, headers, raw, now), true);
  assert.equal(verifyLinqWebhook(SECRET, headers, Buffer.concat([raw, Buffer.from(" ")]), now), false);
  assert.equal(verifyLinqWebhook(SECRET, signature(raw, "evt-1", 8_699), raw, now), false);
});

test("Linq normalizes current and legacy messages without treating groups as private relationships", () => {
  const current = parseLinqEvent(inbound());
  assert.equal(current.kind, "message");
  assert.equal(current.peerId, PEER);
  assert.equal(current.chatId, CHAT);
  assert.equal(current.text, "Hello!");
  assert.equal(current.trustedShape, true);
  assert.deepEqual(current.mediaUrls, ["https://cdn.linqapp.com/a/photo.jpg"]);
  assert.equal(current.attachments[0]?.url, "https://cdn.linqapp.com/a/photo.jpg");
  assert.equal(current.attachments[0]?.mimeType, "image/jpeg");

  const legacy = parseLinqEvent({
    id: "legacy-event", event_type: "message.received",
    data: { chat_id: CHAT, from_handle: { handle: PEER }, message: { id: "legacy-1", parts: [{ type: "text", value: "old shape" }] } },
  });
  assert.equal(legacy.kind, "message");
  assert.equal(legacy.messageId, "legacy-1");
  assert.equal(legacy.trustedShape, false);

  const group = inbound();
  ((group.data as { chat: { is_group?: boolean } }).chat).is_group = true;
  assert.equal(parseLinqEvent(group).kind, "ignored");
});

test("Linq HTTP success without a provider message ID is uncertain, never accepted", async () => {
  const adapter = new LinqAdapter({ apiKey: "key", fromNumber: LINE, baseUrl: "https://api.linqapp.test/api/partner/v3" });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ chat_id: CHAT }), { status: 200 });
  try {
    await assert.rejects(adapter.send({ peerId: PEER, content: "reply" }), (error: unknown) => {
      assert.ok(error instanceof DependencyError);
      assert.equal(error.kind, "malformed_response");
      assert.equal(error.uncertain, true);
      assert.equal(error.retryable, false);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("Linq reactions use the native message reaction endpoint with fixed tapback vocabulary", async () => {
  const adapter = new LinqAdapter({ apiKey: "key", fromNumber: LINE, baseUrl: "https://api.linqapp.test/api/partner/v3" });
  const original = globalThis.fetch;
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("{}", { status: 200 });
  };
  try {
    const result = await adapter.react("inbound/17", "question", "stable-reaction-key");
    assert.equal(requestedUrl, "https://api.linqapp.test/api/partner/v3/messages/inbound%2F17/reactions");
    assert.deepEqual(requestedBody, { operation: "add", type: "question" });
    assert.deepEqual(result, { provider: "linq", targetMessageId: "inbound/17", reactionType: "question", status: "accepted" });
  } finally {
    globalThis.fetch = original;
  }
});

test("signed Linq ingress, durable chat routing, and reply compose through one iMessage relationship", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.linq = { apiKey: "linq-key", fromNumber: LINE, webhookSecret: SECRET, baseUrl: "https://api.linqapp.test/api/partner/v3" };
  const runtime = new CoRuntime({ config });
  const server = createRuntimeServer(runtime);
  const originalFetch = globalThis.fetch;
  const outbound: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith(config.linq.baseUrl)) return originalFetch(input, init);
    outbound.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ chat_id: CHAT, message: { id: `out-${outbound.length}` } }), { status: 200 });
  };
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    for (const [messageId, content] of [["m-1", "Hello!"], ["m-2", "Still there?"]] as const) {
      const payload = inbound(messageId, content);
      const raw = Buffer.from(JSON.stringify(payload));
      const timestamp = Math.floor(Date.now() / 1_000);
      const response = await fetch(`http://127.0.0.1:${port}/webhooks/linq`, {
        method: "POST", headers: { "content-type": "application/json", ...signature(raw, `webhook-${messageId}`, timestamp) }, body: raw,
      });
      assert.equal(response.status, 202);
      assert.equal(runtime.store.connectorRoute("test", "linq", PEER), CHAT);
      const admitted = runtime.store.listJobs("test").find((job) => job.type === "channel.turn" && job.payload.externalId === messageId);
      assert.ok(admitted);
      assert.equal(String(admitted.payload.text).includes("https://cdn.linqapp.com"), false);
      assert.equal(String(admitted.payload.text).includes("[attachment 1: image]"), true);
      assert.equal((admitted.payload.attachments as Array<{ mimeType?: string }>)[0]?.mimeType, "image/jpeg");
      while (outbound.length < (messageId === "m-1" ? 1 : 2) && await worker.runOnce()) { /* drain through earlier enrichment projections */ }
      const mediaJobs = runtime.store.listJobs("test").filter((job) => job.type === "content.enrich" && job.status === "queued");
      assert.ok(mediaJobs.length >= 1);
      assert.equal(mediaJobs.at(-1)?.payload.url, "https://cdn.linqapp.com/a/photo.jpg");
      assert.equal(mediaJobs.at(-1)?.payload.declaredMimeType, "image/jpeg");
      for (const job of mediaJobs) runtime.store.db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(job.id);
    }

    assert.equal(outbound.length, 2);
    assert.equal(outbound.every((call) => call.url.endsWith(`/chats/${CHAT}/messages`)), true);
    const acceptance = runtime.store.listEvents("test", { type: "message.delivery_accepted" })
      .find((event) => JSON.stringify(event.payload).includes("out-1"));
    assert.ok(acceptance);
    const statusPayload = {
      id: "linq-status-1", webhook_version: "2026-02-03", event_type: "message.delivered",
      data: { direction: "outbound", chat: { id: CHAT, is_group: false }, message_id: "out-1" },
    };
    const statusRaw = Buffer.from(JSON.stringify(statusPayload));
    const statusTimestamp = Math.floor(Date.now() / 1_000);
    const statusResponse = await fetch(`http://127.0.0.1:${port}/webhooks/linq`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signature(statusRaw, "webhook-status-1", statusTimestamp) },
      body: statusRaw,
    });
    assert.equal(statusResponse.status, 202);
    const delivered = runtime.store.listEvents("test", { type: "connector.message.delivered" });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.causationId, acceptance.id);
    const sessions = runtime.store.db.prepare("SELECT channel,peer_id,delivery_channel,delivery_peer_id FROM sessions WHERE tenant_id=?").all("test") as Array<Record<string, unknown>>;
    const relationship = sessions.filter((row) => row.channel === "imessage" && row.peer_id === PEER);
    assert.equal(relationship.length, 1);
    assert.equal(relationship[0]?.delivery_channel, "linq");
    assert.equal(relationship[0]?.delivery_peer_id, PEER);
    assert.equal(runtime.store.listMessages("test", String(runtime.store.ensureSession("test", "imessage", PEER).id), 20).length, 4);

    const groupPayload = inbound("group-transition", "private text that must not be retained");
    ((groupPayload.data as { chat: { is_group?: boolean } }).chat).is_group = true;
    const groupRaw = Buffer.from(JSON.stringify(groupPayload));
    const groupResponse = await fetch(`http://127.0.0.1:${port}/webhooks/linq`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signature(groupRaw, "webhook-group-transition", Math.floor(Date.now() / 1_000)) },
      body: groupRaw,
    });
    assert.equal(groupResponse.status, 202);
    assert.equal((await groupResponse.json() as { ignored: boolean }).ignored, true);
    assert.equal(runtime.store.connectorRoute("test", "linq", PEER), undefined);
    const rejection = runtime.store.listEvents("test", { type: "security.untrusted_connector_ingress_rejected" }).at(-1);
    assert.ok(rejection);
    assert.equal(JSON.stringify(runtime.store.listEvents("test")).includes("private text that must not be retained"), false);
    assert.equal(runtime.store.listJobs("test").some((job) => job.payload.externalId === "group-transition"), false);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    home.cleanup();
  }
});

test("an authenticated delivery failure is reconciled even when it arrives before local acceptance", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.linq = { apiKey: "linq-key", fromNumber: LINE, webhookSecret: SECRET, baseUrl: "https://api.linqapp.test/api/partner/v3" };
  const runtime = new CoRuntime({ config });
  const server = createRuntimeServer(runtime);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => String(input).startsWith(config.linq.baseUrl)
    ? new Response(JSON.stringify({ chat_id: CHAT, message: { id: "out-early-failure" } }), { status: 200 })
    : originalFetch(input, init);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const failedPayload = {
      id: "status-before-acceptance", webhook_version: "2026-02-03", event_type: "message.failed",
      data: { direction: "outbound", chat: { id: CHAT, is_group: false }, message_id: "out-early-failure" },
    };
    const raw = Buffer.from(JSON.stringify(failedPayload));
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/linq`, {
      method: "POST", headers: { "content-type": "application/json", ...signature(raw, "early-failure", Math.floor(Date.now() / 1_000)) }, body: raw,
    });
    assert.equal(response.status, 202);

    const source = runtime.store.appendEvent({ tenantId: "test", stream: "calendar:test", type: "calendar.changed", payload: {} });
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    assert.equal(worker.attention.evaluate("test", {
      sourceEventId: source.id, topicKey: "status-reconciliation", evidence: 2, novelty: 1, urgency: 1,
      usefulness: 1, actionability: 1, confidence: 0.99, interruptionCost: 0.01,
      content: "This should not count as seen.", channel: "linq", peerId: PEER,
    }).send, true);
    assert.equal(await worker.runOnce(), true);
    const intervention = runtime.store.db.prepare(`SELECT decision,accepted_at,delivered_at,read_at,failed_at,sent_at
      FROM interventions WHERE tenant_id=? AND topic_key=?`).get("test", "status-reconciliation") as Record<string, unknown>;
    assert.equal(intervention.decision, "held");
    assert.ok(intervention.accepted_at);
    assert.ok(intervention.failed_at);
    assert.equal(intervention.delivered_at, null);
    assert.equal(intervention.read_at, null);
    assert.equal(intervention.sent_at, null);
    assert.equal((runtime.store.db.prepare("SELECT state FROM outbound_deliveries WHERE tenant_id=?")
      .get("test") as { state: string }).state, "failed");
    const relationshipSession = runtime.store.ensureSession("test", "imessage", PEER);
    const attemptedHistory = runtime.store.listMessages("test", relationshipSession.id, 20).find((message) => message.role === "assistant");
    assert.ok(attemptedHistory?.parts.some((part) => part.type === "text" && /member did not receive/i.test(part.text)));
    assert.equal(worker.attention.knownness.evaluate("test", "This should not count as seen.", source.id, 1).status, "uncertain");

    const lateDelivered = {
      id: "delivered-after-failure", webhook_version: "2026-02-03", event_type: "message.delivered",
      data: { direction: "outbound", chat: { id: CHAT, is_group: false }, message_id: "out-early-failure" },
    };
    const deliveredRaw = Buffer.from(JSON.stringify(lateDelivered));
    const deliveredResponse = await fetch(`http://127.0.0.1:${port}/webhooks/linq`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signature(deliveredRaw, "delivered-after-failure", Math.floor(Date.now() / 1_000)) },
      body: deliveredRaw,
    });
    assert.equal(deliveredResponse.status, 202);
    const afterLateDelivery = runtime.store.db.prepare(`SELECT decision,delivered_at,read_at,failed_at,sent_at
      FROM interventions WHERE tenant_id=? AND topic_key=?`).get("test", "status-reconciliation") as Record<string, unknown>;
    assert.equal(afterLateDelivery.decision, "held");
    assert.ok(afterLateDelivery.failed_at);
    assert.equal(afterLateDelivery.delivered_at, null);
    assert.equal(afterLateDelivery.read_at, null);
    assert.equal(afterLateDelivery.sent_at, null);
    assert.equal((runtime.store.db.prepare("SELECT state FROM outbound_deliveries WHERE tenant_id=?")
      .get("test") as { state: string }).state, "failed");
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    home.cleanup();
  }
});

test("the same phone keeps one canonical session while its iMessage rail changes", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const first = await runtime.turn({ tenantId: "test", channel: "sendblue", peerId: PEER, relationship: { channel: "imessage", peerId: PEER }, text: "first" });
    const second = await runtime.turn({ tenantId: "test", channel: "linq", peerId: PEER, relationship: { channel: "imessage", peerId: PEER }, text: "second" });
    assert.equal(first.sessionId, second.sessionId);
    const session = runtime.store.getSession(first.sessionId, "test");
    assert.equal(session?.deliveryChannel, "linq");
    assert.equal(runtime.store.listMessages("test", first.sessionId, 20).length, 4);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("background results follow the relationship's current rail instead of the rail that admitted the work", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  const delivered: string[] = [];
  const rail = (id: string): ConnectorAdapter => ({
    id,
    inboundPrincipal: "trusted-system",
    status: () => ({ id, inboundConfigured: true, outboundConfigured: true }),
    verifyWebhook: () => true,
    parseWebhook: () => undefined,
    relationship: (peerId) => ({ channel: "imessage", peerId }),
    deliver: async () => { delivered.push(id); return { provider: id, messageId: `${id}-1` }; },
  });
  runtime.connectors.register(rail("old-rail"));
  runtime.connectors.register(rail("new-rail"));
  try {
    runtime.store.ensureSession("test", "imessage", PEER, { channel: "old-rail", peerId: PEER });
    const admission = await runtime.submitWorkOrder({
      objective: "Summarize the bounded input.", successContract: "A completed run is the deliverable.", evidencePolicy: "run",
      sourceChannel: "old-rail", sourcePeerId: PEER,
    });
    runtime.store.ensureSession("test", "imessage", PEER, { channel: "new-rail", peerId: PEER });
    await new RuntimeWorker(runtime, { videoAnalyzer: null }).drain(10);
    assert.equal(runtime.workOrders.get("test", admission.workOrder.id)?.status, "completed");
    assert.deepEqual(delivered, ["new-rail"]);
  } finally {
    runtime.close();
    home.cleanup();
  }
});
