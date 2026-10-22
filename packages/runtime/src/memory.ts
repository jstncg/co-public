import { id, nowIso } from "./id.ts";
import type { JsonObject, MemoryContext, MemoryKind, MemoryRecord, MemoryStatus } from "./types.ts";
import { SqliteStore } from "./store.ts";
import type { SemanticIndex } from "./embeddings.ts";

type Row = Record<string, string | number | bigint | null | Uint8Array>;

const CARRIED_KINDS = new Set<MemoryKind>(["identity", "preference", "pattern", "goal"]);
const STOP = new Set(["a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have", "i", "in", "is", "it", "me", "my", "of", "on", "or", "that", "the", "this", "to", "was", "we", "with", "you", "your"]);

function normalize(statement: string): string {
  return statement.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(statement: string): Set<string> {
  return new Set(normalize(statement).split(" ").filter((token) => token.length > 1 && !STOP.has(token)));
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return common / Math.sqrt(left.size * right.size);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function fromRow(row: Row): MemoryRecord {
  const validTo = typeof row.valid_to === "string" && row.valid_to ? row.valid_to : undefined;
  const lastConfirmedAt = typeof row.last_confirmed_at === "string" && row.last_confirmed_at ? row.last_confirmed_at : undefined;
  const supersedesId = typeof row.supersedes_id === "string" && row.supersedes_id ? row.supersedes_id : undefined;
  return {
    id: String(row.id), tenantId: String(row.tenant_id), kind: String(row.kind) as MemoryKind,
    statement: String(row.statement), confidence: Number(row.confidence), salience: Number(row.salience),
    status: String(row.status) as MemoryStatus, validFrom: String(row.valid_from), ...(validTo ? { validTo } : {}),
    observedAt: String(row.observed_at), ...(lastConfirmedAt ? { lastConfirmedAt } : {}),
    sourceEventId: String(row.source_event_id), ...(supersedesId ? { supersedesId } : {}),
    userConfirmed: Number(row.user_confirmed) === 1,
  };
}

export interface RememberInput {
  tenantId: string;
  kind: MemoryKind;
  statement: string;
  sourceEventId: string;
  confidence?: number;
  salience?: number;
  observedAt?: string;
  userConfirmed?: boolean;
  status?: MemoryStatus;
  supersedesId?: string;
}

export class MemoryStore {
  readonly store: SqliteStore;
  readonly semantic: SemanticIndex | undefined;

  constructor(store: SqliteStore, semantic?: SemanticIndex) {
    this.store = store;
    this.semantic = semantic;
  }

  async recall(tenantId: string, query: string, limit = 8): Promise<{ mode: "hybrid" | "lexical"; memories: MemoryRecord[] }> {
    const lexical = this.context(tenantId, query, { carriedLimit: 0, retrievedLimit: limit }).retrieved;
    const result = await this.semantic?.search(tenantId, "memory", query, { limit });
    if (!result || result.mode !== "semantic") return { mode: "lexical", memories: lexical };
    const semantic = result.hits.map((hit) => this.get(hit.id, tenantId)).filter((memory): memory is MemoryRecord => memory?.status === "active");
    const memories = [...semantic, ...lexical].filter((memory, index, all) => all.findIndex((item) => item.id === memory.id) === index).slice(0, limit);
    return { mode: "hybrid", memories };
  }

  remember(input: RememberInput): MemoryRecord {
    const statement = input.statement.trim();
    if (!statement) throw new Error("Memory statement cannot be empty");
    const normalized = normalize(statement);
    const current = nowIso();
    const existingRow = this.store.db.prepare(
      "SELECT * FROM memories WHERE tenant_id=? AND normalized_statement=? AND status='active' ORDER BY user_confirmed DESC, confidence DESC LIMIT 1",
    ).get(input.tenantId, normalized) as Row | undefined;
    if (existingRow) {
      const existing = fromRow(existingRow);
      const confidence = Math.max(existing.confidence, clamp(input.confidence ?? 0.6));
      const salience = Math.max(existing.salience, clamp(input.salience ?? 0.5));
      const confirmed = existing.userConfirmed || Boolean(input.userConfirmed);
      this.store.db.prepare("UPDATE memories SET confidence=?,salience=?,last_confirmed_at=?,user_confirmed=? WHERE id=?")
        .run(confidence, salience, confirmed ? current : existing.lastConfirmedAt ?? null, confirmed ? 1 : 0, existing.id);
      this.store.appendEvent({
        tenantId: input.tenantId, stream: `memory:${existing.id}`, type: "memory.reobserved", causationId: input.sourceEventId,
        payload: { memoryId: existing.id, sourceEventId: input.sourceEventId, confidence, salience, userConfirmed: confirmed },
      });
      return this.get(existing.id, input.tenantId) as MemoryRecord;
    }

    const memoryId = id("mem");
    const observedAt = input.observedAt ?? current;
    this.store.db.prepare(`INSERT INTO memories(
      id,tenant_id,kind,statement,normalized_statement,confidence,salience,status,valid_from,observed_at,last_confirmed_at,source_event_id,supersedes_id,user_confirmed
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      memoryId, input.tenantId, input.kind, statement, normalized, clamp(input.confidence ?? 0.6), clamp(input.salience ?? 0.5),
      input.status ?? "active", observedAt, observedAt, input.userConfirmed ? current : null, input.sourceEventId,
      input.supersedesId ?? null, input.userConfirmed ? 1 : 0,
    );
    this.store.appendEvent({
      tenantId: input.tenantId,
      stream: `memory:${memoryId}`,
      type: "memory.remembered",
      causationId: input.sourceEventId,
      payload: { memoryId, kind: input.kind, statement, confidence: clamp(input.confidence ?? 0.6), salience: clamp(input.salience ?? 0.5) },
    });
    return this.get(memoryId, input.tenantId) as MemoryRecord;
  }

  correct(input: {
    tenantId: string;
    memoryId: string;
    replacement: string;
    sourceEventId: string;
    kind?: MemoryKind;
  }): MemoryRecord {
    const old = this.get(input.memoryId, input.tenantId);
    if (!old) throw new Error(`Unknown memory ${input.memoryId}`);
    const current = nowIso();
    return this.store.transaction(() => {
      this.store.db.prepare("UPDATE memories SET status='superseded',valid_to=? WHERE id=? AND tenant_id=?")
        .run(current, old.id, input.tenantId);
      const replacement = this.remember({
        tenantId: input.tenantId,
        kind: input.kind ?? old.kind,
        statement: input.replacement,
        sourceEventId: input.sourceEventId,
        confidence: 1,
        salience: Math.max(0.8, old.salience),
        observedAt: current,
        userConfirmed: true,
        supersedesId: old.id,
      });
      this.store.appendEvent({
        tenantId: input.tenantId,
        stream: `memory:${old.id}`,
        type: "memory.corrected",
        causationId: input.sourceEventId,
        payload: { oldMemoryId: old.id, replacementMemoryId: replacement.id, replacement: input.replacement },
      });
      return replacement;
    });
  }

  retire(tenantId: string, memoryId: string, sourceEventId: string): void {
    const existing = this.get(memoryId, tenantId);
    if (!existing) throw new Error("Memory is missing or belongs to another tenant");
    if (existing.status === "retired") return;
    if (existing.status !== "active") throw new Error("Only an active memory can be retired");
    const current = nowIso();
    this.store.db.prepare("UPDATE memories SET status='retired',valid_to=? WHERE id=? AND tenant_id=?").run(current, memoryId, tenantId);
    this.store.appendEvent({
      tenantId, stream: `memory:${memoryId}`, type: "memory.retired", causationId: sourceEventId, payload: { memoryId },
    });
  }

  /** Model-controlled edits require source text, not the model's confidence
   * that the member meant something. Direct operator migration methods remain
   * separate and preserve their own provenance. */
  ownerText(tenantId: string, sourceEventId: string): string {
    const source = this.store.getEvent(tenantId, sourceEventId);
    const evidence = this.store.db.prepare("SELECT 1 FROM evidence WHERE tenant_id=? AND source_event_id=? AND kind='conversation.user' AND trust_class='owner'")
      .get(tenantId, sourceEventId);
    if (!source || source.type !== "message.received" || !evidence || !source.payload || typeof source.payload !== "object"
      || Array.isArray(source.payload) || typeof source.payload.text !== "string") throw new Error("Memory edit requires a current owner message");
    return source.payload.text;
  }

  get(memoryId: string, tenantId?: string): MemoryRecord | undefined {
    const row = tenantId
      ? this.store.db.prepare("SELECT * FROM memories WHERE id=? AND tenant_id=?").get(memoryId, tenantId) as Row | undefined
      : this.store.db.prepare("SELECT * FROM memories WHERE id=?").get(memoryId) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(tenantId: string, options: { status?: MemoryStatus; kind?: MemoryKind; limit?: number } = {}): MemoryRecord[] {
    const clauses = ["tenant_id=?"];
    const values: Array<string | number> = [tenantId];
    if (options.status) {
      clauses.push("status=?");
      values.push(options.status);
    }
    if (options.kind) {
      clauses.push("kind=?");
      values.push(options.kind);
    }
    values.push(options.limit ?? 100);
    return (this.store.db.prepare(`SELECT * FROM memories WHERE ${clauses.join(" AND ")} ORDER BY salience DESC,confidence DESC LIMIT ?`).all(...values) as Row[])
      .map(fromRow);
  }

  context(tenantId: string, query: string, options: { carriedLimit?: number; retrievedLimit?: number } = {}): MemoryContext {
    const active = this.list(tenantId, { status: "active", limit: 1000 });
    const carried = active
      .filter((memory) => CARRIED_KINDS.has(memory.kind) && (memory.userConfirmed || memory.confidence >= 0.72))
      .sort((left, right) => {
        const confirmDelta = Number(right.userConfirmed) - Number(left.userConfirmed);
        return confirmDelta || right.salience - left.salience || right.confidence - left.confidence;
      })
      .slice(0, options.carriedLimit ?? 12);

    const queryTokens = tokens(query);
    const scored = active
      .filter((memory) => !carried.some((item) => item.id === memory.id))
      .map((memory) => {
        const lexical = overlap(queryTokens, tokens(memory.statement));
        const ageDays = Math.max(0, (Date.now() - Date.parse(memory.observedAt)) / 86_400_000);
        const freshness = Math.exp(-ageDays / 365);
        const freshnessWeight = memory.kind === "goal" || memory.kind === "commitment" ? 0.08 : memory.kind === "fact" ? 0.04 : 0;
        const score = lexical * 0.62 + memory.salience * 0.18 + memory.confidence * 0.14 + Number(memory.userConfirmed) * 0.08 + freshness * freshnessWeight;
        return { memory, score, lexical, bucket: memory.observedAt.slice(0, 7) };
      })
      .filter((item) => item.lexical > 0 || item.memory.salience >= 0.75)
      .sort((left, right) => right.score - left.score);

    // Temporal diversity prevents one recent burst from crowding out months of relevant evidence.
    const bucketCounts = new Map<string, number>();
    const retrieved: MemoryRecord[] = [];
    const limit = options.retrievedLimit ?? 10;
    for (const item of scored) {
      const count = bucketCounts.get(item.bucket) ?? 0;
      if (count >= 2 && scored.some((candidate) => (bucketCounts.get(candidate.bucket) ?? 0) === 0)) continue;
      retrieved.push(item.memory);
      bucketCounts.set(item.bucket, count + 1);
      if (retrieved.length >= limit) break;
    }
    return { carried, retrieved };
  }

  format(context: MemoryContext): string {
    const line = (memory: MemoryRecord) => {
      const certainty = memory.userConfirmed ? "confirmed" : `confidence ${memory.confidence.toFixed(2)}`;
      return `- [${memory.id}; ${memory.kind}; ${certainty}; observed ${memory.observedAt.slice(0, 10)}] ${memory.statement}`;
    };
    const carried = context.carried.length ? context.carried.map(line).join("\n") : "(none yet)";
    const retrieved = context.retrieved.length ? context.retrieved.map(line).join("\n") : "(none found)";
    return `STABLE CONTEXT (carried, not recency-ranked):\n${carried}\n\nRELEVANT EVIDENCE (retrieved for this turn):\n${retrieved}`;
  }

  stats(tenantId: string): JsonObject {
    const rows = this.store.db.prepare("SELECT kind,status,COUNT(*) AS count FROM memories WHERE tenant_id=? GROUP BY kind,status").all(tenantId) as Row[];
    const byKind: JsonObject = {};
    for (const row of rows) byKind[`${String(row.kind)}:${String(row.status)}`] = Number(row.count);
    return { total: rows.reduce((sum, row) => sum + Number(row.count), 0), byKind };
  }
}
