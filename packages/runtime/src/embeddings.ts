import { createHash } from "node:crypto";
import { withAbort } from "./abort.ts";
import { nowIso } from "./id.ts";
import { readSecret } from "./secrets.ts";
import type { SqliteStore } from "./store.ts";
import type { RuntimeConfig } from "./types.ts";

type Kind = "memory" | "evidence";
export interface EmbeddingAdapter {
  /** Includes provider, model, dimension and preprocessing version. */
  readonly key: string;
  readonly dimensions: number;
  embed(texts: string[], purpose: "query" | "document", signal: AbortSignal): Promise<number[][]>;
}

function normalized(vector: number[], dimensions: number): number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) throw new Error("Invalid embedding dimensions or values");
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm <= 0) throw new Error("Embedding has no finite direction");
  return vector.map((value) => value / norm);
}

function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }

export function voyageEmbeddingAdapter(config: NonNullable<RuntimeConfig["embeddings"]>): EmbeddingAdapter {
  if (!config.model.trim() || ![256, 512, 1024, 2048].includes(config.dimensions)) throw new Error("An explicit embedding model and supported dimensions are required");
  return {
    key: `voyage:${config.model}:${config.dimensions}:float:prefix-v1`, dimensions: config.dimensions,
    async embed(texts, purpose, signal) {
      const key = readSecret(config.apiKeyEnv);
      if (!key) throw new Error("Embedding credential is unavailable");
      const response = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST", signal, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ input: texts, model: config.model, input_type: purpose, output_dimension: config.dimensions, output_dtype: "float", truncation: false }),
      });
      // Do not propagate a dependency's response body: it can contain input or
      // credentials. Input, batch and dimension limits bound valid responses.
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Embedding dependency returned HTTP ${response.status}`); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Embedding dependency returned no body");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 2_000_000) throw new Error("Embedding response exceeds the bounded envelope");
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: Array<{ index?: number; embedding?: number[] }> };
      if (!Array.isArray(body.data) || body.data.length !== texts.length) throw new Error("Embedding batch cardinality mismatch");
      const result = Array<number[]>(texts.length);
      for (const item of body.data) {
        if (!Number.isInteger(item.index) || item.index! < 0 || item.index! >= texts.length || result[item.index!] || !item.embedding) throw new Error("Embedding batch index mismatch");
        result[item.index!] = normalized(item.embedding, config.dimensions);
      }
      return result;
    },
  };
}

interface Candidate { id: string; source_event_id: string; content: string; observed_at: string; trust_class: string }
export interface SemanticHit { id: string; sourceEventId: string; score: number; content: string; observedAt: string; trustClass: string }

/** SQLite cell implementation behind a replaceable embedding interface. No
 * async work occurs in memory writes. Rank against current source projections,
 * not stale vectors, so correction/retirement takes effect immediately. */
export class SemanticIndex {
  private readonly cache = new Map<string, { expires: number; vector: number[] }>();
  private nextBatchAt = 0;
  private failures = 0;
  private readonly lifecycle = new AbortController();
  private background: Promise<void> | undefined;
  readonly store: SqliteStore;
  readonly adapter: EmbeddingAdapter;
  readonly maxCallsPerDay: number;
  constructor(store: SqliteStore, adapter: EmbeddingAdapter, maxCallsPerDay = 500) {
    this.store = store;
    this.adapter = adapter;
    this.maxCallsPerDay = maxCallsPerDay;
    if (!adapter.key || adapter.key.length > 256 || !Number.isInteger(adapter.dimensions) || adapter.dimensions < 1 || adapter.dimensions > 4096
      || !Number.isSafeInteger(maxCallsPerDay) || maxCallsPerDay < 1 || maxCallsPerDay > 100_000) throw new Error("Invalid semantic index configuration");
  }

  close(): void { this.lifecycle.abort(); }

  indexInBackground(tenantId: string): void {
    if (this.background || this.lifecycle.signal.aborted) return;
    this.background = this.indexBatch(tenantId).then(() => undefined, () => undefined).finally(() => { this.background = undefined; });
  }

  private reserve(tenantId: string): void {
    const day = nowIso().slice(0, 10);
    this.store.transaction(() => {
      this.store.db.prepare("INSERT OR IGNORE INTO embedding_usage(tenant_id,day,calls) VALUES(?,?,0)").run(tenantId, day);
      if (this.store.db.prepare("UPDATE embedding_usage SET calls=calls+1 WHERE tenant_id=? AND day=? AND calls<?")
        .run(tenantId, day, this.maxCallsPerDay).changes !== 1) throw new Error("Embedding daily call budget exhausted");
    });
  }

  private sourceSql(kind: Kind): string {
    return kind === "memory"
      ? "SELECT id,source_event_id,statement AS content,observed_at,'memory' AS trust_class FROM memories WHERE tenant_id=? AND status='active'"
      : "SELECT id,source_event_id,content,observed_at,trust_class FROM evidence WHERE tenant_id=?";
  }

  /** One small batch per idle worker pass, including historical backfill. */
  async indexBatch(tenantId: string): Promise<number> {
    if (this.lifecycle.signal.aborted || Date.now() < this.nextBatchAt) return 0;
    this.nextBatchAt = Date.now() + 5_000;
    for (const kind of ["memory", "evidence"] as const) {
      const records = this.store.db.prepare(`SELECT s.* FROM (${this.sourceSql(kind)}) s
        LEFT JOIN semantic_vectors v ON v.tenant_id=? AND v.kind=? AND v.record_id=s.id AND v.model_key=?
        WHERE v.record_id IS NULL ORDER BY s.observed_at,s.id LIMIT 16`).all(tenantId, tenantId, kind, this.adapter.key) as unknown as Candidate[];
      if (!records.length) continue;
      try {
        this.reserve(tenantId);
        // The prefix is versioned in model_key. Original text is never truncated
        // in storage; this is an explicit retrieval representation, not a claim
        // of complete document comprehension.
        const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(10_000)]);
        const vectors = await withAbort(this.adapter.embed(records.map((row) => row.content.slice(0, 4_000)), "document", signal), signal);
        if (this.lifecycle.signal.aborted) return 0;
        if (vectors.length !== records.length) throw new Error("Embedding batch cardinality mismatch");
        const validated = vectors.map((vector) => normalized(vector, this.adapter.dimensions));
        const written = this.store.transaction(() => {
          let count = 0;
          for (const [index, row] of records.entries()) {
            const current = this.store.db.prepare(`SELECT content FROM (${this.sourceSql(kind)}) WHERE id=?`).get(tenantId, row.id) as { content: string } | undefined;
            if (!current || current.content !== row.content) continue;
            const vector = Buffer.alloc(this.adapter.dimensions * 4);
            validated[index]!.forEach((value, offset) => vector.writeFloatLE(value, offset * 4));
            count += Number(this.store.db.prepare(`INSERT OR IGNORE INTO semantic_vectors(tenant_id,kind,record_id,model_key,content_digest,dimensions,vector,indexed_at)
              VALUES(?,?,?,?,?,?,?,?)`).run(tenantId, kind, row.id, this.adapter.key, digest(row.content), this.adapter.dimensions, vector, nowIso()).changes);
          }
          return count;
        });
        this.failures = 0;
        return written;
      } catch {
        if (this.lifecycle.signal.aborted) return 0;
        this.failures += 1;
        this.nextBatchAt = Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(this.failures, 7));
        this.store.appendEvent({ tenantId, stream: "retrieval:health", type: "embedding.batch_failed", payload: { modelKey: this.adapter.key, retryAfter: new Date(this.nextBatchAt).toISOString() } });
        return 0;
      }
    }
    return 0;
  }

  async search(tenantId: string, kind: Kind, query: string, options: { limit?: number; includeUntrusted?: boolean } = {}): Promise<{
    mode: "semantic" | "unavailable"; hits: SemanticHit[];
  }> {
    if (this.lifecycle.signal.aborted) return { mode: "unavailable", hits: [] };
    if (!query.trim()) return { mode: "semantic", hits: [] };
    try {
      // Do not spend a query embedding when this tenant/model has no index.
      if (!this.store.db.prepare("SELECT 1 FROM semantic_vectors WHERE tenant_id=? AND kind=? AND model_key=? LIMIT 1").get(tenantId, kind, this.adapter.key)) return { mode: "unavailable", hits: [] };
      const key = `${tenantId}:${digest(query.slice(0, 4_000))}`;
      const cached = this.cache.get(key);
      let vector = cached && cached.expires > Date.now() ? cached.vector : undefined;
      if (!vector) {
        this.reserve(tenantId);
        const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(1_200)]);
        const batch = await withAbort(this.adapter.embed([query.slice(0, 4_000)], "query", signal), signal);
        if (this.lifecycle.signal.aborted) return { mode: "unavailable", hits: [] };
        if (batch.length !== 1) throw new Error("Embedding query cardinality mismatch");
        vector = normalized(batch[0]!, this.adapter.dimensions);
        if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { expires: Date.now() + 300_000, vector });
      }
      const ranked: SemanticHit[] = [];
      const rows = this.store.db.prepare(`SELECT s.*,v.vector,v.dimensions,v.content_digest FROM (${this.sourceSql(kind)}) s
        JOIN semantic_vectors v ON v.record_id=s.id AND v.tenant_id=? AND v.kind=? AND v.model_key=?
        WHERE (s.trust_class IN ('owner','agent','memory') OR (?=1 AND s.trust_class='untrusted'))`).iterate(tenantId, tenantId, kind, this.adapter.key, options.includeUntrusted ? 1 : 0);
      for (const raw of rows) {
        const row = raw as unknown as Candidate & { vector: Uint8Array; dimensions: number; content_digest: string };
        if (row.dimensions !== vector.length || row.vector.byteLength !== vector.length * 4 || digest(row.content) !== row.content_digest) continue;
        const bytes = Buffer.from(row.vector);
        let score = 0;
        let norm = 0;
        for (let index = 0; index < vector.length; index += 1) {
          const value = bytes.readFloatLE(index * 4);
          score += vector[index]! * value; norm += value * value;
        }
        if (Number.isFinite(score) && Math.abs(norm - 1) < 0.001 && score >= 0.25 && score <= 1.001) ranked.push({ id: row.id, sourceEventId: row.source_event_id, score, content: row.content, observedAt: row.observed_at, trustClass: row.trust_class });
      }
      ranked.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
      const limit = Math.max(1, Math.min(30, options.limit ?? 8));
      const hits: SemanticHit[] = [];
      const months = new Map<string, number>();
      for (const hit of ranked) {
        const month = hit.observedAt.slice(0, 7);
        if ((months.get(month) ?? 0) >= 2 && ranked.some((candidate) => !months.has(candidate.observedAt.slice(0, 7)))) continue;
        hits.push(hit); months.set(month, (months.get(month) ?? 0) + 1);
        if (hits.length === limit) break;
      }
      return { mode: "semantic", hits };
    } catch { return { mode: "unavailable", hits: [] }; }
  }
}
