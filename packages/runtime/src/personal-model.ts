import { nowIso, stableId } from "./id.ts";
import type { PerceptionEvidenceRecord, PerceptionHypothesisRecord, PerceptionManager, PerceptionStatus } from "./perception.ts";
import type { SqliteStore } from "./store.ts";

type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, SqlValue>;

export type PersonalNodeKind = "thought" | "concept" | "source" | "latent_thesis";
export type PersonalEvidenceRelation = "observed" | "mentions" | "shared" | "supports" | "contradicts" | "context";
export type SourceAffinitySignalKind = "shared" | "revisited" | "endorsed" | "dismissed" | "rejected" | "acted";

export interface PersonalNodeRecord {
  id: string;
  tenantId: string;
  kind: PersonalNodeKind;
  key: string;
  label: string;
  status: string;
  confidence: number;
  firstObservedAt: string;
  lastObservedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalEdgeRecord {
  id: string;
  tenantId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: string;
  confidence: number;
  sourceEventId: string;
  createdAt: string;
}

export interface SourceAffinityRecord {
  source: PersonalNodeRecord;
  score: number;
  signalCount: number;
  positiveCount: number;
  negativeCount: number;
  lastSignalAt: string;
}

export interface PersonalModelRebuildReport {
  thoughts: number;
  sources: number;
  sourceSignals: number;
  latentTheses: number;
  nodes: number;
  edges: number;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function excerpt(value: string, limit = 1_000): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

function sourceKey(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return value.trim().toLowerCase();
  }
}

function normalizedName(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s.-]/gu, " ").replace(/\s+/g, " ").trim();
}

function sourceIdentity(urlValue: string, author?: string): { key: string; label: string } {
  if (author?.trim()) return { key: `author:${normalizedName(author)}`, label: author.trim() };
  try {
    const hostname = new URL(urlValue).hostname.toLowerCase().replace(/^www\./, "");
    return { key: `domain:${hostname}`, label: hostname };
  } catch {
    const normalized = normalizedName(urlValue);
    return { key: `source:${normalized}`, label: urlValue.trim() };
  }
}

function signalWeight(kind: SourceAffinitySignalKind): number {
  if (kind === "endorsed") return 1;
  if (kind === "acted") return 0.8;
  if (kind === "revisited") return 0.35;
  if (kind === "dismissed") return -0.5;
  if (kind === "rejected") return -1;
  return 0;
}

export class PersonalModel {
  readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  recordThought(tenantId: string, sourceEventId: string): PersonalNodeRecord {
    const evidence = this.store.db.prepare(`SELECT content,observed_at FROM evidence
      WHERE tenant_id=? AND source_event_id=? AND trust_class='owner' ORDER BY observed_at DESC LIMIT 1`)
      .get(tenantId, sourceEventId) as Row | undefined;
    if (!evidence) throw new Error("A thought projection requires owner evidence");
    return this.upsertNode({
      tenantId, kind: "thought", key: sourceEventId, label: excerpt(String(evidence.content)), status: "observed",
      confidence: 1, observedAt: String(evidence.observed_at), sourceEventId, relation: "observed",
    });
  }

  recordConcept(input: { tenantId: string; key: string; label: string; sourceEventId: string; confidence: number }): PersonalNodeRecord {
    const key = input.key.toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
    if (!key) throw new Error("Concept key is empty");
    const event = this.store.getEvent(input.tenantId, input.sourceEventId);
    if (!event) throw new Error("Concept source event does not exist");
    return this.upsertNode({
      tenantId: input.tenantId, kind: "concept", key, label: excerpt(input.label, 500), status: "active",
      confidence: input.confidence, observedAt: event.at, sourceEventId: input.sourceEventId, relation: "mentions",
    });
  }

  recordSource(input: { tenantId: string; sourceEventId: string; artifactEventId?: string; url: string; title?: string; author?: string }): PersonalNodeRecord {
    const event = this.store.getEvent(input.tenantId, input.sourceEventId);
    if (!event) throw new Error("Source-sharing event does not exist");
    const aliasKey = sourceKey(input.url);
    // The first evidence-backed resolution of a URL is stable. Later metadata may
    // enrich it, but cannot silently move prior affinity to another source.
    const aliased = this.sourceByAlias(input.tenantId, aliasKey);
    const identity = aliased
      ? { key: aliased.key, label: aliased.label }
      : sourceIdentity(input.url, input.author);
    const node = this.upsertNode({
      tenantId: input.tenantId, kind: "source", key: identity.key, label: excerpt(identity.label, 500), status: "observed", confidence: 1,
      observedAt: event.at, sourceEventId: event.id, relation: "shared",
    });
    this.store.db.prepare(`INSERT OR IGNORE INTO source_aliases(tenant_id,alias,source_node_id,created_at) VALUES(?,?,?,?)`).run(
      input.tenantId, aliasKey, node.id, nowIso(),
    );
    if (input.artifactEventId) {
      const artifact = this.store.getEvent(input.tenantId, input.artifactEventId);
      if (artifact) this.attachEvidence(input.tenantId, node.id, artifact.id, "context", artifact.at);
    }
    this.store.appendEvent({
      id: stableId("evt", `source-observed:${input.tenantId}:${node.id}:${event.id}:${aliasKey}`),
      tenantId: input.tenantId, stream: `source:${node.id}`, type: "source.observed", causationId: event.id,
      payload: {
        sourceNodeId: node.id, nodeKey: node.key, label: node.label, source: aliasKey, url: input.url,
        sourceEventId: event.id, artifactEventId: input.artifactEventId ?? null,
        title: input.title ?? null, author: input.author ?? null,
      },
    });
    // Sharing is evidence of attention, not respect or endorsement.
    this.recordSourceSignal(input.tenantId, input.url, event.id, "shared");
    return node;
  }

  recordSourceSignal(tenantId: string, source: string, sourceEventId: string, kind: SourceAffinitySignalKind): SourceAffinityRecord {
    const event = this.store.getEvent(tenantId, sourceEventId);
    if (!event) throw new Error("Source-affinity event does not exist");
    const node = this.resolveSource(tenantId, source);
    if (!node) throw new Error("Source-affinity signal references an unknown source");
    const current = nowIso();
    const signalId = stableId("saf", `${tenantId}:${node.id}:${sourceEventId}:${kind}`);
    this.store.transaction(() => {
      this.store.db.prepare(`INSERT OR IGNORE INTO source_affinity_signals(
        id,tenant_id,source_node_id,source_event_id,kind,weight,created_at
      ) VALUES(?,?,?,?,?,?,?)`).run(
        signalId, tenantId, node.id, sourceEventId, kind, signalWeight(kind), current,
      );
      this.store.appendEvent({
        id: stableId("evt", `source-affinity:${signalId}`), tenantId, stream: `source:${node.id}`,
        type: "source.affinity_recorded", at: current, causationId: sourceEventId,
        payload: { signalId, sourceNodeId: node.id, source: sourceKey(source), kind, weight: signalWeight(kind), sourceEventId },
      });
    });
    return this.sourceAffinity(tenantId, node.id) as SourceAffinityRecord;
  }

  recordLatentThesis(hypothesis: PerceptionHypothesisRecord, evidence: PerceptionEvidenceRecord[]): PersonalNodeRecord {
    const node = this.upsertNode({
      tenantId: hypothesis.tenantId, kind: "latent_thesis", key: hypothesis.id, label: hypothesis.statement,
      status: hypothesis.status, confidence: hypothesis.confidence, observedAt: hypothesis.updatedAt,
      sourceEventId: hypothesis.sourceEventId, relation: "context",
    });
    const concept = this.recordConcept({
      tenantId: hypothesis.tenantId, key: hypothesis.topicKey, label: hypothesis.topicKey.replace(/[-_]+/g, " "),
      sourceEventId: hypothesis.sourceEventId, confidence: hypothesis.confidence,
    });
    this.connect(hypothesis.tenantId, node.id, concept.id, "expresses", hypothesis.confidence, hypothesis.sourceEventId);
    for (const item of evidence) {
      this.attachEvidence(hypothesis.tenantId, node.id, item.eventId, item.relation, item.observedAt);
      let evidenceNodes = this.nodesForEvent(hypothesis.tenantId, item.eventId)
        .filter((candidate) => candidate.kind === "thought" || candidate.kind === "source");
      if (!evidenceNodes.length && item.trustClass === "owner") {
        evidenceNodes = [this.recordThought(hypothesis.tenantId, item.eventId)];
      }
      for (const evidenceNode of evidenceNodes) {
        if (evidenceNode.id === node.id) continue;
        this.connect(hypothesis.tenantId, evidenceNode.id, node.id, item.relation, hypothesis.confidence, item.eventId);
      }
    }
    return this.nodeByKey(hypothesis.tenantId, "latent_thesis", hypothesis.id) as PersonalNodeRecord;
  }

  updateLatentThesisStatus(tenantId: string, hypothesisId: string, status: PerceptionStatus, confidence?: number): PersonalNodeRecord | undefined {
    const current = nowIso();
    this.store.db.prepare(`UPDATE personal_nodes SET status=?,confidence=COALESCE(?,confidence),updated_at=?
      WHERE tenant_id=? AND kind='latent_thesis' AND node_key=?`).run(status, confidence ?? null, current, tenantId, hypothesisId);
    return this.nodeByKey(tenantId, "latent_thesis", hypothesisId);
  }

  nodes(tenantId: string, kind?: PersonalNodeKind, limit = 100): PersonalNodeRecord[] {
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = kind
      ? this.store.db.prepare("SELECT * FROM personal_nodes WHERE tenant_id=? AND kind=? ORDER BY updated_at DESC LIMIT ?").all(tenantId, kind, safeLimit) as Row[]
      : this.store.db.prepare("SELECT * FROM personal_nodes WHERE tenant_id=? ORDER BY updated_at DESC LIMIT ?").all(tenantId, safeLimit) as Row[];
    return rows.map((row) => this.nodeFromRow(row));
  }

  edges(tenantId: string, limit = 200): PersonalEdgeRecord[] {
    const rows = this.store.db.prepare("SELECT * FROM personal_edges WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?")
      .all(tenantId, Math.max(1, Math.min(2_000, Math.floor(limit)))) as Row[];
    return rows.map((row) => ({
      id: String(row.id), tenantId: String(row.tenant_id), fromNodeId: String(row.from_node_id), toNodeId: String(row.to_node_id),
      relation: String(row.relation), confidence: Number(row.confidence), sourceEventId: String(row.source_event_id), createdAt: String(row.created_at),
    }));
  }

  sourceAffinities(tenantId: string, limit = 100): SourceAffinityRecord[] {
    const rows = this.store.db.prepare(`WITH event_signals AS (
      SELECT tenant_id,source_node_id,source_event_id,
        CASE WHEN SUM(weight)>1 THEN 1 WHEN SUM(weight)<-1 THEN -1 ELSE SUM(weight) END AS weight,
        MAX(created_at) AS created_at
      FROM source_affinity_signals GROUP BY tenant_id,source_node_id,source_event_id
    ) SELECT pn.*,COUNT(s.source_event_id) AS signal_count,
      SUM(CASE WHEN s.weight>0 THEN 1 ELSE 0 END) AS positive_count,
      SUM(CASE WHEN s.weight<0 THEN 1 ELSE 0 END) AS negative_count,
      COALESCE(AVG(s.weight),0) AS affinity_score,MAX(s.created_at) AS last_signal_at
      FROM personal_nodes pn JOIN event_signals s ON s.tenant_id=pn.tenant_id AND s.source_node_id=pn.id
      WHERE pn.tenant_id=? AND pn.kind='source' GROUP BY pn.id
      ORDER BY affinity_score DESC,last_signal_at DESC LIMIT ?`).all(tenantId, Math.max(1, Math.min(1_000, Math.floor(limit)))) as Row[];
    return rows.map((row) => ({
      source: this.nodeFromRow(row), score: Number(row.affinity_score), signalCount: Number(row.signal_count),
      positiveCount: Number(row.positive_count), negativeCount: Number(row.negative_count), lastSignalAt: String(row.last_signal_at),
    }));
  }

  snapshot(tenantId: string): { nodes: PersonalNodeRecord[]; edges: PersonalEdgeRecord[]; sourceAffinity: SourceAffinityRecord[] } {
    return { nodes: this.nodes(tenantId, undefined, 500), edges: this.edges(tenantId, 1_000), sourceAffinity: this.sourceAffinities(tenantId, 500) };
  }

  /** Rebuild only disposable personal-model tables from the append-only evidence,
   * source-observation, affinity, and perception records. Any malformed canonical
   * record aborts the transaction and leaves the prior projection intact. */
  rebuild(tenantId: string, perception: PerceptionManager): PersonalModelRebuildReport {
    const thoughtEventIds = (this.store.db.prepare(`SELECT DISTINCT source_event_id FROM evidence
      WHERE tenant_id=? AND trust_class='owner' ORDER BY observed_at`).all(tenantId) as Row[]).map((row) => String(row.source_event_id));
    const sourceObservationIds = (this.store.db.prepare(`SELECT id FROM events WHERE tenant_id=? AND type='source.observed' ORDER BY seq`)
      .all(tenantId) as Row[]).map((row) => String(row.id));
    const affinityEventIds = (this.store.db.prepare(`SELECT id FROM events WHERE tenant_id=? AND type='source.affinity_recorded' ORDER BY seq`)
      .all(tenantId) as Row[]).map((row) => String(row.id));
    const hypothesisIds = (this.store.db.prepare("SELECT id FROM perception_hypotheses WHERE tenant_id=? ORDER BY created_at")
      .all(tenantId) as Row[]).map((row) => String(row.id));

    return this.store.transaction(() => {
      this.store.db.prepare("DELETE FROM source_affinity_signals WHERE tenant_id=?").run(tenantId);
      this.store.db.prepare("DELETE FROM personal_edges WHERE tenant_id=?").run(tenantId);
      this.store.db.prepare("DELETE FROM personal_node_evidence WHERE tenant_id=?").run(tenantId);
      this.store.db.prepare("DELETE FROM source_aliases WHERE tenant_id=?").run(tenantId);
      this.store.db.prepare("DELETE FROM personal_nodes WHERE tenant_id=?").run(tenantId);

      for (const eventId of thoughtEventIds) this.recordThought(tenantId, eventId);
      for (const eventId of sourceObservationIds) {
        const event = this.store.getEvent(tenantId, eventId);
        const payload = event?.payload;
        if (!event || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error(`Source observation ${eventId} is not rebuildable`);
        }
        const url = typeof payload.url === "string" ? payload.url : "";
        const sourceEventId = typeof payload.sourceEventId === "string" ? payload.sourceEventId : "";
        if (!url || !sourceEventId) throw new Error(`Source observation ${eventId} is incomplete`);
        this.recordSource({
          tenantId, sourceEventId, url,
          ...(typeof payload.artifactEventId === "string" ? { artifactEventId: payload.artifactEventId } : {}),
          ...(typeof payload.title === "string" ? { title: payload.title } : {}),
          ...(typeof payload.author === "string" ? { author: payload.author } : {}),
        });
      }
      for (const eventId of affinityEventIds) {
        const event = this.store.getEvent(tenantId, eventId);
        const payload = event?.payload;
        if (!event || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error(`Source-affinity event ${eventId} is not rebuildable`);
        }
        const source = typeof payload.source === "string" ? payload.source : "";
        const sourceEventId = typeof payload.sourceEventId === "string" ? payload.sourceEventId : "";
        const kind = payload.kind;
        if (!source || !sourceEventId || !this.isSourceSignalKind(kind)) throw new Error(`Source-affinity event ${eventId} is incomplete`);
        this.recordSourceSignal(tenantId, source, sourceEventId, kind);
      }
      for (const hypothesisId of hypothesisIds) {
        const hypothesis = perception.get(tenantId, hypothesisId);
        if (!hypothesis) throw new Error(`Perception hypothesis ${hypothesisId} disappeared during rebuild`);
        this.recordLatentThesis(hypothesis, perception.evidence(tenantId, hypothesisId));
      }
      return {
        thoughts: thoughtEventIds.length, sources: sourceObservationIds.length, sourceSignals: affinityEventIds.length,
        latentTheses: hypothesisIds.length,
        nodes: Number((this.store.db.prepare("SELECT COUNT(*) AS count FROM personal_nodes WHERE tenant_id=?").get(tenantId) as Row).count),
        edges: Number((this.store.db.prepare("SELECT COUNT(*) AS count FROM personal_edges WHERE tenant_id=?").get(tenantId) as Row).count),
      };
    });
  }

  formatForPrompt(tenantId: string): string {
    const learned = this.sourceAffinities(tenantId, 20).filter((item) => item.positiveCount >= 2 || item.negativeCount >= 1);
    if (!learned.length) return "";
    return [
      "Correctable source affinity (sharing alone is neutral):",
      ...learned.map((item) => `- [score ${item.score.toFixed(2)}; +${item.positiveCount}/-${item.negativeCount}] ${item.source.label}`),
      "Use this as a search prior, not an echo-chamber boundary. Negative evidence is a reason to vary or avoid a source, not to hide counterevidence.",
    ].join("\n");
  }

  private upsertNode(input: {
    tenantId: string; kind: PersonalNodeKind; key: string; label: string; status: string; confidence: number;
    observedAt: string; sourceEventId: string; relation: PersonalEvidenceRelation;
  }): PersonalNodeRecord {
    const current = nowIso();
    const nodeId = stableId("pnd", `${input.tenantId}:${input.kind}:${input.key}`);
    this.store.transaction(() => {
      this.store.db.prepare(`INSERT INTO personal_nodes(
        id,tenant_id,kind,node_key,label,status,confidence,first_observed_at,last_observed_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,kind,node_key) DO UPDATE SET
        label=excluded.label,status=excluded.status,confidence=MAX(personal_nodes.confidence,excluded.confidence),
        first_observed_at=MIN(personal_nodes.first_observed_at,excluded.first_observed_at),
        last_observed_at=MAX(personal_nodes.last_observed_at,excluded.last_observed_at),updated_at=excluded.updated_at`).run(
        nodeId, input.tenantId, input.kind, input.key, excerpt(input.label), input.status, clamp(input.confidence),
        input.observedAt, input.observedAt, current, current,
      );
      const node = this.nodeByKey(input.tenantId, input.kind, input.key);
      if (!node) throw new Error("Personal-model node failed to persist");
      this.attachEvidence(input.tenantId, node.id, input.sourceEventId, input.relation, input.observedAt);
    });
    return this.nodeByKey(input.tenantId, input.kind, input.key) as PersonalNodeRecord;
  }

  private attachEvidence(tenantId: string, nodeId: string, eventId: string, relation: PersonalEvidenceRelation, observedAt: string): void {
    if (!this.store.getEvent(tenantId, eventId)) throw new Error("Personal-model evidence event does not exist");
    this.store.db.prepare(`INSERT OR IGNORE INTO personal_node_evidence(
      tenant_id,node_id,event_id,relation,observed_at,created_at
    ) VALUES(?,?,?,?,?,?)`).run(tenantId, nodeId, eventId, relation, observedAt, nowIso());
  }

  private connect(tenantId: string, fromNodeId: string, toNodeId: string, relation: string, confidence: number, sourceEventId: string): void {
    this.store.db.prepare(`INSERT OR IGNORE INTO personal_edges(
      id,tenant_id,from_node_id,to_node_id,relation,confidence,source_event_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      stableId("ped", `${tenantId}:${fromNodeId}:${toNodeId}:${relation}:${sourceEventId}`), tenantId,
      fromNodeId, toNodeId, relation, clamp(confidence), sourceEventId, nowIso(),
    );
  }

  private nodesForEvent(tenantId: string, eventId: string): PersonalNodeRecord[] {
    const rows = this.store.db.prepare(`SELECT pn.* FROM personal_node_evidence pne
      JOIN personal_nodes pn ON pn.tenant_id=pne.tenant_id AND pn.id=pne.node_id
      WHERE pne.tenant_id=? AND pne.event_id=? ORDER BY pn.kind,pn.id`).all(tenantId, eventId) as Row[];
    return rows.map((row) => this.nodeFromRow(row));
  }

  private nodeByKey(tenantId: string, kind: PersonalNodeKind, key: string): PersonalNodeRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM personal_nodes WHERE tenant_id=? AND kind=? AND node_key=?")
      .get(tenantId, kind, key) as Row | undefined;
    return row ? this.nodeFromRow(row) : undefined;
  }

  private sourceAffinity(tenantId: string, nodeId: string): SourceAffinityRecord | undefined {
    const row = this.store.db.prepare(`WITH event_signals AS (
      SELECT tenant_id,source_node_id,source_event_id,
        CASE WHEN SUM(weight)>1 THEN 1 WHEN SUM(weight)<-1 THEN -1 ELSE SUM(weight) END AS weight,
        MAX(created_at) AS created_at
      FROM source_affinity_signals GROUP BY tenant_id,source_node_id,source_event_id
    ) SELECT pn.*,COUNT(s.source_event_id) AS signal_count,
      SUM(CASE WHEN s.weight>0 THEN 1 ELSE 0 END) AS positive_count,
      SUM(CASE WHEN s.weight<0 THEN 1 ELSE 0 END) AS negative_count,
      COALESCE(AVG(s.weight),0) AS affinity_score,MAX(s.created_at) AS last_signal_at
      FROM personal_nodes pn JOIN event_signals s ON s.tenant_id=pn.tenant_id AND s.source_node_id=pn.id
      WHERE pn.tenant_id=? AND pn.id=? AND pn.kind='source' GROUP BY pn.id`).get(tenantId, nodeId) as Row | undefined;
    return row ? {
      source: this.nodeFromRow(row), score: Number(row.affinity_score), signalCount: Number(row.signal_count),
      positiveCount: Number(row.positive_count), negativeCount: Number(row.negative_count), lastSignalAt: String(row.last_signal_at),
    } : undefined;
  }

  private resolveSource(tenantId: string, value: string): PersonalNodeRecord | undefined {
    const alias = this.sourceByAlias(tenantId, sourceKey(value));
    if (alias) return alias;
    const identity = sourceIdentity(value);
    return this.nodeByKey(tenantId, "source", identity.key)
      ?? this.nodeByKey(tenantId, "source", `author:${normalizedName(value)}`);
  }

  private isSourceSignalKind(value: unknown): value is SourceAffinitySignalKind {
    return value === "shared" || value === "revisited" || value === "endorsed" || value === "dismissed" || value === "rejected" || value === "acted";
  }

  private sourceByAlias(tenantId: string, aliasKey: string): PersonalNodeRecord | undefined {
    const alias = this.store.db.prepare(`SELECT pn.* FROM source_aliases sa JOIN personal_nodes pn
      ON pn.tenant_id=sa.tenant_id AND pn.id=sa.source_node_id WHERE sa.tenant_id=? AND sa.alias=?`)
      .get(tenantId, aliasKey) as Row | undefined;
    return alias ? this.nodeFromRow(alias) : undefined;
  }

  private nodeFromRow(row: Row): PersonalNodeRecord {
    return {
      id: String(row.id), tenantId: String(row.tenant_id), kind: String(row.kind) as PersonalNodeKind,
      key: String(row.node_key), label: String(row.label), status: String(row.status), confidence: Number(row.confidence),
      firstObservedAt: String(row.first_observed_at), lastObservedAt: String(row.last_observed_at),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
}
