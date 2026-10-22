import { describe, expect, it, vi } from "vitest";
import { envelopeIdentity, handleIngest, IngestError } from "../src/ingest";
import { artifactsForTransportRpc, InMemoryTransportStore, phoneLookupHash } from "../src/store";

const phone = "+15551234567";
const userId = "0198c5d2-bfed-75e0-b7d1-8a89b7c04110";
const base = (overrides: Record<string, unknown> = {}) => ({
  idempotency_key: "sendblue:message-1", tenant_phone: phone, transport: "sendblue",
  direction: "inbound", external_message_id: "message-1", external_thread_id: phone,
  text: "https://example.com/watch", media_urls: [], sent_at: "2026-07-20T19:00:00Z",
  status: null, reply_to_external_id: null, artifacts: [], transport_metadata: {}, ...overrides,
});

describe("transport ingest", () => {
  it("preserves segment-only evidence for the legacy transport RPC", () => {
    const artifacts = artifactsForTransportRpc([{
      source_type: "call",
      canonical_url: null,
      coverage: "full_media",
      extraction: null,
      timestamp_seconds: null,
      occurred_at: "2026-07-30T12:00:00-07:00",
      provenance_class: "participant",
      consent_state: "participants_consented",
      source_adapter: "call-upload",
      source_adapter_version: "1",
      segments: [{
        segment_key: "speaker-a:0",
        content_kind: "turn",
        text: "We agreed to send the draft.",
        start_seconds: 0,
        end_seconds: 3,
        start_offset: null,
        end_offset: null,
        speaker_label: "Speaker A",
        speaker_relation: "other_person",
        provenance_class: "participant",
        confidence: 0.98,
      }],
    }]);
    expect(artifacts[0]?.extraction).toBe("We agreed to send the draft.");
    expect(artifacts[0]?.segments[0]?.speaker_label).toBe("Speaker A");
  });

  it("stores inbound and outbound messages without generating a reply", async () => {
    const store = new InMemoryTransportStore({ [phone]: userId });
    await expect(handleIngest(base(), store)).resolves.toMatchObject({ ok: true, deduped: false });
    await handleIngest(base({ idempotency_key: "ignored-by-server", direction: "outbound", external_message_id: "message-2", text: "specific receipt-backed reply" }), store);
    expect(store.messages.map((message) => message.direction)).toEqual(["inbound", "outbound"]);
    expect(store.messages).toHaveLength(2);
  });

  it("keeps Linq and Sendblue identities distinct inside one relationship", async () => {
    const store = new InMemoryTransportStore({ [phone]: userId });
    await handleIngest(base(), store);
    await handleIngest(base({
      transport: "linq",
      idempotency_key: "linq:message-1",
      external_thread_id: "8f392755-6865-4b18-880a-227f9d8b458f",
    }), store);
    expect(store.messages).toHaveLength(2);
    expect(store.messages.map((message) => message.transport)).toEqual(["sendblue", "linq"]);
    expect(new Set(store.messages.map((message) => message.conversationId)).size).toBe(2);
  });

  it("deduplicates exact replay and atomically links rail artifacts", async () => {
    const store = new InMemoryTransportStore({ [phone]: userId });
    const envelope = base({ artifacts: [{ source_type: "youtube", canonical_url: "https://example.com/watch", coverage: "full_media", extraction: "A specific rail watch.", timestamp_seconds: null }] });
    const first = await handleIngest(envelope, store);
    const replay = await handleIngest(envelope, store);
    expect(replay).toEqual({ ...first, deduped: true });
    expect(store.messages).toHaveLength(1);
    expect(store.artifacts).toHaveLength(1);
    expect(store.messages[0]?.artifactIds).toEqual([store.artifacts[0]?.id]);
  });

  it("links replies only within the resolved tenant and transport", async () => {
    const store = new InMemoryTransportStore({ [phone]: userId });
    const first = await handleIngest(base(), store);
    await handleIngest(base({ external_message_id: "message-2", direction: "outbound", reply_to_external_id: "message-1", text: "reply" }), store);
    expect(store.messages[1]?.replyToMessageId).toBe(first.message_id);
  });

  it("updates first delivery/read timestamps without adding messages", async () => {
    const store = new InMemoryTransportStore({ [phone]: userId });
    await handleIngest(base({ direction: "outbound" }), store);
    await handleIngest(base({ direction: "outbound", text: null, status: "READ", sent_at: "2026-07-20T19:01:00Z" }), store);
    await handleIngest(base({ direction: "outbound", text: null, status: "READ", sent_at: "2026-07-20T19:02:00Z" }), store);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({ deliveredAt: "2026-07-20T19:01:00Z", readAt: "2026-07-20T19:01:00Z" });
  });

  it("makes an early status callback retryable", async () => {
    const store = new InMemoryTransportStore({ [phone]: userId });
    await expect(handleIngest(base({ text: null, status: "DELIVERED" }), store)).rejects.toMatchObject({ status: 503 });
  });

  it("rejects unknown tenants without open registration", async () => {
    await expect(handleIngest(base(), new InMemoryTransportStore())).rejects.toMatchObject({ status: 404 });
  });

  it("rejects malformed or content-empty envelopes", async () => {
    const store = new InMemoryTransportStore({ [phone]: userId });
    await expect(handleIngest(base({ tenant_phone: "5551234567" }), store)).rejects.toBeInstanceOf(IngestError);
    await expect(handleIngest(base({ text: null }), store)).rejects.toMatchObject({ status: 422 });
  });

  it("uses a server-computed five-second signature when no external id exists", async () => {
    const noId = base({ external_message_id: null });
    const first = envelopeIdentity(noId as never);
    const sameBucket = envelopeIdentity({ ...noId, sent_at: "2026-07-20T19:00:04Z" } as never);
    const nextBucket = envelopeIdentity({ ...noId, sent_at: "2026-07-20T19:00:05Z" } as never);
    expect(first.idempotencyKey).toMatch(/^sendblue:sig:[a-f0-9]{64}$/);
    expect(sameBucket).toEqual(first);
    expect(nextBucket).not.toEqual(first);
  });

  it("emits content-free logs", async () => {
    const store = new InMemoryTransportStore({ [phone]: userId });
    const log = vi.fn();
    await handleIngest(base({ text: "private thought", media_urls: ["https://example.com/private"] }), store, log);
    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).not.toContain("private thought");
    expect(serialized).not.toContain("example.com/private");
    expect(serialized).not.toContain(phone);
    expect(serialized).toContain("artifact_count");
  });

  it("HMACs phone lookup keys with a deployment secret", () => {
    const first = phoneLookupHash(phone, "a".repeat(32));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(phoneLookupHash(phone, "a".repeat(32))).toBe(first);
    expect(phoneLookupHash(phone, "b".repeat(32))).not.toBe(first);
    expect(() => phoneLookupHash(phone, "short")).toThrow(/at least 32/);
  });
});
