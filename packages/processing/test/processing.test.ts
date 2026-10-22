import { describe, expect, it, vi } from "vitest";
import { MockModelProvider } from "@co/model-gateway";
import { classifyExplicitRequest, enforceSignalProvenance, processArtifact } from "../src/index";

function fakeClient(existingResponse: unknown = null) {
  const remove = vi.fn(async () => ({ data: null, error: null }));
  const chain: any = {
    select: vi.fn(() => chain), eq: vi.fn(() => chain), is: vi.fn(() => chain), in: vi.fn(async () => ({ error: null })),
    update: vi.fn(() => chain), insert: vi.fn(() => chain), delete: vi.fn(() => chain), upsert: vi.fn(async () => ({ error: null })),
    maybeSingle: vi.fn(async () => ({ data: existingResponse, error: null })),
    single: vi.fn(async () => ({ data: {
      id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04112", user_id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04110",
      source_type: "text", source_coverage: "text", canonical_url: null, raw_text: "a room where people make things",
      user_note: null, analysis_allowed: true, processing_status: "queued",
    }, error: null })),
    then: (resolve: (value: unknown) => unknown) => resolve({ error: null }),
  };
  const client: any = { from: vi.fn(() => chain), schema: vi.fn(() => client), storage: { from: vi.fn(() => ({ remove })) } };
  return { client, chain, remove };
}

describe("artifact processing", () => {
  it("downgrades model-attributed user beliefs without first-party evidence", () => {
    const result = enforceSignalProvenance({
      signal_type: "preference",
      subject_relation: "user",
      statement: "The user prefers weekly studio practice.",
      confidence: 0.9,
      supporting_segment_keys: ["caption:0"],
      contradicting_segment_keys: [],
      uncertainty: null,
      sensitivity: "low",
    }, [{
      segment_key: "caption:0",
      content_kind: "caption",
      text: "Weekly studio practice changed my work.",
      start_offset: null,
      end_offset: null,
      start_seconds: 0,
      end_seconds: 4,
      speaker_label: null,
      speaker_relation: "source",
      provenance_class: "external",
      confidence: 1,
    }]);
    expect(result).toMatchObject({ subject_relation: "unknown", confidence: 0.5 });
  });

  it("does not treat ownership of a recording as proof that the user spoke a line", () => {
    const result = enforceSignalProvenance({
      signal_type: "commitment",
      subject_relation: "user",
      statement: "The user agreed to send the draft.",
      confidence: 0.92,
      supporting_segment_keys: ["call:0"],
      contradicting_segment_keys: [],
      uncertainty: null,
      sensitivity: "medium",
    }, [{
      segment_key: "call:0",
      content_kind: "turn",
      text: "I will send the draft.",
      start_offset: null,
      end_offset: null,
      start_seconds: 0,
      end_seconds: 3,
      speaker_label: "Speaker B",
      speaker_relation: "other_person",
      provenance_class: "owner",
      confidence: 0.95,
    }]);
    expect(result).toMatchObject({ subject_relation: "unknown", confidence: 0.5 });
  });

  it("serves explicit summary and humorous reaction intent before generic memory", () => {
    expect(classifyExplicitRequest("tl;dr please")).toBe("summary");
    expect(classifyExplicitRequest("this made me laugh")).toBe("react");
    expect(classifyExplicitRequest("keep this")).toBe("none");
  });

  it("is idempotent when a response already exists", async () => {
    const existing = { mode: "remember", response: "saved.", why_question: null, suggested_actions: [], confidence: 1, should_wait_for_user: false };
    const { client, chain } = fakeClient(existing);
    const result = await processArtifact(client, { artifactId: "a", userId: "u" }, new MockModelProvider());
    expect(result.status).toBe("already_complete");
    expect(chain.update).not.toHaveBeenCalled();
  });

  it("creates no derived state when analysis is not allowed", async () => {
    const { client, chain } = fakeClient();
    chain.single.mockResolvedValueOnce({ data: {
      id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04112",
      user_id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04110",
      source_type: "call",
      source_coverage: "full_media",
      canonical_url: null,
      raw_text: "A private transcript.",
      user_note: null,
      analysis_allowed: false,
      processing_status: "saved_without_analysis",
    }, error: null });
    await expect(processArtifact(client, { artifactId: "a", userId: "u", signalRefineryEnabled: true }, new MockModelProvider()))
      .rejects.toThrow(/analysis is not allowed/);
    expect(chain.insert).not.toHaveBeenCalled();
    expect(chain.update).not.toHaveBeenCalled();
  });

  it("records a schema-valid result and marks the artifact ready", async () => {
    const { client, chain } = fakeClient();
    chain.single
      .mockResolvedValueOnce({ data: {
        id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04112", user_id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04110",
        source_type: "text", source_coverage: "text", canonical_url: null, raw_text: "a room where people make things",
        user_note: null, analysis_allowed: true, processing_status: "queued",
      }, error: null })
      .mockResolvedValueOnce({ data: { id: "run-1" }, error: null });
    const result = await processArtifact(client, { artifactId: "a", userId: "u" }, new MockModelProvider());
    expect(result.status).toBe("ready");
    expect(chain.upsert).toHaveBeenCalled();
    expect(chain.update).toHaveBeenCalledWith({ processing_status: "ready" });
    expect(chain.delete).toHaveBeenCalledTimes(2);
    expect(chain.eq).toHaveBeenCalledWith("observation_type", "source_content");
  });

  it("upgrades URL-only coverage only after an SSRF-safe article loader returns visible text", async () => {
    const { client, chain } = fakeClient();
    chain.single
      .mockResolvedValueOnce({ data: {
        id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04112", user_id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04110",
        source_type: "article", source_coverage: "url_only", canonical_url: "https://example.com/article", raw_text: null,
        user_note: "summarize", analysis_allowed: true, processing_status: "queued",
      }, error: null })
      .mockResolvedValueOnce({ data: { id: "run-1" }, error: null });
    const mock = new MockModelProvider();
    const provider = {
      extractArtifact: vi.fn(mock.extractArtifact.bind(mock)),
      generateImmediateResponse: vi.fn(mock.generateImmediateResponse.bind(mock)),
      transcribeAudio: vi.fn(mock.transcribeAudio.bind(mock)),
      embedText: vi.fn(mock.embedText.bind(mock)),
      generatePatternCandidate: vi.fn(mock.generatePatternCandidate.bind(mock)),
    };
    const loader = vi.fn(async () => ({
      canonicalUrl: "https://example.com/article", title: "Public article", publisher: "Example", author: "Writer",
      publishedAt: "2026-07-19T00:00:00Z", description: "A description", text: "The visible article text.",
      receipt: { adapter: "public-article", adapterVersion: "public-article.v1", canonicalUrl: "https://example.com/article", title: "Public article", publisher: "Example", retrievedAt: "2026-07-20T00:00:00Z", coverage: "text" as const, contentHash: "abc", metadata: {} },
    }));

    const result = await processArtifact(client, { artifactId: "a", userId: "u" }, provider, loader);
    expect(result.status).toBe("ready");
    expect(provider.extractArtifact).toHaveBeenCalledWith(expect.objectContaining({ sourceCoverage: "text", normalizedText: "The visible article text." }));
    expect(client.from).toHaveBeenCalledWith("source_receipts");
  });

  it("transcribes voice, persists searchable text, and removes raw audio only after the transcript is durable", async () => {
    const { client, chain, remove } = fakeClient();
    chain.single
      .mockResolvedValueOnce({ data: {
        id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04112", user_id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04110",
        source_type: "voice", source_coverage: "full_media", canonical_url: null, raw_text: null, transcript: null,
        raw_object_path: "user/artifact/voice.m4a", mime_type: null, retention_mode: "delete_after_processing",
        user_note: null, analysis_allowed: true, processing_status: "queued",
      }, error: null })
      .mockResolvedValueOnce({ data: { id: "extraction-run" }, error: null })
      .mockResolvedValueOnce({ data: { id: "response-run" }, error: null });
    const mock = new MockModelProvider();
    const provider = {
      transcribeAudio: vi.fn(async () => ({
        value: "I want to try a shared studio session.",
        meta: { provider: "mock", model: "audio", promptVersion: "audio-transcription.v1", schemaVersion: "transcript.v1", latencyMs: 0, inputTokens: null, outputTokens: null, uncertaintyCount: 0 },
      })),
      extractArtifact: vi.fn(mock.extractArtifact.bind(mock)),
      generateImmediateResponse: vi.fn(mock.generateImmediateResponse.bind(mock)),
      embedText: vi.fn(mock.embedText.bind(mock)),
      generatePatternCandidate: vi.fn(mock.generatePatternCandidate.bind(mock)),
    };
    const mediaLoader = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mimeType: "audio/m4a" }));

    const result = await processArtifact(client, { artifactId: "a", userId: "u" }, provider, undefined, mediaLoader);

    expect(result.status).toBe("ready");
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ transcript: "I want to try a shared studio session." }));
    expect(remove).toHaveBeenCalledWith(["user/artifact/voice.m4a"]);
    expect(chain.update).toHaveBeenCalledWith({ raw_object_path: null });
    expect(provider.extractArtifact).toHaveBeenCalledWith(expect.objectContaining({ normalizedText: "I want to try a shared studio session." }));
    expect(client.from).toHaveBeenCalledWith("artifact_segments");
    expect(client.from).toHaveBeenCalledWith("observations");
  });

  it("passes supported private images to the vision boundary without inventing text", async () => {
    const { client, chain } = fakeClient();
    chain.single
      .mockResolvedValueOnce({ data: {
        id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04112", user_id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04110",
        source_type: "image", source_coverage: "image", canonical_url: null, raw_text: null, transcript: null,
        raw_object_path: "user/artifact/photo.jpg", mime_type: null, retention_mode: "default",
        user_note: null, analysis_allowed: true, processing_status: "queued",
      }, error: null })
      .mockResolvedValueOnce({ data: { id: "extraction-run" }, error: null })
      .mockResolvedValueOnce({ data: { id: "response-run" }, error: null });
    const mock = new MockModelProvider();
    const provider = {
      transcribeAudio: vi.fn(mock.transcribeAudio.bind(mock)),
      embedText: vi.fn(mock.embedText.bind(mock)),
      extractArtifact: vi.fn(mock.extractArtifact.bind(mock)),
      generateImmediateResponse: vi.fn(mock.generateImmediateResponse.bind(mock)),
      generatePatternCandidate: vi.fn(mock.generatePatternCandidate.bind(mock)),
    };
    const result = await processArtifact(
      client, { artifactId: "a", userId: "u" }, provider, undefined,
      async () => ({ data: new Uint8Array([255, 216, 255]), mimeType: "image/jpeg" }),
    );
    expect(result.status).toBe("ready");
    expect(provider.extractArtifact).toHaveBeenCalledWith(expect.objectContaining({
      normalizedText: null,
      imageDataUrl: "data:image/jpeg;base64,/9j/",
    }));
  });
});
