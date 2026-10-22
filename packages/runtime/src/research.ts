import { createHash } from "node:crypto";
import { nowIso, stableId } from "./id.ts";
import type { PersonalModel } from "./personal-model.ts";
import type { SqliteStore } from "./store.ts";
import type { JsonValue } from "./types.ts";
import type { WorkOrderRecord } from "./work-orders.ts";

type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, SqlValue>;

export type ResearchKind = "fact" | "framework" | "person" | "opportunity" | "source";
export type ResearchStatus = "queued" | "running" | "completed" | "needs_input" | "failed" | "cancelled";
export type ResearchSourceClass = "official" | "first_party" | "primary_research" | "secondary" | "journalism" | "community" | "unknown";
export type ResearchCoverage = "search_result" | "metadata" | "fulltext" | "multimodal" | "repository" | "document";

export interface ResearchCommissionRecord {
  id: string;
  tenantId: string;
  sourceEventId: string;
  sessionId: string;
  kind: ResearchKind;
  objective: string;
  whyNow: string;
  status: ResearchStatus;
  minimumIndependentSources: number;
  requiredPrimarySources: number;
  retrievalToolNames: string[];
  workOrderId?: string;
  failureReason?: string;
  createdByRunId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ResearchSourceRecord {
  id: string;
  tenantId: string;
  commissionId: string;
  runId: string;
  retrievalReceiptId: string;
  retrievalToolName: string;
  url: string;
  domain: string;
  title: string;
  publisher: string;
  creator?: string;
  publishedAt?: string;
  sourceClass: ResearchSourceClass;
  coverage: ResearchCoverage;
  claim: string;
  qualityBasis: string;
  limitations: string;
  createdAt: string;
}

export interface ResearchFindingRecord {
  id: string;
  tenantId: string;
  commissionId: string;
  runId: string;
  kind: ResearchKind;
  title: string;
  summary: string;
  mapping: string;
  limitations: string;
  changedImplication: string;
  counterevidence: string;
  sourceReceiptIds: string[];
  confidence: number;
  createdAt: string;
}

function required(value: string, name: string, maximum: number, minimum = 1): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length < minimum) throw new Error(`${name} must contain at least ${minimum} characters`);
  if (clean.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  return clean;
}

function optional(value: SqlValue | undefined): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringArray(value: SqlValue | undefined, label: string): string[] {
  if (typeof value !== "string") throw new Error(`${label} is missing`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${label} is corrupt`); }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error(`${label} is corrupt`);
  return parsed;
}

function canonicalUrl(value: string): { url: string; domain: string } {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("Research source URL is invalid"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Research sources must use HTTP(S)");
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) if (key.toLowerCase().startsWith("utm_")) parsed.searchParams.delete(key);
  return { url: parsed.toString(), domain: parsed.hostname.toLowerCase().replace(/^www\./, "") };
}

function normalizeName(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s.-]/gu, " ").replace(/\s+/g, " ").trim();
}

function sourceClass(value: string): ResearchSourceClass {
  if (["official", "first_party", "primary_research", "secondary", "journalism", "community", "unknown"].includes(value)) {
    return value as ResearchSourceClass;
  }
  throw new Error(`Unknown research source class: ${value}`);
}

function coverage(value: string): ResearchCoverage {
  if (["search_result", "metadata", "fulltext", "multimodal", "repository", "document"].includes(value)) {
    return value as ResearchCoverage;
  }
  throw new Error(`Unknown research coverage: ${value}`);
}

function kind(value: string): ResearchKind {
  if (["fact", "framework", "person", "opportunity", "source"].includes(value)) return value as ResearchKind;
  throw new Error(`Unknown research kind: ${value}`);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function jsonContainsSource(value: string, url: string, domain: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes(url.toLowerCase()) || lower.includes(domain);
}

type ResearchEvidenceEnvelope = {
  version: 1;
  url: string;
  title: string;
  publisher: string;
  creator?: string;
  publishedAt?: string;
  sourceClass: ResearchSourceClass;
  coverage: ResearchCoverage;
  complete: true;
  contentSha256: string;
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/**
 * A strong research source is accepted only when the retrieval adapter, below
 * the model, emits this reserved evidence envelope and binds it to the exact
 * returned content bytes. This prevents a model from upgrading a snippet to
 * full text or labelling an arbitrary page as primary evidence in tool args.
 */
function verifiedResearchEvidence(outputJson: string): { envelope: ResearchEvidenceEnvelope; content: string } | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(outputJson); } catch { return undefined; }
  const root = objectValue(parsed);
  const structured = objectValue(root?.structuredContent);
  if (root?.truncated === true || structured?.truncated === true) return undefined;
  for (const candidate of [root, structured]) {
    if (!candidate) continue;
    if (candidate.truncated === true) continue;
    const evidence = objectValue(candidate["_coResearchEvidence"]);
    const content = candidate.content;
    if (!evidence || typeof content !== "string") continue;
    if (evidence.version !== 1 || evidence.complete !== true || typeof evidence.url !== "string"
      || typeof evidence.title !== "string" || typeof evidence.publisher !== "string"
      || typeof evidence.sourceClass !== "string" || typeof evidence.coverage !== "string"
      || typeof evidence.contentSha256 !== "string") continue;
    if (typeof evidence.creator !== "undefined" && typeof evidence.creator !== "string") continue;
    if (typeof evidence.publishedAt !== "undefined" && typeof evidence.publishedAt !== "string") continue;
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== evidence.contentSha256.toLowerCase()) continue;
    let classified: ResearchSourceClass;
    let observedCoverage: ResearchCoverage;
    try {
      classified = sourceClass(evidence.sourceClass);
      observedCoverage = coverage(evidence.coverage);
    } catch {
      continue;
    }
    return {
      envelope: {
        version: 1, url: evidence.url, title: evidence.title, publisher: evidence.publisher,
        ...(typeof evidence.creator === "string" ? { creator: evidence.creator } : {}),
        ...(typeof evidence.publishedAt === "string" ? { publishedAt: evidence.publishedAt } : {}),
        sourceClass: classified, coverage: observedCoverage, complete: true, contentSha256: digest,
      },
      content,
    };
  }
  return undefined;
}

export class ResearchManager {
  readonly store: SqliteStore;
  private readonly personalModel: PersonalModel;

  constructor(store: SqliteStore, personalModel: PersonalModel) {
    this.store = store;
    this.personalModel = personalModel;
  }

  createCommission(input: {
    tenantId: string;
    sourceEventId: string;
    sessionId: string;
    kind: ResearchKind;
    objective: string;
    whyNow?: string;
    retrievalToolNames: string[];
    minimumIndependentSources?: number;
    requiredPrimarySources?: number;
    createdByRunId?: string;
    idempotencyKey: string;
  }): ResearchCommissionRecord {
    if (!this.store.getEvent(input.tenantId, input.sourceEventId)) throw new Error("Research commission source event does not exist");
    if (!this.store.getSession(input.sessionId, input.tenantId)) throw new Error("Research commission session does not belong to tenant");
    const objective = required(input.objective, "objective", 20_000);
    const whyNow = input.whyNow ? required(input.whyNow, "whyNow", 4_000) : "Explicitly commissioned from the current conversation.";
    const tools = [...new Set(input.retrievalToolNames)].sort().slice(0, 64);
    if (!tools.length) throw new Error("WorldScout has no configured external research tool");
    const minimumIndependentSources = Math.max(2, Math.min(8, Math.floor(input.minimumIndependentSources ?? 2)));
    const requestedPrimarySources = Math.max(1, Math.floor(input.requiredPrimarySources ?? 1));
    if (requestedPrimarySources > minimumIndependentSources) throw new Error("requiredPrimarySources cannot exceed minimumIndependentSources");
    const requiredPrimarySources = Math.min(8, requestedPrimarySources);
    const commissionId = stableId("rco", `${input.tenantId}:${input.idempotencyKey}`);
    const current = nowIso();
    return this.store.transaction(() => {
      const prior = this.get(input.tenantId, commissionId);
      if (prior) {
        const same = prior.sourceEventId === input.sourceEventId && prior.sessionId === input.sessionId && prior.kind === input.kind
          && prior.objective === objective && prior.whyNow === whyNow
          && prior.minimumIndependentSources === minimumIndependentSources && prior.requiredPrimarySources === requiredPrimarySources
          && JSON.stringify(prior.retrievalToolNames) === JSON.stringify(tools);
        if (!same) throw new Error("Research commission idempotency key was reused with different content");
        return prior;
      }
      this.store.db.prepare(`INSERT INTO research_commissions(
        id,tenant_id,source_event_id,session_id,kind,objective,why_now,status,minimum_independent_sources,
        required_primary_sources,retrieval_tool_names_json,created_by_run_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        commissionId, input.tenantId, input.sourceEventId, input.sessionId, input.kind, objective, whyNow, "queued",
        minimumIndependentSources, requiredPrimarySources, JSON.stringify(tools), input.createdByRunId ?? null, current, current,
      );
      this.store.appendEvent({
        id: stableId("evt", `research-commission:${input.tenantId}:${commissionId}`), tenantId: input.tenantId,
        stream: `research:${commissionId}`, type: "research.commissioned", causationId: input.sourceEventId,
        payload: { commissionId, kind: input.kind, objective, whyNow, minimumIndependentSources, requiredPrimarySources, retrievalToolNames: tools },
      });
      return this.get(input.tenantId, commissionId) as ResearchCommissionRecord;
    });
  }

  bindWorkOrder(tenantId: string, commissionId: string, workOrderId: string): ResearchCommissionRecord {
    return this.store.transaction(() => {
      const commission = this.require(tenantId, commissionId);
      if (commission.workOrderId && commission.workOrderId !== workOrderId) throw new Error(`Research commission ${commissionId} is already bound`);
      const workOrder = this.store.db.prepare("SELECT id FROM work_orders WHERE tenant_id=? AND id=?").get(tenantId, workOrderId);
      if (!workOrder) throw new Error("Research work order does not belong to tenant");
      const current = nowIso();
      this.store.db.prepare("UPDATE research_commissions SET work_order_id=?,status='running',updated_at=? WHERE tenant_id=? AND id=?")
        .run(workOrderId, current, tenantId, commissionId);
      this.store.appendEvent({
        id: stableId("evt", `research-work-order:${tenantId}:${commissionId}:${workOrderId}`), tenantId,
        stream: `research:${commissionId}`, type: "research.started", correlationId: workOrderId,
        payload: { commissionId, workOrderId },
      });
      return this.require(tenantId, commissionId);
    });
  }

  recordSource(input: {
    tenantId: string;
    commissionId: string;
    runId: string;
    retrievalToolCallId: string;
    url: string;
    title: string;
    publisher: string;
    creator?: string;
    publishedAt?: string;
    sourceClass: ResearchSourceClass;
    coverage: ResearchCoverage;
    claim: string;
    qualityBasis: string;
    limitations: string;
  }): ResearchSourceRecord {
    const commission = this.requireRun(input.tenantId, input.commissionId, input.runId);
    const receipt = this.store.db.prepare(`SELECT id,tool_name,output_json,status,evidence_class,evidence_scope,completed_at
      FROM tool_receipts WHERE tenant_id=? AND run_id=? AND tool_call_id=?`).get(
      input.tenantId, input.runId, required(input.retrievalToolCallId, "retrievalToolCallId", 256),
    ) as Row | undefined;
    if (!receipt || receipt.status !== "succeeded" || receipt.evidence_class !== "read" || receipt.evidence_scope !== "outcome") {
      throw new Error("Research source must bind to a successful outcome-scoped read receipt in this run");
    }
    const retrievalToolName = String(receipt.tool_name);
    if (!commission.retrievalToolNames.includes(retrievalToolName)) throw new Error("Receipt tool is outside this commission's research-tool snapshot");
    const resolved = canonicalUrl(input.url);
    const receiptOutput = String(receipt.output_json ?? "");
    if (receiptOutput.length < 40 || !jsonContainsSource(receiptOutput, resolved.url, resolved.domain)) {
      throw new Error("Research source URL and substantive content are not present in the bound retrieval output");
    }
    const title = required(input.title, "title", 1_000, 2);
    const publisher = required(input.publisher, "publisher", 500, 2);
    const claim = required(input.claim, "claim", 4_000, 20);
    const qualityBasis = required(input.qualityBasis, "qualityBasis", 2_000, 20);
    const limitations = required(input.limitations, "limitations", 2_000, 10);
    const classified = sourceClass(input.sourceClass);
    const observedCoverage = coverage(input.coverage);
    if (observedCoverage !== "search_result" && observedCoverage !== "metadata") {
      let parsedOutput: unknown;
      try { parsedOutput = JSON.parse(receiptOutput); } catch { throw new Error("Bound retrieval output is corrupt"); }
      if (parsedOutput && typeof parsedOutput === "object" && !Array.isArray(parsedOutput)
        && (parsedOutput as Record<string, unknown>).truncated === true) {
        throw new Error("A truncated retrieval cannot be recorded as full source coverage");
      }
      const verified = verifiedResearchEvidence(receiptOutput);
      if (!verified) {
        throw new Error("Strong research coverage requires a versioned adapter evidence envelope bound to the exact returned content");
      }
      const attestedUrl = canonicalUrl(verified.envelope.url);
      if (attestedUrl.url !== resolved.url || verified.envelope.title.trim() !== title
        || verified.envelope.publisher.trim() !== publisher || verified.envelope.sourceClass !== classified
        || verified.envelope.coverage !== observedCoverage
        || (verified.envelope.creator?.trim() || undefined) !== (input.creator?.trim() || undefined)
        || (verified.envelope.publishedAt?.trim() || undefined) !== (input.publishedAt?.trim() || undefined)) {
        throw new Error("Research source metadata does not match the retrieval adapter's evidence envelope");
      }
      if (verified.content.trim().length < 40) throw new Error("Strong research coverage requires substantive inspected content");
    }
    const sourceId = stableId("rsr", `${input.tenantId}:${input.commissionId}:${resolved.url}:${claim.toLowerCase()}`);
    const current = nowIso();
    const prior = this.getSource(input.tenantId, sourceId);
    if (prior) {
      const same = prior.commissionId === input.commissionId && prior.runId === input.runId
        && prior.retrievalReceiptId === String(receipt.id) && prior.retrievalToolName === retrievalToolName
        && prior.url === resolved.url && prior.title === title && prior.publisher === publisher
        && prior.creator === (input.creator?.trim() || undefined) && prior.publishedAt === (input.publishedAt?.trim() || undefined)
        && prior.sourceClass === classified && prior.coverage === observedCoverage && prior.claim === claim
        && prior.qualityBasis === qualityBasis && prior.limitations === limitations;
      if (!same) throw new Error("Research source identity was reused with conflicting evidence");
      return prior;
    }
    return this.store.transaction(() => {
      this.store.db.prepare(`INSERT OR IGNORE INTO research_source_receipts(
        id,tenant_id,commission_id,run_id,retrieval_receipt_id,retrieval_tool_name,url,domain,title,publisher,creator,
        published_at,source_class,coverage,claim,quality_basis,limitations,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        sourceId, input.tenantId, input.commissionId, input.runId, String(receipt.id), retrievalToolName,
        resolved.url, resolved.domain, title, publisher, input.creator?.trim() || null, input.publishedAt?.trim() || null,
        classified, observedCoverage, claim, qualityBasis, limitations, current,
      );
      const event = this.store.appendEvent({
        id: stableId("evt", `research-source:${input.tenantId}:${sourceId}`), tenantId: input.tenantId,
        stream: `research:${input.commissionId}`, type: "research.source_recorded", correlationId: input.commissionId,
        causationId: commission.sourceEventId,
        payload: {
          sourceReceiptId: sourceId, commissionId: input.commissionId, retrievalReceiptId: String(receipt.id),
          retrievalToolName, url: resolved.url, domain: resolved.domain, title, publisher,
          creator: input.creator?.trim() || null, publishedAt: input.publishedAt?.trim() || null,
          sourceClass: classified, coverage: observedCoverage, claim, qualityBasis, limitations,
        },
      });
      this.store.indexEvidence({
        tenantId: input.tenantId, sourceEventId: event.id, kind: "research.source", trustClass: "untrusted",
        content: `${claim}\nSource: ${title} — ${publisher} (${resolved.url})\nLimitations: ${limitations}`,
        observedAt: event.at, metadata: { commissionId: input.commissionId, sourceReceiptId: sourceId, retrievalReceiptId: String(receipt.id), sourceClass: classified, coverage: observedCoverage },
      });
      return this.getSource(input.tenantId, sourceId) as ResearchSourceRecord;
    });
  }

  recordFinding(input: {
    tenantId: string;
    commissionId: string;
    runId: string;
    kind: ResearchKind;
    title: string;
    summary: string;
    mapping: string;
    limitations: string;
    changedImplication: string;
    counterevidence: string;
    sourceReceiptIds: string[];
    confidence: number;
  }): ResearchFindingRecord {
    const commission = this.requireRun(input.tenantId, input.commissionId, input.runId);
    const findingKind = kind(input.kind);
    if (findingKind !== commission.kind) throw new Error(`Finding kind must match commissioned kind ${commission.kind}`);
    const sourceIds = [...new Set(input.sourceReceiptIds)].slice(0, 24);
    const sources = sourceIds.map((sourceId) => this.getSource(input.tenantId, sourceId));
    if (sources.some((source) => !source || source.commissionId !== commission.id || source.runId !== input.runId)) {
      throw new Error("Every finding source must be a receipt from this commission and run");
    }
    const validSources = sources as ResearchSourceRecord[];
    if (validSources.length < commission.minimumIndependentSources) throw new Error("Finding has too few source receipts");
    const independentlyPublished = new Set(validSources.map((source) => source.domain));
    if (independentlyPublished.size < commission.minimumIndependentSources) throw new Error("Finding does not have enough independently published sources");
    const primary = validSources.filter((source) => source.sourceClass === "official" || source.sourceClass === "first_party" || source.sourceClass === "primary_research");
    if (primary.length < commission.requiredPrimarySources) throw new Error("Finding does not have enough primary-source receipts");
    const weakCoverage = validSources.filter((source) => source.coverage === "search_result" || source.coverage === "metadata");
    if (weakCoverage.length) throw new Error("Search snippets and metadata cannot substantiate a final finding");

    const learnedPositive = this.personalModel.sourceAffinities(input.tenantId, 200)
      .filter((affinity) => affinity.score > 0 && affinity.positiveCount >= 2);
    if (learnedPositive.length) {
      const outside = validSources.some((source) => !learnedPositive.some((affinity) => {
        if (affinity.source.key === `domain:${source.domain}`) return true;
        const creator = normalizeName(source.creator ?? source.publisher);
        return affinity.source.key === `author:${creator}`;
      }));
      if (!outside) throw new Error("Finding needs at least one independent source outside the learned positive-affinity set");
    }

    const title = required(input.title, "title", 1_000, 4);
    const summary = required(input.summary, "summary", 10_000, 40);
    const mapping = required(input.mapping, "mapping", 10_000, 40);
    const limitations = required(input.limitations, "limitations", 5_000, 20);
    const changedImplication = required(input.changedImplication, "changedImplication", 5_000, 20);
    const counterevidence = required(input.counterevidence, "counterevidence", 5_000, 20);
    sourceIds.sort();
    const findingId = stableId("rfn", `${input.tenantId}:${commission.id}:${findingKind}:${title.toLowerCase()}:${sourceIds.join(":")}`);
    const current = nowIso();
    const prior = this.getFinding(input.tenantId, findingId);
    if (prior) {
      const same = prior.commissionId === commission.id && prior.runId === input.runId && prior.kind === findingKind
        && prior.title === title && prior.summary === summary && prior.mapping === mapping && prior.limitations === limitations
        && prior.changedImplication === changedImplication && prior.counterevidence === counterevidence
        && JSON.stringify(prior.sourceReceiptIds) === JSON.stringify(sourceIds) && prior.confidence === clamp(input.confidence);
      if (!same) throw new Error("Research finding identity was reused with conflicting content");
      return prior;
    }
    return this.store.transaction(() => {
      this.store.db.prepare(`INSERT OR IGNORE INTO research_findings(
        id,tenant_id,commission_id,run_id,kind,title,summary,mapping,limitations,changed_implication,counterevidence,
        source_receipt_ids_json,confidence,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        findingId, input.tenantId, commission.id, input.runId, findingKind, title, summary, mapping, limitations,
        changedImplication, counterevidence, JSON.stringify(sourceIds), clamp(input.confidence), current,
      );
      const event = this.store.appendEvent({
        id: stableId("evt", `research-finding:${input.tenantId}:${findingId}`), tenantId: input.tenantId,
        stream: `research:${commission.id}`, type: "research.finding_recorded", correlationId: commission.id,
        causationId: commission.sourceEventId,
        payload: {
          findingId, commissionId: commission.id, kind: findingKind, title, summary, mapping, limitations,
          changedImplication, counterevidence, sourceReceiptIds: sourceIds, confidence: clamp(input.confidence),
        },
      });
      this.store.indexEvidence({
        tenantId: input.tenantId, sourceEventId: event.id, kind: `research.finding.${findingKind}`, trustClass: "agent",
        content: `${title}\n${summary}\nMapping: ${mapping}\nChanged implication: ${changedImplication}\nLimits: ${limitations}\nCounterevidence: ${counterevidence}`,
        observedAt: event.at, metadata: { commissionId: commission.id, findingId, sourceReceiptIds: sourceIds },
      });
      const sourceRun = this.store.getRun(input.runId, input.tenantId);
      this.store.enqueueJob(input.tenantId, "consequence.plan", {
        sourceKind: "research", sourceId: findingId, sourceEventId: event.id, sessionId: commission.sessionId,
      }, { idempotencyKey: `research:${findingId}`, maxAttempts: 4, ...(sourceRun?.releaseId ? { releaseId: sourceRun.releaseId } : {}) });
      return this.getFinding(input.tenantId, findingId) as ResearchFindingRecord;
    });
  }

  syncWorkOrder(tenantId: string, workOrder: WorkOrderRecord): ResearchCommissionRecord | undefined {
    const row = this.store.db.prepare("SELECT id FROM research_commissions WHERE tenant_id=? AND work_order_id=?")
      .get(tenantId, workOrder.id) as Row | undefined;
    if (!row) return undefined;
    const commission = this.require(tenantId, String(row.id));
    if (commission.status === "completed" || commission.status === "failed" || commission.status === "cancelled" || commission.status === "needs_input") return commission;
    if (workOrder.status === "queued" || workOrder.status === "running" || workOrder.status === "waiting_approval") return commission;
    let status: ResearchStatus = workOrder.status;
    let failureReason = workOrder.failureReason;
    if (workOrder.status === "completed" && !this.findings(tenantId, commission.id).length) {
      status = "needs_input";
      failureReason = "Research work order completed without a provenance-bound finding";
    }
    const current = nowIso();
    return this.store.transaction(() => {
      this.store.db.prepare(`UPDATE research_commissions SET status=?,failure_reason=?,updated_at=?,completed_at=?
        WHERE tenant_id=? AND id=?`).run(status, failureReason ?? null, current, status === "completed" ? current : null, tenantId, commission.id);
      this.store.appendEvent({
        id: stableId("evt", `research-terminal:${tenantId}:${commission.id}:${status}`), tenantId,
        stream: `research:${commission.id}`, type: `research.${status}`, correlationId: commission.id,
        causationId: workOrder.id, payload: { commissionId: commission.id, workOrderId: workOrder.id, status, failureReason: failureReason ?? null },
      });
      return this.require(tenantId, commission.id);
    });
  }

  get(tenantId: string, commissionId: string): ResearchCommissionRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM research_commissions WHERE tenant_id=? AND id=?").get(tenantId, commissionId) as Row | undefined;
    return row ? this.commissionFromRow(row) : undefined;
  }

  list(tenantId: string, limit = 100): ResearchCommissionRecord[] {
    const rows = this.store.db.prepare("SELECT * FROM research_commissions WHERE tenant_id=? ORDER BY updated_at DESC LIMIT ?")
      .all(tenantId, Math.max(1, Math.min(1_000, Math.floor(limit)))) as Row[];
    return rows.map((row) => this.commissionFromRow(row));
  }

  sources(tenantId: string, commissionId: string): ResearchSourceRecord[] {
    const rows = this.store.db.prepare("SELECT * FROM research_source_receipts WHERE tenant_id=? AND commission_id=? ORDER BY created_at,id")
      .all(tenantId, commissionId) as Row[];
    return rows.map((row) => this.sourceFromRow(row));
  }

  findings(tenantId: string, commissionId: string): ResearchFindingRecord[] {
    const rows = this.store.db.prepare("SELECT * FROM research_findings WHERE tenant_id=? AND commission_id=? ORDER BY created_at,id")
      .all(tenantId, commissionId) as Row[];
    return rows.map((row) => this.findingFromRow(row));
  }

  asJson(commission: ResearchCommissionRecord): JsonValue {
    return { commission, sources: this.sources(commission.tenantId, commission.id), findings: this.findings(commission.tenantId, commission.id) } as unknown as JsonValue;
  }

  private require(tenantId: string, commissionId: string): ResearchCommissionRecord {
    const commission = this.get(tenantId, commissionId);
    if (!commission) throw new Error(`Unknown research commission ${commissionId}`);
    return commission;
  }

  private requireRun(tenantId: string, commissionId: string, runId: string): ResearchCommissionRecord {
    const commission = this.require(tenantId, commissionId);
    if (!commission.workOrderId) throw new Error("Research commission is not bound to a work order");
    const work = this.store.db.prepare("SELECT run_id FROM work_orders WHERE tenant_id=? AND id=?").get(tenantId, commission.workOrderId) as Row | undefined;
    if (!work || work.run_id !== runId) throw new Error("Research evidence came from outside the commission's bound run");
    return commission;
  }

  private getSource(tenantId: string, sourceId: string): ResearchSourceRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM research_source_receipts WHERE tenant_id=? AND id=?").get(tenantId, sourceId) as Row | undefined;
    return row ? this.sourceFromRow(row) : undefined;
  }

  private getFinding(tenantId: string, findingId: string): ResearchFindingRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM research_findings WHERE tenant_id=? AND id=?").get(tenantId, findingId) as Row | undefined;
    return row ? this.findingFromRow(row) : undefined;
  }

  private commissionFromRow(row: Row): ResearchCommissionRecord {
    const workOrderId = optional(row.work_order_id);
    const failureReason = optional(row.failure_reason);
    const createdByRunId = optional(row.created_by_run_id);
    const completedAt = optional(row.completed_at);
    return {
      id: String(row.id), tenantId: String(row.tenant_id), sourceEventId: String(row.source_event_id), sessionId: String(row.session_id),
      kind: kind(String(row.kind)), objective: String(row.objective), whyNow: String(row.why_now), status: String(row.status) as ResearchStatus,
      minimumIndependentSources: Number(row.minimum_independent_sources), requiredPrimarySources: Number(row.required_primary_sources),
      retrievalToolNames: stringArray(row.retrieval_tool_names_json, `Research commission ${String(row.id)} retrieval tools`),
      ...(workOrderId ? { workOrderId } : {}), ...(failureReason ? { failureReason } : {}), ...(createdByRunId ? { createdByRunId } : {}),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), ...(completedAt ? { completedAt } : {}),
    };
  }

  private sourceFromRow(row: Row): ResearchSourceRecord {
    const creator = optional(row.creator);
    const publishedAt = optional(row.published_at);
    return {
      id: String(row.id), tenantId: String(row.tenant_id), commissionId: String(row.commission_id), runId: String(row.run_id),
      retrievalReceiptId: String(row.retrieval_receipt_id), retrievalToolName: String(row.retrieval_tool_name),
      url: String(row.url), domain: String(row.domain), title: String(row.title), publisher: String(row.publisher),
      ...(creator ? { creator } : {}), ...(publishedAt ? { publishedAt } : {}), sourceClass: sourceClass(String(row.source_class)),
      coverage: coverage(String(row.coverage)), claim: String(row.claim), qualityBasis: String(row.quality_basis),
      limitations: String(row.limitations), createdAt: String(row.created_at),
    };
  }

  private findingFromRow(row: Row): ResearchFindingRecord {
    return {
      id: String(row.id), tenantId: String(row.tenant_id), commissionId: String(row.commission_id), runId: String(row.run_id),
      kind: kind(String(row.kind)), title: String(row.title), summary: String(row.summary), mapping: String(row.mapping),
      limitations: String(row.limitations), changedImplication: String(row.changed_implication), counterevidence: String(row.counterevidence),
      sourceReceiptIds: stringArray(row.source_receipt_ids_json, `Research finding ${String(row.id)} source receipts`),
      confidence: Number(row.confidence), createdAt: String(row.created_at),
    };
  }
}
