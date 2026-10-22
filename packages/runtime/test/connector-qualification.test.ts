import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ConnectorRoundTripQualifier } from "../src/connector-qualification.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import type { ProviderAdapter } from "../src/types.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { testConfig, testHome } from "./helpers.ts";

const CHAT = "qualification-chat";
const PEER = "+12025559876";
const LINE = "+12025551234";
const KEY = Buffer.from("qazwsxedcrfvtgbyhnujmikolQAZWSXED");
const SECRET = `whsec_${KEY.toString("base64")}`;

function signedHeaders(raw: Buffer, webhookId: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1_000);
  const digest = createHmac("sha256", KEY).update(Buffer.concat([Buffer.from(`${webhookId}.${timestamp}.`), raw])).digest("base64");
  return { "webhook-id": webhookId, "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${digest}` };
}

function inbound(messageId: string): Record<string, unknown> {
  return {
    id: `webhook-${messageId}`,
    webhook_version: "2026-02-03",
    event_type: "message.received",
    data: {
      chat: { id: CHAT, is_group: false, owner_handle: { handle: LINE, is_me: true } },
      id: messageId,
      direction: "inbound",
      sender_handle: { handle: PEER, is_me: false },
      parts: [{ type: "text", value: "What should I notice today?" }],
    },
  };
}

function status(messageId: string, state: "delivered" | "read"): Record<string, unknown> {
  return {
    id: `status-${messageId}-${state}`,
    webhook_version: "2026-02-03",
    event_type: `message.${state}`,
    data: { direction: "outbound", chat: { id: CHAT, is_group: false }, message_id: messageId },
  };
}

function liveFixture(home: string): { runtime: CoRuntime; config: ReturnType<typeof testConfig> } {
  const config = testConfig(home);
  const route = { provider: "openai-compatible" as const, model: "fixture-live-model", maxOutputTokens: 512, reasoningEffort: "none" as const };
  config.models = { foreground: route, deliberation: route, background: route, critic: route };
  config.linq = { apiKey: "linq-key", fromNumber: LINE, webhookSecret: SECRET, baseUrl: "https://api.linqapp.test/api/partner/v3" };
  const provider: ProviderAdapter = {
    name: "openai-compatible",
    complete: async () => ({
      text: "The decision you keep postponing is now more expensive than choosing.",
      toolCalls: [],
      usage: { inputTokens: 12, outputTokens: 14, reasoningTokens: 0 },
      providerResponseId: "fixture-provider-response",
    }),
  };
  return { runtime: new CoRuntime({ config, providers: new ProviderRegistry([provider]) }), config };
}

async function postSigned(endpoint: string, payload: Record<string, unknown>, webhookId: string): Promise<Response> {
  const raw = Buffer.from(JSON.stringify(payload));
  return fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...signedHeaders(raw, webhookId) },
    body: raw,
  });
}

test("qualification proves an exact signed ingress, completed run, provider acceptance, and authenticated delivery callback", async () => {
  const home = testHome();
  const { runtime, config } = liveFixture(home.path);
  const server = createRuntimeServer(runtime);
  const originalFetch = globalThis.fetch;
  const outboundProviderId = "provider-outbound-private-id";
  globalThis.fetch = async (input, init) => String(input).startsWith(config.linq.baseUrl)
    ? new Response(JSON.stringify({ chat_id: CHAT, message: { id: outboundProviderId } }), { status: 200 })
    : originalFetch(input, init);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const endpoint = `http://127.0.0.1:${port}/webhooks/linq`;
    const since = new Date(Date.now() - 1_000).toISOString();
    assert.equal((await postSigned(endpoint, inbound("member-inbound-private-id"), "signed-inbound")).status, 202);
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    while (await worker.runOnce()) { /* drain the accepted turn */ }
    const receipt = runtime.store.getIngress("test", `turn:linq:${PEER}`, "member-inbound-private-id");
    assert.ok(receipt?.runId);
    const run = runtime.store.getRun(receipt.runId, "test");
    assert.equal(run?.status, "completed");
    const connectorStatus = runtime.connectors.status.find((candidate) => candidate.id === "linq");
    assert.ok(connectorStatus);

    const acceptedOnly = runtime.connectorQualification.qualify({
      tenantId: "test", connectorId: "linq", environment: "production", connectorStatus,
      runId: run.id, since, expectedReleaseId: run.releaseId as string,
    });
    assert.equal(acceptedOnly.passed, false);
    assert.equal(acceptedOnly.actualStatus, "accepted");
    assert.equal(acceptedOnly.stages.authenticatedDeliveryStatus.passed, false);

    assert.equal((await postSigned(endpoint, status(outboundProviderId, "delivered"), "signed-delivery")).status, 202);
    const report = runtime.connectorQualification.qualify({
      tenantId: "test", connectorId: "linq", environment: "production", connectorStatus,
      runId: run.id, since, expectedReleaseId: run.releaseId as string,
    });
    assert.equal(report.passed, true);
    assert.equal(report.actualStatus, "delivered");
    assert.equal(Object.values(report.stages).every((candidate) => candidate.passed), true);
    assert.ok(report.evidence.ingressEventId);
    assert.ok(report.evidence.authorizationEventId);
    assert.ok(report.evidence.deliveryIntentId);
    assert.ok(report.evidence.acceptanceEventId);
    assert.ok(report.evidence.statusWebhookEventId);
    assert.ok(report.evidence.statusEventId);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("What should I notice today?"), false);
    assert.equal(serialized.includes("The decision you keep postponing"), false);
    assert.equal(serialized.includes(PEER), false);
    assert.equal(serialized.includes(outboundProviderId), false);

    const byInbound = runtime.connectorQualification.qualify({
      tenantId: "test", connectorId: "linq", environment: "production", connectorStatus,
      inboundExternalId: "member-inbound-private-id", since, expectedReleaseId: run.releaseId as string,
    });
    assert.equal(byInbound.passed, true);
    assert.equal(byInbound.evidence.runId, run.id);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    home.cleanup();
  }
});

test("qualification fails closed on forged status, digest drift, deployment drift, ambiguity, and cross-tenant selectors", async () => {
  const home = testHome();
  const { runtime, config } = liveFixture(home.path);
  const server = createRuntimeServer(runtime);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => String(input).startsWith(config.linq.baseUrl)
    ? new Response(JSON.stringify({ chat_id: CHAT, message: { id: "provider-adversarial" } }), { status: 200 })
    : originalFetch(input, init);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/linq`;
    const since = new Date(Date.now() - 1_000).toISOString();
    assert.equal((await postSigned(endpoint, inbound("adversarial-inbound"), "adversarial-inbound-hook")).status, 202);
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    while (await worker.runOnce()) { /* drain */ }
    const runId = runtime.store.getIngress("test", `turn:linq:${PEER}`, "adversarial-inbound")?.runId;
    assert.ok(runId);
    const run = runtime.store.getRun(runId, "test");
    const connectorStatus = runtime.connectors.status.find((candidate) => candidate.id === "linq");
    assert.ok(run?.releaseId && connectorStatus);
    const base = {
      tenantId: "test", connectorId: "linq", environment: "production" as const, connectorStatus,
      runId, since, expectedReleaseId: run.releaseId,
    };

    const acceptanceId = (runtime.store.db.prepare(`SELECT acceptance_event_id FROM outbound_deliveries WHERE tenant_id=?`)
      .get("test") as { acceptance_event_id: string }).acceptance_event_id;
    runtime.store.appendEvent({
      tenantId: "test", stream: "connector:linq:delivery:provider-adversarial", type: "connector.message.delivered",
      correlationId: runId, causationId: acceptanceId,
      payload: { connectorId: "linq", externalMessageId: "provider-adversarial" },
    });
    assert.equal(runtime.connectorQualification.qualify(base).stages.authenticatedDeliveryStatus.passed, false,
      "an acceptance-shaped status without its authenticated webhook receipt cannot qualify");

    assert.equal((await postSigned(endpoint, status("provider-adversarial", "delivered"), "adversarial-delivery-hook")).status, 202);
    assert.equal(runtime.connectorQualification.qualify({ ...base, expectedReleaseId: "release_wrong" }).passed, false);
    assert.equal(runtime.connectorQualification.qualify({ ...base, environment: "test" }).passed, false);
    assert.equal(runtime.connectorQualification.qualify({ ...base, since: new Date(Date.now() + 60_000).toISOString() }).passed, false);
    assert.equal(runtime.connectorQualification.qualify({ ...base, connectorStatus: { id: "linq", inboundConfigured: true, outboundConfigured: false } }).passed, false);
    assert.equal(runtime.connectorQualification.qualify({ ...base, tenantId: "another-tenant" }).passed, false);

    runtime.store.appendEvent({
      tenantId: "test", stream: "session:forged", type: "message.received",
      payload: { channel: "linq", peerId: "+19995550123", externalId: "adversarial-inbound", text: "collision" },
    });
    const { runId: _selectedRunId, ...inboundBase } = base;
    const ambiguous = runtime.connectorQualification.qualify({ ...inboundBase, inboundExternalId: "adversarial-inbound" });
    assert.equal(ambiguous.stages.selection.passed, false);

    const intentId = runtime.connectorQualification.qualify(base).evidence.deliveryIntentId;
    assert.ok(intentId);
    runtime.store.db.prepare("UPDATE outbound_deliveries SET request_digest='tampered' WHERE tenant_id=? AND intent_id=?")
      .run("test", intentId);
    const drifted = runtime.connectorQualification.qualify(base);
    assert.equal(drifted.stages.providerAcceptance.passed, false);
    assert.equal(drifted.passed, false);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    home.cleanup();
  }
});

test("qualification accepts an authenticated delivery callback that arrived before local acceptance only through its exact bridge", async () => {
  const home = testHome();
  const { runtime, config } = liveFixture(home.path);
  const server = createRuntimeServer(runtime);
  const originalFetch = globalThis.fetch;
  let endpoint = "";
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith(config.linq.baseUrl)) return originalFetch(input, init);
    const callback = await postSigned(endpoint, status("provider-early", "read"), "early-read-hook");
    assert.equal(callback.status, 202);
    return new Response(JSON.stringify({ chat_id: CHAT, message: { id: "provider-early" } }), { status: 200 });
  };
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/linq`;
    const since = new Date(Date.now() - 1_000).toISOString();
    assert.equal((await postSigned(endpoint, inbound("early-inbound"), "early-inbound-hook")).status, 202);
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    while (await worker.runOnce()) { /* drain */ }
    const runId = runtime.store.getIngress("test", `turn:linq:${PEER}`, "early-inbound")?.runId;
    assert.ok(runId);
    const run = runtime.store.getRun(runId, "test");
    const connectorStatus = runtime.connectors.status.find((candidate) => candidate.id === "linq");
    assert.ok(run?.releaseId && connectorStatus);
    const report = new ConnectorRoundTripQualifier(runtime.store).qualify({
      tenantId: "test", connectorId: "linq", environment: "production", connectorStatus,
      runId, since, expectedReleaseId: run.releaseId, minimumStatus: "read",
    });
    assert.equal(report.passed, true);
    assert.equal(report.actualStatus, "read");
    assert.ok(report.evidence.reconciliationEventId);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    home.cleanup();
  }
});

test("an external message receipt cannot be rebound to a different ingress authorization", async () => {
  const home = testHome();
  const { runtime } = liveFixture(home.path);
  try {
    const firstAuthorization = runtime.store.appendEvent({
      tenantId: "test", stream: "security:fixture", type: "connector.member_ingress_authorized", payload: {},
    });
    const secondAuthorization = runtime.store.appendEvent({
      tenantId: "test", stream: "security:fixture", type: "connector.member_ingress_authorized", payload: {},
    });
    const message = {
      tenantId: "test", channel: "linq", peerId: PEER, relationship: { channel: "imessage", peerId: PEER },
      text: "same bytes", externalId: "authorization-rebind",
    };
    await runtime.turn(message, { authorizationEventId: firstAuthorization.id });
    await assert.rejects(runtime.turn(message, { authorizationEventId: secondAuthorization.id }), /reused across input principals/i);
    const receipt = runtime.store.getIngress("test", `turn:linq:${PEER}`, "authorization-rebind");
    assert.equal(runtime.store.getEvent("test", receipt?.eventId as string)?.causationId, firstAuthorization.id);
  } finally {
    runtime.close();
    home.cleanup();
  }
});
