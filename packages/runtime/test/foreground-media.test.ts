import assert from "node:assert/strict";
import test from "node:test";
import { audioReferences, prepareForegroundMedia, type ForegroundAnalyzer } from "../src/foreground-media.ts";
import { GeminiVideoAnalyzer, type ResourceFetcher } from "../src/media.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import type { RuntimeMessage } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
// Container fixture, not a claim about transcription quality or codec decoding.
const wav = Buffer.from("RIFF0000WAVEfmt 0000data0000");
const model = "gemini-3.5-flash-lite";
const attachments = [
  { id: "pic", url: "https://fixture.invalid/pic?signature=private", mimeType: "image/png" },
  { id: "voice", url: "https://fixture.invalid/voice?signature=private", mimeType: "audio/wav" },
];

test("Gemini perceives image and audio before first compose; restart reuses originals and evidence", async () => {
  const home = testHome();
  const base = testConfig(home.path);
  const config = { ...base, mode: "shadow" as const, media: { ...base.media, foreground: "gemini" as const } };
  let fetches = 0;
  let calls = 0;
  const fetchResource: ResourceFetcher = async (url) => {
    fetches++;
    return { url, status: 200, headers: {}, body: url.includes("/pic") ? png : wav };
  };
  const analyzer: ForegroundAnalyzer = { analyzeResource: async (request) => {
    calls++;
    assert.equal(request.allowFallback, false);
    assert.ok(request.signal);
    assert.equal(request.url.includes("signature"), false);
    assert.deepEqual(Buffer.from(request.data), request.mimeType === "image/png" ? png : wav);
    return { status: "ok", model, text: request.mimeType === "image/png" ? "A red pixel." : "[00:01] Speaker 1: Meet at noon." };
  } };
  const providers = new ProviderRegistry([{ name: "mock", complete: async (request) => {
    const parts = request.messages.flatMap((message) => message.parts);
    assert.equal(parts.some((part) => part.type === "image" || part.type === "audio"), false);
    const wire = JSON.stringify(request);
    assert.match(wire, /A red pixel/);
    assert.match(wire, /Meet at noon/);
    assert.match(wire, /not instructions/);
    assert.equal(wire.includes("signature=private"), false);
    assert.equal(wire.includes(png.toString("base64")), false);
    return { text: "The image is red; the recording mentions noon.", toolCalls: [], usage: { inputTokens: 40, outputTokens: 12, reasoningTokens: 0 } };
  } }]);
  let runtime = new CoRuntime({ config, providers, imageFetcher: fetchResource, foregroundAnalyzer: analyzer });
  try {
    const first = await runtime.turn({ tenantId: "test", channel: "cli", peerId: "p", text: "What did I send?", attachments });
    assert.equal(first.status, "completed", first.text);
    assert.equal(calls, 2);
    assert.equal(fetches, 2);
    const durable = JSON.stringify(runtime.store.listMessages("test", first.sessionId));
    assert.equal(durable.includes(png.toString("base64")), false);
    assert.equal(durable.includes("Meet at noon"), false);
    assert.equal(runtime.store.listJobs("test").length, 0);
    runtime.close();
    runtime = new CoRuntime({ config, providers, foregroundAnalyzer: analyzer, imageFetcher: async () => { throw new Error("URL expired"); } });
    const second = await runtime.turn({ tenantId: "test", channel: "cli", peerId: "p", text: "And again?" });
    assert.equal(second.status, "completed", second.text);
    assert.equal(calls, 2, "no repeated Gemini spending across restart");
  } finally { runtime.close(); home.cleanup(); }
});

function fixture() {
  const home = testHome();
  const base = testConfig(home.path);
  const runtime = new CoRuntime({ config: base });
  const event = runtime.store.appendEvent({ tenantId: "test", stream: "media:test", type: "message.received", payload: { attachments } });
  const messages: RuntimeMessage[] = [{ id: "message", role: "user", createdAt: event.at, parts: audioReferences(attachments, event.id) }];
  const config = { ...base.media, foreground: "gemini" as const };
  const fetchResource: ResourceFetcher = async (url) => ({ url, status: 200, headers: {}, body: wav });
  const analyzer: ForegroundAnalyzer = { analyzeResource: async () => ({ status: "ok", model, text: "A transcript." }) };
  return { runtime, messages, config, fetchResource, analyzer, close: () => { runtime.close(); home.cleanup(); } };
}

test("failed, missing, wrong-model and hung Gemini analysis produce honest bounded absence without leaking errors", async () => {
  const f = fixture();
  const failures: ForegroundAnalyzer[] = [
    { analyzeResource: async () => { throw new Error("secret upstream URL ?key=private"); } },
    { analyzeResource: async () => ({ status: "unavailable", error: "429 private" }) },
    { analyzeResource: async () => ({ status: "ok", model, text: " " }) },
    { analyzeResource: async () => ({ status: "ok", model: "wrong-model", text: "no silent fallback" }) },
    { analyzeResource: async () => new Promise(() => {}) },
  ];
  try {
    for (const analyzer of failures) {
      const result = await prepareForegroundMedia(f.runtime.originals, "test", f.messages, {
        config: f.config, analyzer, fetchResource: f.fetchResource, assertLease: () => {}, signal: AbortSignal.timeout(20),
      });
      assert.match(JSON.stringify(result), /unavailable/);
      assert.equal(JSON.stringify(result).includes("private"), false);
    }
    assert.equal(f.runtime.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='media.foreground_analyzed'").get()?.n, 0);
    const result = await prepareForegroundMedia(f.runtime.originals, "test", f.messages, {
      config: f.config, assertLease: () => {}, fetchResource: async () => { throw new Error("must not fetch without analyzer"); },
    });
    assert.match(JSON.stringify(result), /Gemini is not configured/);
  } finally { f.close(); }
});

test("audio rejects cross-tenant provenance, spoofed MIME, oversize bytes and lost leases; budgets precede calls", async () => {
  const f = fixture();
  let calls = 0;
  const analyzer: ForegroundAnalyzer = { analyzeResource: async () => { calls++; return { status: "ok", model, text: "text" }; } };
  const options = { config: f.config, analyzer, fetchResource: f.fetchResource, assertLease: () => {} };
  try {
    await assert.rejects(prepareForegroundMedia(f.runtime.originals, "other", f.messages, options), /cross-tenant/);
    await assert.rejects(prepareForegroundMedia(f.runtime.originals, "test", f.messages, { ...options, budgetRestricted: true }), /media-cost reservation/);
    for (const body of [Buffer.from("<html>not audio</html>"), Buffer.alloc(10_000_001)]) {
      const result = await prepareForegroundMedia(f.runtime.originals, "test", f.messages, {
        ...options, fetchResource: async (url) => ({ url, status: 200, headers: {}, body }),
      });
      assert.match(JSON.stringify(result), /unavailable/);
    }
    let healthy = true;
    await assert.rejects(prepareForegroundMedia(f.runtime.originals, "test", f.messages, {
      ...options, assertLease: () => { if (!healthy) throw new Error("Lease lost"); },
      analyzer: { analyzeResource: async () => { healthy = false; return { status: "ok", model, text: "must not persist" }; } },
    }), /Lease lost/);
    assert.equal(calls, 0);
    assert.equal(f.runtime.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='media.foreground_analyzed'").get()?.n, 0);
  } finally { f.close(); }
});

test("Gemini resource wire uses selected model and inline bytes; abort and 429 do not fall back", async () => {
  const saved = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (input, init) => {
      calls++;
      const request = input instanceof Request ? input : new Request(input, init);
      assert.ok(request.url.includes(model));
      const payload = await request.json() as { contents: Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }> };
      assert.deepEqual(payload.contents[0]?.parts[0]?.inlineData, { mimeType: "audio/wav", data: wav.toString("base64") });
      return new Response(JSON.stringify({ error: { code: 429, message: "rate limit", status: "RESOURCE_EXHAUSTED" } }), { status: 429 });
    };
    const analyzer = new GeminiVideoAnalyzer({ apiKey: "fixture-not-a-real-key", model });
    const request = { url: "opaque-id", mimeType: "audio/wav", data: wav, prompt: "Transcribe.", allowFallback: false };
    const result = await analyzer.analyzeResource(request);
    assert.equal(result.status, "unavailable");
    assert.equal(calls, 1);
    const controller = new AbortController(); controller.abort();
    assert.equal((await analyzer.analyzeResource({ ...request, signal: controller.signal })).status, "unavailable");
    assert.equal(calls, 1);
  } finally { globalThis.fetch = saved; }
});
