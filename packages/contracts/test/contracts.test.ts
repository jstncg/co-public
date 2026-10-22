import { describe, expect, it } from "vitest";
import {
  artifactCaptureSchema,
  artifactCorrectionSchema,
  calendarContextSyncSchema,
  catchHistoryResponseSchema,
  collaborationRunRequestSchema,
  featureFlagsFromEnvironment,
  ingestEnvelopeSchema,
  movePlanSchema,
  patternCandidateSchema,
  phoneLinkRequestSchema,
  productEventSchema,
} from "../src/index";

const artifactId = "0198c5d2-bfed-75e0-b7d1-8a89b7c04111";

describe("artifact capture", () => {
  it("accepts an honest URL-only social capture", () => {
    const result = artifactCaptureSchema.parse({
      clientArtifactId: artifactId,
      sourceType: "short_video",
      canonicalUrl: "https://example.com/reel/1?t=41",
      suppliedText: null,
      sourceApp: "com.example.social",
      userNote: null,
      timestampSeconds: 41,
      coverage: "url_only",
      analysisAllowed: true,
      capturedAt: "2026-07-20T12:00:00-07:00",
      idempotencyKey: `capture:${artifactId}`,
      uploadObjectKeys: [],
    });
    expect(result.coverage).toBe("url_only");
  });

  it("rejects an empty capture", () => {
    expect(() => artifactCaptureSchema.parse({
      clientArtifactId: artifactId,
      sourceType: "other",
      sourceApp: null,
      canonicalUrl: null,
      suppliedText: null,
      userNote: null,
      timestampSeconds: null,
      coverage: "unavailable",
      capturedAt: "2026-07-20T19:00:00Z",
      idempotencyKey: `capture:${artifactId}`,
      uploadObjectKeys: [],
    })).toThrow(/URL, text, or supplied object/);
  });
});

it("keeps risky capabilities disabled unless explicitly enabled", () => {
  const defaults = featureFlagsFromEnvironment({});
  expect(Object.entries(defaults).filter(([key]) => key !== "version").every(([, value]) => value === false)).toBe(true);
  expect(featureFlagsFromEnvironment({ FEATURE_X_SOURCE: "true" }).x_source).toBe(true);
  expect(featureFlagsFromEnvironment({ FEATURE_PHONE_LINKING: "true" }).phone_linking).toBe(true);
  expect(featureFlagsFromEnvironment({ FEATURE_ACTION_HARNESS: "true" }).action_harness).toBe(true);
});

it("validates history, correction, and E.164 phone-link boundaries", () => {
  expect(phoneLinkRequestSchema.parse({ phoneNumber: "+14155550123" }).phoneNumber).toBe("+14155550123");
  expect(() => phoneLinkRequestSchema.parse({ phoneNumber: "415-555-0123" })).toThrow();
  expect(artifactCorrectionSchema.parse({
    clientArtifactId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113",
    correction: "  this was about the room, not the topic  ",
  }).correction).toBe("this was about the room, not the topic");
  expect(catchHistoryResponseSchema.parse({
    summary: { messageCount: 0, sharedMomentCount: 0, recurringThreadCount: 0, thingsTakingShapeCount: 0, radarCount: 0 },
    catches: [],
  }).catches).toEqual([]);
});

describe("trust boundaries", () => {
  it("accepts a bounded Sendblue dual-write envelope and strips unknown provider payload fields", () => {
    const parsed = ingestEnvelopeSchema.parse({
      idempotency_key: "sendblue:message-1", tenant_phone: "+15551234567", transport: "sendblue",
      direction: "inbound", external_message_id: "message-1", external_thread_id: "+15551234567",
      text: "https://example.com/video", media_urls: [], sent_at: "2026-07-20T19:00:00Z", status: null,
      reply_to_external_id: null, artifacts: [],
      transport_metadata: { source_version: "router.v1", raw: { authorization: "secret" } },
      provider_secret: "never retained",
    });
    expect(parsed.transport_metadata).toEqual({ source_version: "router.v1" });
    expect("provider_secret" in parsed).toBe(false);
  });

  it("accepts Linq as the same bounded transport contract", () => {
    const parsed = ingestEnvelopeSchema.parse({
      idempotency_key: "linq:message-1", tenant_phone: "+15551234567", transport: "linq",
      direction: "inbound", external_message_id: "message-1",
      external_thread_id: "8f392755-6865-4b18-880a-227f9d8b458f",
      text: "hello", media_urls: [], sent_at: "2026-07-20T19:00:00Z", status: null,
      reply_to_external_id: null, artifacts: [], transport_metadata: { source_version: "linq.v3" },
    });
    expect(parsed).toMatchObject({ transport: "linq", external_thread_id: "8f392755-6865-4b18-880a-227f9d8b458f" });
  });

  it("accepts additive timecoded conversation evidence without weakening the old envelope", () => {
    const parsed = ingestEnvelopeSchema.parse({
      idempotency_key: "sendblue:message-2", tenant_phone: "+15551234567", transport: "sendblue",
      direction: "inbound", external_message_id: "message-2", external_thread_id: "+15551234567",
      text: "call notes", media_urls: [], sent_at: "2026-07-20T19:00:00Z", status: null,
      reply_to_external_id: null,
      artifacts: [{
        source_type: "call", canonical_url: null, coverage: "text", extraction: null,
        consent_state: "participants_consented", provenance_class: "participant",
        segments: [{
          segment_key: "speaker-a:0", content_kind: "transcript", text: "Let's test this next week.",
          start_seconds: 10, end_seconds: 13, speaker_label: "speaker-a",
          speaker_relation: "other_person", provenance_class: "participant", confidence: 0.9,
        }],
      }],
      transport_metadata: {},
    });
    expect(parsed.artifacts[0]?.segments[0]).toMatchObject({ start_seconds: 10, speaker_label: "speaker-a" });
  });

  it("rejects empty messages, raw metadata, and status callbacks without transport ids", () => {
    const base = {
      idempotency_key: "sendblue:message-1", tenant_phone: "+15551234567", transport: "sendblue",
      direction: "outbound", external_message_id: null, external_thread_id: "+15551234567",
      text: null, media_urls: [], sent_at: "2026-07-20T19:00:00Z", status: null,
      reply_to_external_id: null, artifacts: [], transport_metadata: {},
    };
    expect(() => ingestEnvelopeSchema.parse(base)).toThrow(/requires text, media, or an artifact/);
    expect(() => ingestEnvelopeSchema.parse({ ...base, status: "READ" })).toThrow(/requires an external message id/);
  });

  it("rejects raw-content-shaped analytics", () => {
    expect(productEventSchema.parse({ name: "capture_created", occurredAt: "2026-07-20T19:00:00Z", properties: { sourceType: "url", sourceCoverage: "url_only" } }).properties.sourceType).toBe("url");
    expect(() => productEventSchema.parse({ name: "capture_created", occurredAt: "2026-07-20T19:00:00Z", properties: { sourceType: "url", rawText: "private" } })).toThrow();
    expect(() => productEventSchema.parse({ name: "capture_created", occurredAt: "2026-07-20T19:00:00Z", properties: { detail: "private thought under an innocent key" } })).toThrow();
  });

  it("requires three receipts and an alternative for patterns", () => {
    expect(() => patternCandidateSchema.parse({ statement: "you like running", supporting_evidence_ids: [artifactId], contradicting_evidence_ids: [], alternative_explanations: [], confidence: 0.9, novelty: 0.8, actionability: 0.5, sensitivity: "low", door_hypothesis: null, why_now: null })).toThrow();
  });

  it("cannot plan an autonomous external move", () => {
    expect(() => movePlanSchema.parse({ move_type: "draft_message", title: "Say congrats", steps: ["Draft"], external_effect: true, final_user_action_required: false, private_context_disclosed: false })).toThrow();
  });
});

it("validates a provider-mixed collaboration DAG with explicit token budgets", () => {
  const run = collaborationRunRequestSchema.parse({
    tenant_id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04110",
    idempotency_key: "collaboration:signal-review:1",
    objective: "Compare independent readings and synthesize cited findings.",
    evidence_packet: { artifact_ids: [artifactId], signal_ids: [], segment_ids: [] },
    agents: [
      {
        id: "researcher", name: "Researcher", objective: "Find facts.", instructions: "",
        model: { provider: "openai", model: "configured-openai-model", max_output_tokens: 500 },
      },
      {
        id: "skeptic", name: "Skeptic", objective: "Challenge leaps.", instructions: "",
        model: { provider: "anthropic", model: "configured-claude-model", max_output_tokens: 500 },
      },
      {
        id: "synthesizer", name: "Synthesizer", objective: "Reconcile.", instructions: "",
        model: { provider: "openai", model: "configured-openai-model", max_output_tokens: 500 },
        depends_on: ["researcher", "skeptic"],
      },
    ],
    synthesis_agent_id: "synthesizer",
    token_budget: { max_input_tokens: 10_000, max_output_tokens: 2_000, max_total_tokens: 12_000 },
    max_concurrency: 2,
    max_retries_per_task: 1,
  });
  expect(run.agents.map((agent) => agent.model.provider)).toEqual(["openai", "anthropic", "openai"]);
});

it("enforces the availability-only calendar boundary", () => {
  const sync = {
    source_id: "11111111-1111-4111-8111-111111111111",
    source_label: "Personal",
    access_mode: "availability_only",
    sync_cursor: null,
    full_sync: false,
    synced_at: "2026-07-30T19:00:00Z",
    events: [{
      external_id: "event-1",
      revision: "revision-1",
      starts_at: "2026-07-31T18:00:00Z",
      ends_at: "2026-07-31T19:00:00Z",
      timezone: "America/Los_Angeles",
      availability: "busy",
      title: null,
      location: null,
      notes: null,
      url: null,
    }],
    deleted_external_ids: [],
  };
  expect(calendarContextSyncSchema.parse(sync).access_mode).toBe("availability_only");
  expect(() => calendarContextSyncSchema.parse({
    ...sync,
    events: [{ ...sync.events[0], title: "Private title" }],
  })).toThrow(/availability-only/);
});
