import { nowIso, stableId } from "./id.ts";
import type { OfficeManager } from "./office.ts";
import type { SqliteStore } from "./store.ts";
import type { JsonObject } from "./types.ts";
import type { WorkOrderRecord } from "./work-orders.ts";

type Row = Record<string, string | number | bigint | null | Uint8Array>;

export type ConsequenceSourceKind = "research" | "perception" | "ambient" | "artifact";
export type ConsequenceDisposition = "discard" | "hold" | "prepare";
export type ConsequenceKind = "none" | "brief" | "draft" | "watch" | "reminder_option" | "scheduling_option" | "outreach_option" | "research_note" | "action_option";
export type ConsequenceStatus = "discarded" | "held" | "prepared" | "queued" | "running" | "waiting_approval" | "needs_input" | "completed" | "failed" | "cancelled";

export interface ConsequenceRecord {
  id: string;
  tenantId: string;
  sourceKind: ConsequenceSourceKind;
  sourceId: string;
  sourceEventId: string;
  sessionId?: string;
  disposition: ConsequenceDisposition;
  kind: ConsequenceKind;
  status: ConsequenceStatus;
  title: string;
  objective: string;
  rationale: string;
  memberDelta: string;
  content: string;
  confidence: number;
  novelty: number;
  usefulness: number;
  urgency: number;
  artifactId?: string;
  matterId?: string;
  attentionId?: string;
  workOrderId?: string;
  createdAt: string;
  updatedAt: string;
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function required(value: string, field: string, maximum: number, minimum = 1): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length < minimum) throw new Error(`${field} must contain at least ${minimum} characters`);
  if (normalized.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return normalized;
}

function boundedContent(value: string): string {
  const normalized = value.trim();
  if (normalized.length > 100_000) throw new Error("consequence content exceeds 100000 characters");
  return normalized;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) throw new Error("consequence scores must be finite numbers");
  return Math.max(0, Math.min(1, value));
}

function sourceKind(value: string): ConsequenceSourceKind {
  if (value === "research" || value === "perception" || value === "ambient" || value === "artifact") return value;
  throw new Error(`Unknown consequence source kind: ${value}`);
}

function disposition(value: string): ConsequenceDisposition {
  if (value === "discard" || value === "hold" || value === "prepare") return value;
  throw new Error(`Unknown consequence disposition: ${value}`);
}

function consequenceKind(value: string): ConsequenceKind {
  if (["none", "brief", "draft", "watch", "reminder_option", "scheduling_option", "outreach_option", "research_note", "action_option"].includes(value)) {
    return value as ConsequenceKind;
  }
  throw new Error(`Unknown consequence kind: ${value}`);
}

function consequenceStatus(value: string): ConsequenceStatus {
  if (["discarded", "held", "prepared", "queued", "running", "waiting_approval", "needs_input", "completed", "failed", "cancelled"].includes(value)) {
    return value as ConsequenceStatus;
  }
  throw new Error(`Unknown consequence status: ${value}`);
}

export class ConsequenceManager {
  readonly store: SqliteStore;
  readonly office: OfficeManager;

  constructor(store: SqliteStore, office: OfficeManager) {
    this.store = store;
    this.office = office;
  }

  record(input: {
    tenantId: string;
    sourceKind: ConsequenceSourceKind;
    sourceId: string;
    sourceEventId: string;
    sessionId?: string;
    disposition: ConsequenceDisposition;
    kind: ConsequenceKind;
    title: string;
    objective: string;
    rationale: string;
    memberDelta: string;
    content?: string;
    confidence: number;
    novelty: number;
    usefulness: number;
    urgency: number;
  }): ConsequenceRecord {
    const normalizedSourceKind = sourceKind(input.sourceKind);
    const normalizedDisposition = disposition(input.disposition);
    const normalizedKind = consequenceKind(input.kind);
    const sourceId = required(input.sourceId, "sourceId", 256);
    const sourceEvent = this.store.getEvent(input.tenantId, input.sourceEventId);
    if (!sourceEvent) throw new Error("Consequence source event does not belong to the tenant");
    if (input.sessionId && !this.store.getSession(input.sessionId, input.tenantId)) throw new Error("Consequence session does not belong to the tenant");
    if (normalizedDisposition === "discard" && normalizedKind !== "none") throw new Error("A discarded consequence must use kind none");
    if (normalizedDisposition !== "discard" && normalizedKind === "none") throw new Error("A held or prepared consequence needs a concrete kind");
    const title = required(input.title, "title", 512, 4);
    const objective = required(input.objective, "objective", 4_000, 20);
    const rationale = required(input.rationale, "rationale", 4_000, 20);
    const memberDelta = required(input.memberDelta, "memberDelta", 4_000, 20);
    const content = boundedContent(input.content ?? "");
    if (normalizedDisposition === "prepare" && normalizedKind !== "watch" && content.length < 80) {
      throw new Error("Prepared follow-through needs a usable artifact, not a placeholder or plan");
    }
    if (normalizedDisposition === "hold" && content.length < 20) throw new Error("Held follow-through needs inspectable content");
    const scores = {
      confidence: clamp(input.confidence), novelty: clamp(input.novelty),
      usefulness: clamp(input.usefulness), urgency: clamp(input.urgency),
    };
    const planId = stableId("cns", `${input.tenantId}:${normalizedSourceKind}:${sourceId}`);
    const prior = this.get(input.tenantId, planId);
    if (prior) return prior;
    const current = nowIso();
    return this.store.transaction(() => {
      const concurrent = this.get(input.tenantId, planId);
      if (concurrent) return concurrent;
      let artifactId: string | undefined;
      let matterId: string | undefined;
      let attentionId: string | undefined;
      let status: ConsequenceStatus;
      if (normalizedDisposition === "discard") {
        status = "discarded";
      } else if (normalizedDisposition === "hold") {
        const held = this.office.raiseAttention({
          tenantId: input.tenantId, sourceEventId: sourceEvent.id, title, content,
          reason: rationale, mode: scores.urgency >= 0.8 ? "context" : "hold", priority: Math.round(scores.usefulness * 100),
        });
        attentionId = held.id;
        status = "held";
      } else if (normalizedKind === "watch") {
        const matter = this.office.createMatter({
          tenantId: input.tenantId, sourceEventId: sourceEvent.id, title,
          summary: content || objective, status: "watching", priority: Math.round(Math.max(scores.usefulness, scores.urgency) * 100),
        });
        matterId = matter.id;
        status = "prepared";
      } else {
        const artifact = this.office.prepareArtifact({
          tenantId: input.tenantId, kind: normalizedKind, title, content,
          sourceEventIds: [sourceEvent.id],
        });
        artifactId = artifact.id;
        status = "prepared";
      }
      this.store.db.prepare(`INSERT INTO consequence_plans(
        id,tenant_id,source_kind,source_id,source_event_id,session_id,disposition,kind,status,title,objective,rationale,
        member_delta,content,confidence,novelty,usefulness,urgency,artifact_id,matter_id,attention_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        planId, input.tenantId, normalizedSourceKind, sourceId, sourceEvent.id, input.sessionId ?? null,
        normalizedDisposition, normalizedKind, status, title, objective, rationale, memberDelta, content,
        scores.confidence, scores.novelty, scores.usefulness, scores.urgency,
        artifactId ?? null, matterId ?? null, attentionId ?? null, current, current,
      );
      const event = this.store.appendEvent({
        id: stableId("evt", `consequence:${input.tenantId}:${planId}`), tenantId: input.tenantId,
        stream: `consequence:${planId}`, type: `consequence.${status}`, causationId: sourceEvent.id,
        ...(input.sessionId ? { correlationId: input.sessionId } : {}),
        payload: {
          consequenceId: planId, sourceKind: normalizedSourceKind, sourceId, disposition: normalizedDisposition,
          kind: normalizedKind, title, objective, rationale, memberDelta, confidence: scores.confidence,
          novelty: scores.novelty, usefulness: scores.usefulness, urgency: scores.urgency,
          artifactId: artifactId ?? null, matterId: matterId ?? null, attentionId: attentionId ?? null,
        },
      });
      this.store.indexEvidence({
        tenantId: input.tenantId, sourceEventId: event.id, kind: `consequence.${status}`, trustClass: "agent",
        content: `${title}\n${objective}\nWhy useful: ${memberDelta}\n${content}`.slice(0, 100_000), observedAt: event.at,
        metadata: { consequenceId: planId, sourceKind: normalizedSourceKind, sourceId, artifactId: artifactId ?? null, matterId: matterId ?? null },
      });
      return this.get(input.tenantId, planId) as ConsequenceRecord;
    });
  }

  get(tenantId: string, consequenceId: string): ConsequenceRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM consequence_plans WHERE tenant_id=? AND id=?").get(tenantId, consequenceId) as Row | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  list(tenantId: string, limit = 100): ConsequenceRecord[] {
    const rows = this.store.db.prepare("SELECT * FROM consequence_plans WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?")
      .all(tenantId, Math.max(1, Math.min(1_000, Math.floor(limit)))) as Row[];
    return rows.map((row) => this.fromRow(row));
  }

  bindWorkOrder(tenantId: string, consequenceId: string, workOrderId: string): ConsequenceRecord {
    return this.store.transaction(() => {
      const consequence = this.get(tenantId, consequenceId);
      if (!consequence) throw new Error(`Unknown consequence ${consequenceId}`);
      if (consequence.status !== "prepared" && consequence.workOrderId !== workOrderId) {
        throw new Error(`Consequence ${consequenceId} is not available for work-order promotion`);
      }
      const work = this.store.db.prepare("SELECT id,status FROM work_orders WHERE tenant_id=? AND id=?")
        .get(tenantId, workOrderId) as { id: string; status: string } | undefined;
      if (!work) throw new Error("Consequence work order does not belong to the tenant");
      if (consequence.workOrderId && consequence.workOrderId !== workOrderId) {
        throw new Error(`Consequence ${consequenceId} is already bound to another work order`);
      }
      const changed = this.store.db.prepare(`UPDATE consequence_plans SET work_order_id=?,status=?,updated_at=?
        WHERE tenant_id=? AND id=? AND (work_order_id IS NULL OR work_order_id=?)`).run(
          workOrderId, consequenceStatus(work.status), nowIso(), tenantId, consequenceId, workOrderId,
        );
      if (changed.changes !== 1) throw new Error("Consequence work-order binding changed concurrently");
      this.store.appendEvent({
        id: stableId("evt", `consequence-work:${tenantId}:${consequenceId}:${workOrderId}`), tenantId,
        stream: `consequence:${consequenceId}`, type: "consequence.work_queued", correlationId: workOrderId,
        causationId: consequence.sourceEventId, payload: { consequenceId, workOrderId, status: work.status },
      });
      return this.get(tenantId, consequenceId) as ConsequenceRecord;
    });
  }

  syncWorkOrder(tenantId: string, workOrder: WorkOrderRecord): ConsequenceRecord | undefined {
    return this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT id,status FROM consequence_plans WHERE tenant_id=? AND work_order_id=?")
        .get(tenantId, workOrder.id) as { id: string; status: string } | undefined;
      if (!row || row.status === workOrder.status) return row ? this.get(tenantId, row.id) : undefined;
      this.store.db.prepare("UPDATE consequence_plans SET status=?,updated_at=? WHERE tenant_id=? AND id=? AND work_order_id=?")
        .run(workOrder.status, nowIso(), tenantId, row.id, workOrder.id);
      this.store.appendEvent({
        id: stableId("evt", `consequence-work-status:${tenantId}:${row.id}:${workOrder.id}:${workOrder.status}`), tenantId,
        stream: `consequence:${row.id}`, type: `consequence.work_${workOrder.status}`, correlationId: workOrder.id,
        payload: {
          consequenceId: row.id, workOrderId: workOrder.id, status: workOrder.status,
          evidenceIds: workOrder.evidenceIds, result: workOrder.result ?? null, failureReason: workOrder.failureReason ?? null,
        },
      });
      return this.get(tenantId, row.id);
    });
  }

  asJson(record: ConsequenceRecord): JsonObject {
    return { ...record, sessionId: record.sessionId ?? null, artifactId: record.artifactId ?? null, matterId: record.matterId ?? null, attentionId: record.attentionId ?? null, workOrderId: record.workOrderId ?? null } as unknown as JsonObject;
  }

  private fromRow(row: Row): ConsequenceRecord {
    const sessionId = optional(row.session_id); const artifactId = optional(row.artifact_id);
    const matterId = optional(row.matter_id); const attentionId = optional(row.attention_id);
    const workOrderId = optional(row.work_order_id);
    return {
      id: String(row.id), tenantId: String(row.tenant_id), sourceKind: sourceKind(String(row.source_kind)), sourceId: String(row.source_id),
      sourceEventId: String(row.source_event_id), ...(sessionId ? { sessionId } : {}),
      disposition: disposition(String(row.disposition)), kind: consequenceKind(String(row.kind)), status: consequenceStatus(String(row.status)),
      title: String(row.title), objective: String(row.objective), rationale: String(row.rationale), memberDelta: String(row.member_delta),
      content: String(row.content), confidence: Number(row.confidence), novelty: Number(row.novelty), usefulness: Number(row.usefulness), urgency: Number(row.urgency),
      ...(artifactId ? { artifactId } : {}), ...(matterId ? { matterId } : {}), ...(attentionId ? { attentionId } : {}),
      ...(workOrderId ? { workOrderId } : {}),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
}
