import { describe, expect, it, vi } from "vitest";
import { InMemoryTransportStore } from "@co/transport";
import { handleSendblueIngestRequest } from "./sendblue-ingest-route";

const token = "a-transport-secret-that-is-at-least-32-characters";
const phone = "+15551234567";
const environment = {
  FEATURE_DUAL_WRITE: "true",
  FEATURE_ASYNC_PROCESSING: "true",
  CO_INGEST_TOKEN: token,
  CO_PHONE_MAPPING_PEPPER: "a-phone-pepper-that-is-at-least-32-characters",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};
const envelope = (overrides: Record<string, unknown> = {}) => ({
  idempotency_key: "provider-controlled-and-ignored",
  tenant_phone: phone,
  transport: "sendblue",
  direction: "inbound",
  external_message_id: "message-1",
  external_thread_id: phone,
  text: "a private rail message",
  media_urls: [],
  sent_at: "2026-07-20T19:00:00Z",
  status: null,
  reply_to_external_id: null,
  artifacts: [],
  transport_metadata: {},
  ...overrides,
});

function request(body: string, bearer = token) {
  return new Request("https://co.example/api/ingest/sendblue", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body,
  });
}

describe("transport ingest HTTP boundary", () => {
  it("fails closed while dual-write is disabled or server configuration is incomplete", async () => {
    const disabled = await handleSendblueIngestRequest(request(JSON.stringify(envelope())), {
      environment: { ...environment, FEATURE_DUAL_WRITE: "false" },
    });
    const incomplete = await handleSendblueIngestRequest(request(JSON.stringify(envelope())), {
      environment: { ...environment, CO_PHONE_MAPPING_PEPPER: undefined },
    });
    expect(disabled.status).toBe(503);
    expect(incomplete.status).toBe(503);
  });

  it("rejects missing or incorrect bearer credentials before parsing content", async () => {
    const missing = new Request("https://co.example/api/ingest/sendblue", { method: "POST", body: "private malformed body" });
    const wrong = request("private malformed body", "wrong");
    expect((await handleSendblueIngestRequest(missing, { environment })).status).toBe(401);
    expect((await handleSendblueIngestRequest(wrong, { environment })).status).toBe(401);
  });

  it("returns 422 for invalid JSON and invalid envelopes", async () => {
    const invalidJson = await handleSendblueIngestRequest(request("{"), { environment });
    const invalidEnvelope = await handleSendblueIngestRequest(request(JSON.stringify(envelope({ tenant_phone: "5551234567" }))), {
      environment,
      createStore: () => new InMemoryTransportStore(),
    });
    const wrongTransport = await handleSendblueIngestRequest(request(JSON.stringify(envelope({ transport: "app" }))), {
      environment,
      createStore: () => new InMemoryTransportStore(),
    });
    expect(invalidJson.status).toBe(422);
    expect(invalidEnvelope.status).toBe(422);
    expect(wrongTransport.status).toBe(422);
  });

  it("accepts Linq without weakening the server-to-server transport boundary", async () => {
    const store = new InMemoryTransportStore({ [phone]: "0198c5d2-bfed-75e0-b7d1-8a89b7c04110" });
    const response = await handleSendblueIngestRequest(request(JSON.stringify(envelope({
      transport: "linq",
      idempotency_key: "linq:message-1",
      external_thread_id: "8f392755-6865-4b18-880a-227f9d8b458f",
    }))), { environment, createStore: () => store });
    expect(response.status).toBe(200);
    expect(store.messages[0]).toMatchObject({ transport: "linq", idempotencyKey: "linq:message-1" });
  });

  it("ingests an authenticated envelope and preserves idempotency", async () => {
    const store = new InMemoryTransportStore({ [phone]: "0198c5d2-bfed-75e0-b7d1-8a89b7c04110" });
    const dependencies = { environment, createStore: () => store, log: vi.fn() };
    const first = await handleSendblueIngestRequest(request(JSON.stringify(envelope())), dependencies);
    const replay = await handleSendblueIngestRequest(request(JSON.stringify(envelope())), dependencies);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, deduped: false });
    expect(await replay.json()).toMatchObject({ ok: true, deduped: true });
    expect(store.messages).toHaveLength(1);
  });

  it("dispatches rail artifacts through the canonical durable processor on first delivery and replay", async () => {
    const store = new InMemoryTransportStore({ [phone]: "0198c5d2-bfed-75e0-b7d1-8a89b7c04110" });
    const dispatchArtifact = vi.fn(async () => {});
    const railArtifact = {
      source_type: "youtube",
      canonical_url: "https://example.com/watch",
      coverage: "full_media",
      extraction: "A complete rail-provided transcript.",
      timestamp_seconds: null,
      segments: [{
        segment_key: "caption:0",
        content_kind: "caption",
        text: "A complete rail-provided transcript.",
        start_seconds: 0,
        end_seconds: 8,
        speaker_relation: "source",
        provenance_class: "external",
        confidence: 1,
      }],
    };
    await handleSendblueIngestRequest(request(JSON.stringify(envelope({ artifacts: [railArtifact] }))), {
      environment, createStore: () => store, dispatchArtifact,
    });
    await handleSendblueIngestRequest(request(JSON.stringify(envelope({ artifacts: [railArtifact] }))), {
      environment, createStore: () => store, dispatchArtifact,
    });
    expect(dispatchArtifact).toHaveBeenCalledTimes(2);
    expect(dispatchArtifact).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: store.artifacts[0]?.id,
      idempotencyKey: `transport-artifact:${store.artifacts[0]?.id}`,
    }));
  });

  it("keeps durable dispatch off while async processing is feature-disabled", async () => {
    const store = new InMemoryTransportStore({ [phone]: "0198c5d2-bfed-75e0-b7d1-8a89b7c04110" });
    const dispatchArtifact = vi.fn(async () => {});
    const response = await handleSendblueIngestRequest(request(JSON.stringify(envelope({
      artifacts: [{
        source_type: "youtube",
        canonical_url: "https://example.com/watch",
        coverage: "url_only",
        extraction: null,
        timestamp_seconds: null,
      }],
    }))), {
      environment: { ...environment, FEATURE_ASYNC_PROCESSING: "false" },
      createStore: () => store,
      dispatchArtifact,
    });
    expect(response.status).toBe(200);
    expect(dispatchArtifact).not.toHaveBeenCalled();
  });

  it("distinguishes unknown tenants and retryable early status callbacks", async () => {
    const unknown = await handleSendblueIngestRequest(request(JSON.stringify(envelope())), {
      environment,
      createStore: () => new InMemoryTransportStore(),
    });
    const retry = await handleSendblueIngestRequest(request(JSON.stringify(envelope({ text: null, status: "READ" }))), {
      environment,
      createStore: () => new InMemoryTransportStore({ [phone]: "0198c5d2-bfed-75e0-b7d1-8a89b7c04110" }),
    });
    expect(unknown.status).toBe(404);
    expect(retry.status).toBe(503);
  });

  it("never logs message text, phone, media URLs, or thrown database details", async () => {
    const log = vi.fn();
    const privateUrl = "https://private.example/media";
    await handleSendblueIngestRequest(request(JSON.stringify(envelope({ media_urls: [privateUrl] }))), {
      environment,
      createStore: () => ({
        ingestMessage: async () => { throw new Error("database contained private thought"); },
        applyStatus: async () => null,
      }),
      log,
    });
    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).toContain("transport.ingest_failed");
    expect(serialized).not.toContain("private thought");
    expect(serialized).not.toContain(phone);
    expect(serialized).not.toContain(privateUrl);
  });
});
