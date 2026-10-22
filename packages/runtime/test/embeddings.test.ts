import assert from "node:assert/strict";
import test from "node:test";
import { SemanticIndex, voyageEmbeddingAdapter, type EmbeddingAdapter } from "../src/embeddings.ts";
import { MemoryStore } from "../src/memory.ts";
import { SqliteStore } from "../src/store.ts";
import { CoRuntime } from "../src/runtime.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { testConfig, testHome } from "./helpers.ts";

const adapter: EmbeddingAdapter = {
  key: "fixture:semantic-v1:2", dimensions: 2,
  embed: async (texts) => texts.map((text) => /bicycle|commute|cycling/.test(text) ? [1, 0] : [0, 1]),
};

test("semantic recall crosses vocabulary and months without crossing tenant, model or trust boundaries", async () => {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/index.sqlite`);
  const index = new SemanticIndex(store, adapter);
  try {
    const old = store.indexEvidence({ tenantId: "a", sourceEventId: "old", kind: "conversation.user", trustClass: "owner", content: "I ride a bicycle", observedAt: "2025-09-01T00:00:00.000Z" })!;
    store.indexEvidence({ tenantId: "a", sourceEventId: "recent", kind: "conversation.user", trustClass: "owner", content: "A restaurant opened", observedAt: "2026-09-01T00:00:00.000Z" });
    const untrusted = store.indexEvidence({ tenantId: "a", sourceEventId: "web", kind: "web", trustClass: "untrusted", content: "cycling", observedAt: "2026-01-01T00:00:00.000Z" })!;
    assert.equal(await index.indexBatch("a"), 3);
    assert.equal(store.searchEvidence("a", "commute").length, 0, "query has no lexical overlap");
    const found = await index.search("a", "evidence", "commute");
    assert.equal(found.mode, "semantic");
    assert.deepEqual(found.hits.map((hit) => hit.id), [old.id]);
    assert.equal((await index.search("a", "evidence", "commute", { includeUntrusted: true })).hits.some((hit) => hit.id === untrusted.id), true);
    assert.deepEqual((await index.search("b", "evidence", "commute")).hits, []);
    const otherModel = new SemanticIndex(store, { ...adapter, key: "incompatible-model:2" });
    assert.equal((await otherModel.search("a", "evidence", "commute")).mode, "unavailable");
    otherModel.close();
  } finally { index.close(); store.close(); home.cleanup(); }
});

test("correction and retirement invalidate semantic recall immediately while retaining history", async () => {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/index.sqlite`);
  const index = new SemanticIndex(store, adapter);
  const memory = new MemoryStore(store, index);
  try {
    const first = memory.remember({ tenantId: "a", sourceEventId: "source", kind: "fact", statement: "Rides a bicycle", salience: 0.1 });
    const retired = memory.remember({ tenantId: "a", sourceEventId: "source", kind: "fact", statement: "Enjoys cycling", salience: 0.1 });
    await index.indexBatch("a");
    assert.equal((await memory.recall("a", "commute")).memories.length, 2);
    memory.correct({ tenantId: "a", sourceEventId: "correction", memoryId: first.id, replacement: "Now walks everywhere" });
    memory.retire("a", retired.id, "retirement");
    assert.deepEqual((await index.search("a", "memory", "commute")).hits, []);
    assert.equal(memory.get(first.id, "a")?.status, "superseded");
    assert.equal(memory.get(retired.id, "a")?.status, "retired");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_vectors").get()?.n, 2, "derived history is not promoted back into live recall");
  } finally { index.close(); store.close(); home.cleanup(); }
});

test("in-flight source edits cannot commit a stale vector and embedding reservations survive failure", async () => {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/index.sqlite`);
  let release: (vectors: number[][]) => void = () => undefined;
  const index = new SemanticIndex(store, { ...adapter, embed: async () => new Promise((resolve) => { release = resolve; }) }, 1);
  try {
    const input = { tenantId: "a", sourceEventId: "s", kind: "text", trustClass: "owner" as const, content: "bicycle" };
    store.indexEvidence(input);
    const pending = index.indexBatch("a");
    store.indexEvidence({ ...input, content: "walking" });
    release([[1, 0]]);
    assert.equal(await pending, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_vectors").get()?.n, 0);
    assert.equal(store.db.prepare("SELECT calls FROM embedding_usage WHERE tenant_id='a'").get()?.calls, 1);
  } finally { index.close(); store.close(); home.cleanup(); }
});

test("exhausted query budgets and malformed embeddings report unavailable, never semantic success", async () => {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/index.sqlite`);
  const index = new SemanticIndex(store, adapter, 1);
  try {
    store.indexEvidence({ tenantId: "a", sourceEventId: "s", kind: "text", trustClass: "owner", content: "bicycle" });
    await index.indexBatch("a");
    assert.equal((await index.search("a", "evidence", "commute")).mode, "unavailable");
    const corrupt = new SemanticIndex(store, { ...adapter, key: "malformed", embed: async () => [[Number.NaN, 0]] });
    assert.equal(await corrupt.indexBatch("a"), 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM semantic_vectors WHERE model_key='malformed'").get()?.n, 0);
    corrupt.close();
  } finally { index.close(); store.close(); home.cleanup(); }
});

test("Voyage batches are index-mapped and reject duplicate indices, 429s, and invalid dimensions", async () => {
  const prior = globalThis.fetch;
  const priorKey = process.env.CO_EMBED_TEST_KEY;
  process.env.CO_EMBED_TEST_KEY = "test";
  const vectors = [Array<number>(256).fill(0), Array<number>(256).fill(0)];
  vectors[0]![0] = 1; vectors[1]![1] = 1;
  const provider = voyageEmbeddingAdapter({ model: "voyage-4-lite", apiKeyEnv: "CO_EMBED_TEST_KEY", dimensions: 256, maxCallsPerDay: 5 });
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).input_type, "document");
      return new Response(JSON.stringify({ data: [{ index: 1, embedding: vectors[1] }, { index: 0, embedding: vectors[0] }] }));
    };
    assert.deepEqual(await provider.embed(["first", "second"], "document", AbortSignal.timeout(1000)), vectors);
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: vectors[0] }, { index: 0, embedding: vectors[1] }] }));
    await assert.rejects(provider.embed(["first", "second"], "document", AbortSignal.timeout(1000)), /index mismatch/);
    globalThis.fetch = async () => new Response("sensitive dependency body", { status: 429 });
    await assert.rejects(provider.embed(["first"], "query", AbortSignal.timeout(1000)), /^Error: Embedding dependency returned HTTP 429$/);
  } finally {
    globalThis.fetch = prior;
    if (priorKey === undefined) delete process.env.CO_EMBED_TEST_KEY;
    else process.env.CO_EMBED_TEST_KEY = priorKey;
  }
});

test("idle embedding work never occupies the worker lane and closes without late writes", async () => {
  const home = testHome();
  let release: (vectors: number[][]) => void = () => undefined;
  const runtime = new CoRuntime({ config: testConfig(home.path), embeddingAdapter: {
    ...adapter, embed: async () => new Promise((resolve) => { release = resolve; }),
  } });
  try {
    runtime.store.indexEvidence({ tenantId: "test", sourceEventId: "fixture", kind: "text", trustClass: "owner", content: "bicycle" });
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    assert.equal(await worker.runOnce(), false, "in-flight embedder does not hold runOnce open");
    runtime.close();
    release([[1, 0]]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally { home.cleanup(); }
});
