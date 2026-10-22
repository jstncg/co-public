import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import type { ContentKind, EnrichedContent, MediaCoverage } from "../src/media.ts";
import type { ProviderAdapter } from "../src/types.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { testConfig, testHome } from "./helpers.ts";

test("text, link, screenshot, voice, and document deposits compose through durable foreground and backstage paths", async () => {
  const home = testHome();
  const providerRequests: string[] = [];
  const provider: ProviderAdapter = {
    name: "mock",
    complete: async (request) => {
      providerRequests.push(JSON.stringify(request));
      return { text: "Saved.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([provider]) });
  const sources = {
    link: "https://example.com/field-note",
    screenshot: "https://cdn.example.com/private/whiteboard.png?token=screenshot-secret",
    voice: "https://cdn.example.com/private/walk.m4a?token=voice-secret",
    document: "https://cdn.example.com/private/strategy.pdf?token=document-secret",
  };
  const result = (url: string): EnrichedContent => {
    const values: Record<string, { kind: ContentKind; coverage: MediaCoverage; title: string; content: string }> = {
      [sources.link]: { kind: "article", coverage: "fulltext", title: "Field note", content: "A durable article about adjacent possibility and patient execution." },
      [sources.screenshot]: { kind: "image", coverage: "multimodal", title: "Whiteboard", content: "Visible diagram connecting research, memory, and action." },
      [sources.voice]: { kind: "podcast", coverage: "transcript", title: "Walk note", content: "Transcript: the separate product ideas share one underlying counterpart thesis." },
      [sources.document]: { kind: "document", coverage: "document", title: "Strategy", content: "The long strategy document identifies selective initiative as the operational center." },
    };
    const selected = values[url];
    if (!selected) throw new Error(`Unexpected fixture URL ${url}`);
    return { ...selected, url, deferred: selected.kind !== "article", metadata: { pipelineVersion: 3, coverage: selected.coverage, fixture: true } };
  };
  try {
    await runtime.turn({ tenantId: "test", channel: "imessage", peerId: "member", externalId: "deposit-text", text: "A plain thought worth keeping." });
    await runtime.turn({ tenantId: "test", channel: "imessage", peerId: "member", externalId: "deposit-link", text: sources.link });
    await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member", externalId: "deposit-screenshot", text: "[attachment 1: image whiteboard.png]",
      attachments: [{ id: "screen", url: sources.screenshot, mimeType: "image/png", filename: "whiteboard.png" }],
    });
    await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member", externalId: "deposit-voice", text: "Thought from my walk.\n[attachment 1: audio walk.m4a]",
      attachments: [{ id: "voice", url: sources.voice, mimeType: "audio/mp4", filename: "walk.m4a" }],
    });
    await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member", externalId: "deposit-document", text: "Keep this for the company.\n[attachment 1: document strategy.pdf]",
      attachments: [{ id: "document", url: sources.document, mimeType: "application/pdf", filename: "strategy.pdf", sizeBytes: 9_000_000 }],
    });

    assert.equal(providerRequests.length, 5);
    assert.equal(providerRequests.some((request) => /(?:screenshot|voice|document)-secret/.test(request)), false);
    const enrichments = runtime.store.listJobs("test").filter((job) => job.type === "content.enrich");
    assert.equal(enrichments.length, 4, "plain text remains immediately retrievable without inventing media work");
    assert.equal(enrichments.every((job) => job.status === "queued"), true, "external inspection never blocks foreground completion");

    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null, contentEnricher: async (url) => result(url) });
    await worker.drain(50);
    const artifacts = runtime.store.db.prepare("SELECT kind,source_uri FROM artifacts WHERE tenant_id=? ORDER BY kind").all("test") as Array<{ kind: string; source_uri: string }>;
    assert.deepEqual(new Set(artifacts.map((artifact) => artifact.kind)), new Set(["article", "document", "image", "podcast"]));
    assert.equal(artifacts.find((artifact) => artifact.kind === "document")?.source_uri, sources.document, "the exact original reference remains durable");
    const coverages = runtime.store.listEvents("test", { type: "artifact.enriched" })
      .map((event) => (event.payload as { coverage?: string }).coverage);
    assert.deepEqual(new Set(coverages), new Set(["fulltext", "document", "multimodal", "transcript"]));
    const found = runtime.store.searchEvidence("test", "selective operational initiative", { trustClasses: ["untrusted"], limit: 5 });
    assert.equal(found.some((record) => record.content.includes("selective initiative")), true, "derived material is approximately retrievable with provenance");
  } finally {
    runtime.close();
    home.cleanup();
  }
});
