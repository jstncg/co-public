import { id, nowIso } from "./id.ts";
import type { SqliteStore } from "./store.ts";
import type { JsonValue, ModelRole, RunResult } from "./types.ts";

type Row = Record<string, unknown>;

export type WorkOrderStatus = "queued" | "running" | "waiting_approval" | "needs_input" | "completed" | "failed" | "cancelled";
export type WorkOrderEvidencePolicy = "run" | "tool" | "external-write";

export interface WorkOrderEvidenceRequirements {
  version: 1;
  minimumReceipts: number;
  requiredToolNames: string[];
}

export interface WorkOrderRecord {
  id: string;
  tenantId: string;
  idempotencyKey?: string;
  objective: string;
  successContract: string;
  evidencePolicy: WorkOrderEvidencePolicy;
  evidenceRequirements: WorkOrderEvidenceRequirements;
  status: WorkOrderStatus;
  modelRole: ModelRole;
  tokenBudget: number;
  allowedTools: string[];
  sourceChannel: string;
  sourcePeerId: string;
  runId?: string;
  approvalId?: string;
  result?: string;
  failureReason?: string;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkOrderAdmission {
  workOrder: WorkOrderRecord;
  jobId: string;
  duplicate: boolean;
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function parseStrings(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function bounded(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must be a non-empty string`);
  if (normalized.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  return normalized;
}

function evidenceRequirements(row: Row): WorkOrderEvidenceRequirements {
  const workOrderId = String(row.id);
  if (typeof row.evidence_requirements_json !== "string") throw new Error(`Work order ${workOrderId} has no evidence requirements`);
  let parsed: unknown;
  try { parsed = JSON.parse(row.evidence_requirements_json); } catch {
    throw new Error(`Work order ${workOrderId} has corrupt evidence requirements: invalid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Work order ${workOrderId} has corrupt evidence requirements: expected an object`);
  }
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["minimumReceipts", "requiredToolNames", "version"])) {
    throw new Error(`Work order ${workOrderId} has corrupt evidence requirements: unsupported shape`);
  }
  if (value.version !== 1) throw new Error(`Work order ${workOrderId} has unsupported evidence requirement version`);
  if (!Number.isSafeInteger(value.minimumReceipts) || Number(value.minimumReceipts) < 0) {
    throw new Error(`Work order ${workOrderId} has corrupt evidence requirements: invalid minimumReceipts`);
  }
  if (!Array.isArray(value.requiredToolNames) || value.requiredToolNames.length > 12
    || value.requiredToolNames.some((name) => typeof name !== "string" || !name.trim())) {
    throw new Error(`Work order ${workOrderId} has corrupt evidence requirements: invalid requiredToolNames`);
  }
  const requiredToolNames = value.requiredToolNames as string[];
  if (new Set(requiredToolNames).size !== requiredToolNames.length) {
    throw new Error(`Work order ${workOrderId} has corrupt evidence requirements: duplicate requiredToolNames`);
  }
  const policy = String(row.evidence_policy);
  if (policy !== "run" && policy !== "tool" && policy !== "external-write") {
    throw new Error(`Work order ${workOrderId} has corrupt evidence requirements: unknown evidence policy`);
  }
  const terminal = ["completed", "failed", "cancelled", "needs_input"].includes(String(row.status));
  if (policy !== "run" && requiredToolNames.length === 0 && !terminal) {
    throw new Error(`Work order ${workOrderId} has unsafe evidence requirements: named tools are required`);
  }
  if (policy === "run" && Number(value.minimumReceipts) !== 0) {
    throw new Error(`Work order ${workOrderId} has corrupt evidence requirements: run policy requires zero minimum receipts`);
  }
  if (policy !== "run" && Number(value.minimumReceipts) < 1) {
    throw new Error(`Work order ${workOrderId} has corrupt evidence requirements: receipt policy requires at least one receipt`);
  }
  return { version: 1, minimumReceipts: Number(value.minimumReceipts), requiredToolNames };
}

function sameAdmission(left: WorkOrderRecord, input: {
  objective: string;
  successContract: string;
  evidencePolicy: WorkOrderEvidencePolicy;
  evidenceRequirements: WorkOrderEvidenceRequirements;
  modelRole: ModelRole;
  tokenBudget: number;
  allowedTools: string[];
  sourceChannel: string;
  sourcePeerId: string;
}): boolean {
  return left.objective === input.objective
    && left.successContract === input.successContract
    && left.evidencePolicy === input.evidencePolicy
    && JSON.stringify(left.evidenceRequirements) === JSON.stringify(input.evidenceRequirements)
    && left.modelRole === input.modelRole
    && left.tokenBudget === input.tokenBudget
    && JSON.stringify(left.allowedTools) === JSON.stringify(input.allowedTools)
    && left.sourceChannel === input.sourceChannel
    && left.sourcePeerId === input.sourcePeerId;
}

export class WorkOrderManager {
  readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  submit(input: {
    tenantId: string;
    objective: string;
    successContract?: string;
    evidencePolicy?: WorkOrderEvidencePolicy;
    minimumReceipts?: number;
    requiredToolNames?: string[];
    modelRole?: ModelRole;
    tokenBudget?: number;
    allowedTools: string[];
    sourceChannel?: string;
    sourcePeerId?: string;
    idempotencyKey?: string;
    releaseId?: string;
  }): WorkOrderAdmission {
    const evidencePolicy = input.evidencePolicy ?? "tool";
    const allowedTools = [...new Set(input.allowedTools.filter(Boolean))].sort().slice(0, 256);
    const requestedEvidenceTools = [...new Set((input.requiredToolNames ?? []).filter(Boolean))].sort();
    if (requestedEvidenceTools.length > 12) throw new Error("A work order can require at most 12 distinct tool receipts");
    const requiredToolNames = requestedEvidenceTools;
    if (evidencePolicy !== "run" && requiredToolNames.length === 0) {
      throw new Error(`${evidencePolicy} evidence requires at least one named tool receipt`);
    }
    const unavailableEvidence = requiredToolNames.filter((name) => !allowedTools.includes(name));
    if (unavailableEvidence.length) throw new Error(`Required evidence tools are outside work-order authority: ${unavailableEvidence.join(", ")}`);
    const normalized = {
      objective: bounded(input.objective, "objective", 20_000),
      successContract: bounded(input.successContract ?? "Complete the requested outcome and leave verifiable evidence of what was actually done.", "successContract", 10_000),
      evidencePolicy,
      evidenceRequirements: {
        version: 1 as const,
        minimumReceipts: evidencePolicy === "run" ? 0 : Math.max(1, Math.min(1_000, Math.floor(input.minimumReceipts ?? 1))),
        requiredToolNames,
      },
      modelRole: input.modelRole ?? "deliberation",
      tokenBudget: Math.max(256, Math.min(100_000, Math.floor(input.tokenBudget ?? 60_000))),
      allowedTools,
      sourceChannel: bounded(input.sourceChannel ?? "cli", "sourceChannel", 64),
      sourcePeerId: bounded(input.sourcePeerId ?? "local", "sourcePeerId", 512),
    };
    const idempotencyKey = input.idempotencyKey ? bounded(input.idempotencyKey, "idempotencyKey", 512) : undefined;
    if (idempotencyKey) {
      const prior = this.byIdempotencyKey(input.tenantId, idempotencyKey);
      if (prior) {
        if (!sameAdmission(prior, normalized)) throw new Error(`Work-order idempotency key ${idempotencyKey} was reused with different content`);
        const job = this.store.enqueueJob(input.tenantId, "work.execute", { workOrderId: prior.id }, {
          idempotencyKey: `work-order:${prior.id}`, ...(input.releaseId ? { releaseId: input.releaseId } : {}),
        });
        return { workOrder: prior, jobId: job.id, duplicate: true };
      }
    }

    const workOrderId = id("work");
    const current = nowIso();
    return this.store.transaction(() => {
      if (idempotencyKey) {
        const concurrent = this.byIdempotencyKey(input.tenantId, idempotencyKey);
        if (concurrent) {
          if (!sameAdmission(concurrent, normalized)) throw new Error(`Work-order idempotency key ${idempotencyKey} was reused with different content`);
          const job = this.store.enqueueJob(input.tenantId, "work.execute", { workOrderId: concurrent.id }, {
            idempotencyKey: `work-order:${concurrent.id}`, ...(input.releaseId ? { releaseId: input.releaseId } : {}),
          });
          return { workOrder: concurrent, jobId: job.id, duplicate: true };
        }
      }
      this.store.db.prepare(`INSERT INTO work_orders(
        id,tenant_id,idempotency_key,objective,success_contract,evidence_policy,evidence_requirements_json,status,model_role,token_budget,
        allowed_tools_json,source_channel,source_peer_id,evidence_ids_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        workOrderId, input.tenantId, idempotencyKey ?? null, normalized.objective, normalized.successContract,
        normalized.evidencePolicy, JSON.stringify(normalized.evidenceRequirements), "queued", normalized.modelRole, normalized.tokenBudget, JSON.stringify(normalized.allowedTools),
        normalized.sourceChannel, normalized.sourcePeerId, "[]", current, current,
      );
      const event = this.store.appendEvent({
        tenantId: input.tenantId, stream: `work-order:${workOrderId}`, type: "work_order.queued", correlationId: workOrderId,
        payload: {
          workOrderId, objective: normalized.objective, successContract: normalized.successContract,
          evidencePolicy: normalized.evidencePolicy, evidenceRequirements: normalized.evidenceRequirements, modelRole: normalized.modelRole, tokenBudget: normalized.tokenBudget,
          allowedTools: normalized.allowedTools, sourceChannel: normalized.sourceChannel, sourcePeerId: normalized.sourcePeerId,
        },
      });
      this.store.indexEvidence({
        tenantId: input.tenantId, sourceEventId: event.id, kind: "work-order.objective", trustClass: "owner",
        content: normalized.objective, observedAt: event.at, metadata: { workOrderId, successContract: normalized.successContract },
      });
      const job = this.store.enqueueJob(input.tenantId, "work.execute", { workOrderId }, {
        idempotencyKey: `work-order:${workOrderId}`, ...(input.releaseId ? { releaseId: input.releaseId } : {}),
      });
      return { workOrder: this.get(input.tenantId, workOrderId) as WorkOrderRecord, jobId: job.id, duplicate: false };
    });
  }

  get(tenantId: string, workOrderId: string): WorkOrderRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM work_orders WHERE tenant_id=? AND id=?").get(tenantId, workOrderId) as Row | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  getByRun(tenantId: string, runId: string): WorkOrderRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM work_orders WHERE tenant_id=? AND run_id=?").get(tenantId, runId) as Row | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  list(tenantId: string, status?: WorkOrderStatus, limit = 100): WorkOrderRecord[] {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = status
      ? this.store.db.prepare("SELECT * FROM work_orders WHERE tenant_id=? AND status=? ORDER BY updated_at DESC LIMIT ?").all(tenantId, status, boundedLimit) as Row[]
      : this.store.db.prepare("SELECT * FROM work_orders WHERE tenant_id=? ORDER BY updated_at DESC LIMIT ?").all(tenantId, boundedLimit) as Row[];
    return rows.map((row) => this.fromRow(row));
  }

  markRunning(tenantId: string, workOrderId: string): WorkOrderRecord {
    return this.store.transaction(() => {
      const workOrder = this.require(tenantId, workOrderId);
      if (workOrder.status === "running" || workOrder.status === "waiting_approval") return workOrder;
      if (workOrder.status !== "queued") throw new Error(`Work order ${workOrderId} is ${workOrder.status}`);
      const current = nowIso();
      this.store.db.prepare("UPDATE work_orders SET status='running',updated_at=? WHERE tenant_id=? AND id=? AND status='queued'")
        .run(current, tenantId, workOrderId);
      this.store.appendEvent({ tenantId, stream: `work-order:${workOrderId}`, type: "work_order.started", correlationId: workOrderId, payload: { workOrderId } });
      return this.require(tenantId, workOrderId);
    });
  }

  syncRunResult(tenantId: string, result: RunResult): WorkOrderRecord | undefined {
    const row = this.store.db.prepare("SELECT id FROM work_orders WHERE tenant_id=? AND run_id=?").get(tenantId, result.runId) as Row | undefined;
    if (!row) return undefined;
    const workOrder = this.require(tenantId, String(row.id));
    if (workOrder.status === "completed" || workOrder.status === "failed" || workOrder.status === "cancelled") return workOrder;
    const receipts = this.store.db.prepare(`SELECT id,tool_name,evidence_class,evidence_scope,status FROM tool_receipts
      WHERE tenant_id=? AND run_id=? ORDER BY started_at`).all(tenantId, result.runId) as Array<{ id: string; tool_name: string; evidence_class: string; evidence_scope: string; status: string }>;
    const successful = receipts.filter((receipt) => receipt.status === "succeeded");
    const completedOutcomes = successful.filter((receipt) => receipt.evidence_scope === "outcome");
    const unconfirmedConsequential = receipts.filter((receipt) => ["external-write", "destructive"].includes(receipt.evidence_class)
      && (receipt.status !== "succeeded" || receipt.evidence_scope !== "outcome"));
    const eligible = workOrder.evidencePolicy === "external-write"
      ? completedOutcomes.filter((receipt) => receipt.evidence_class === "external-write" && workOrder.evidenceRequirements.requiredToolNames.includes(receipt.tool_name))
      : completedOutcomes.filter((receipt) => workOrder.evidenceRequirements.requiredToolNames.includes(receipt.tool_name));
    const requiredReceipts = eligible;
    const missingTools = workOrder.evidenceRequirements.requiredToolNames.filter((name) => !requiredReceipts.some((receipt) => receipt.tool_name === name));
    const countPassed = workOrder.evidencePolicy === "run" || eligible.length >= workOrder.evidenceRequirements.minimumReceipts;
    const evidencePassed = result.status === "completed" && countPassed && missingTools.length === 0 && unconfirmedConsequential.length === 0;
    const evidenceIds = [...new Set([
      ...(workOrder.evidencePolicy === "run" && result.status === "completed" ? [result.runId] : eligible.map((receipt) => receipt.id)),
      ...successful.map((receipt) => receipt.id),
      ...requiredReceipts.map((receipt) => receipt.id),
    ])];

    let status: WorkOrderStatus;
    let failureReason: string | undefined;
    if (result.status === "waiting_approval") status = "waiting_approval";
    else if (result.status === "cancelled") status = "cancelled";
    else if (result.status === "failed") { status = "failed"; failureReason = result.text || "Run failed"; }
    else if (result.status === "completed" && evidencePassed) status = "completed";
    else if (result.status === "completed") {
      status = "needs_input";
      const countReason = eligible.length < workOrder.evidenceRequirements.minimumReceipts
        ? `${eligible.length}/${workOrder.evidenceRequirements.minimumReceipts} required ${workOrder.evidencePolicy} receipts succeeded`
        : undefined;
      const toolReason = missingTools.length ? `missing successful receipts for ${missingTools.join(", ")}` : undefined;
      const consequenceReason = unconfirmedConsequential.length
        ? `unconfirmed consequential outcomes for ${[...new Set(unconfirmedConsequential.map((receipt) => receipt.tool_name))].join(", ")}`
        : undefined;
      failureReason = `Completion evidence did not pass: ${[countReason, toolReason, consequenceReason].filter(Boolean).join("; ")}.`;
    } else status = "running";
    if (workOrder.status === status && workOrder.approvalId === result.approvalId && workOrder.result === (result.text || undefined)
      && workOrder.failureReason === failureReason && JSON.stringify(workOrder.evidenceIds) === JSON.stringify(evidenceIds)) return workOrder;
    const current = nowIso();
    const terminal = status === "completed" || status === "failed" || status === "cancelled" || status === "needs_input";
    return this.store.transaction(() => {
      this.store.db.prepare(`UPDATE work_orders SET status=?,approval_id=?,result=?,failure_reason=?,evidence_ids_json=?,updated_at=?,completed_at=?
        WHERE tenant_id=? AND id=?`).run(
        status, result.approvalId ?? null, result.text || null, failureReason ?? null, JSON.stringify(evidenceIds), current,
        terminal ? current : null, tenantId, workOrder.id,
      );
      const event = this.store.appendEvent({
        tenantId, stream: `work-order:${workOrder.id}`, type: `work_order.${status}`, correlationId: workOrder.id, causationId: result.runId,
        payload: {
          workOrderId: workOrder.id, runId: result.runId, status, approvalId: result.approvalId ?? null,
          evidencePolicy: workOrder.evidencePolicy,
          evidenceRequirements: {
            version: workOrder.evidenceRequirements.version,
            minimumReceipts: workOrder.evidenceRequirements.minimumReceipts,
            requiredToolNames: workOrder.evidenceRequirements.requiredToolNames,
          },
          evidenceIds, failureReason: failureReason ?? null,
        },
      });
      if (terminal && result.text) this.store.indexEvidence({
        tenantId, sourceEventId: event.id, kind: "work-order.result", trustClass: "agent", content: result.text,
        observedAt: event.at, metadata: { workOrderId: workOrder.id, runId: result.runId, status, evidenceIds },
      });
      return this.require(tenantId, workOrder.id);
    });
  }

  bindRun(tenantId: string, workOrderId: string, runId: string): WorkOrderRecord {
    return this.store.transaction(() => {
      const workOrder = this.require(tenantId, workOrderId);
      if (workOrder.runId && workOrder.runId !== runId) throw new Error(`Work order ${workOrderId} is already bound to run ${workOrder.runId}`);
      this.store.db.prepare("UPDATE work_orders SET run_id=?,updated_at=? WHERE tenant_id=? AND id=?").run(runId, nowIso(), tenantId, workOrderId);
      return this.require(tenantId, workOrderId);
    });
  }

  cancel(tenantId: string, workOrderId: string): WorkOrderRecord {
    return this.store.transaction(() => {
      const workOrder = this.require(tenantId, workOrderId);
      if (workOrder.status === "cancelled") return workOrder;
      if (workOrder.status === "completed" || workOrder.status === "failed") throw new Error(`Work order ${workOrderId} is ${workOrder.status}`);
      const current = nowIso();
      this.store.db.prepare("UPDATE work_orders SET status='cancelled',updated_at=?,completed_at=? WHERE tenant_id=? AND id=?")
        .run(current, current, tenantId, workOrderId);
      this.store.db.prepare(`UPDATE jobs SET status='cancelled',updated_at=? WHERE tenant_id=? AND type='work.execute'
        AND status='queued' AND json_extract(payload_json,'$.workOrderId')=?`).run(current, tenantId, workOrderId);
      this.store.appendEvent({ tenantId, stream: `work-order:${workOrderId}`, type: "work_order.cancelled", correlationId: workOrderId, payload: { workOrderId, historyRetained: true } });
      return this.require(tenantId, workOrderId);
    });
  }

  fail(tenantId: string, workOrderId: string, reason: string): WorkOrderRecord {
    return this.store.transaction(() => {
      const workOrder = this.require(tenantId, workOrderId);
      if (workOrder.status === "completed" || workOrder.status === "cancelled" || workOrder.status === "failed") return workOrder;
      const failureReason = bounded(reason, "reason", 2_000);
      const current = nowIso();
      this.store.db.prepare("UPDATE work_orders SET status='failed',failure_reason=?,updated_at=?,completed_at=? WHERE tenant_id=? AND id=?")
        .run(failureReason, current, current, tenantId, workOrderId);
      this.store.appendEvent({ tenantId, stream: `work-order:${workOrderId}`, type: "work_order.failed", correlationId: workOrderId, payload: { workOrderId, failureReason, retriesExhausted: true } });
      return this.require(tenantId, workOrderId);
    });
  }

  failClosed(tenantId: string, workOrderId: string, reason: string): void {
    const failureReason = bounded(reason, "reason", 2_000);
    const current = nowIso();
    this.store.transaction(() => {
      const changed = this.store.db.prepare(`UPDATE work_orders SET status='failed',failure_reason=?,updated_at=?,completed_at=?
        WHERE tenant_id=? AND id=? AND status NOT IN ('completed','cancelled','failed')`)
        .run(failureReason, current, current, tenantId, workOrderId);
      if (changed.changes) this.store.appendEvent({
        tenantId, stream: `work-order:${workOrderId}`, type: "work_order.failed", correlationId: workOrderId,
        payload: { workOrderId, failureReason, failedClosed: true },
      });
    });
  }

  failByRunClosed(tenantId: string, runId: string, reason: string): void {
    const row = this.store.db.prepare("SELECT id FROM work_orders WHERE tenant_id=? AND run_id=?").get(tenantId, runId) as Row | undefined;
    if (row) this.failClosed(tenantId, String(row.id), reason);
  }

  asJson(workOrder: WorkOrderRecord): JsonValue {
    return {
      workOrderId: workOrder.id, objective: workOrder.objective, successContract: workOrder.successContract,
      evidencePolicy: workOrder.evidencePolicy,
      evidenceRequirements: {
        version: workOrder.evidenceRequirements.version,
        minimumReceipts: workOrder.evidenceRequirements.minimumReceipts,
        requiredToolNames: workOrder.evidenceRequirements.requiredToolNames,
      },
      status: workOrder.status, modelRole: workOrder.modelRole,
      tokenBudget: workOrder.tokenBudget, allowedTools: workOrder.allowedTools, sourceChannel: workOrder.sourceChannel,
      sourcePeerId: workOrder.sourcePeerId, runId: workOrder.runId ?? null, approvalId: workOrder.approvalId ?? null,
      result: workOrder.result ?? null, failureReason: workOrder.failureReason ?? null, evidenceIds: workOrder.evidenceIds,
      createdAt: workOrder.createdAt, updatedAt: workOrder.updatedAt, completedAt: workOrder.completedAt ?? null,
    };
  }

  private require(tenantId: string, workOrderId: string): WorkOrderRecord {
    const workOrder = this.get(tenantId, workOrderId);
    if (!workOrder) throw new Error(`Unknown work order ${workOrderId}`);
    return workOrder;
  }

  private byIdempotencyKey(tenantId: string, idempotencyKey: string): WorkOrderRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM work_orders WHERE tenant_id=? AND idempotency_key=?").get(tenantId, idempotencyKey) as Row | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  private fromRow(row: Row): WorkOrderRecord {
    const idempotencyKey = optional(row.idempotency_key);
    const runId = optional(row.run_id);
    const approvalId = optional(row.approval_id);
    const result = optional(row.result);
    const failureReason = optional(row.failure_reason);
    const completedAt = optional(row.completed_at);
    return {
      id: String(row.id), tenantId: String(row.tenant_id), ...(idempotencyKey ? { idempotencyKey } : {}),
      objective: String(row.objective), successContract: String(row.success_contract),
      evidencePolicy: String(row.evidence_policy) as WorkOrderEvidencePolicy, status: String(row.status) as WorkOrderStatus,
      evidenceRequirements: evidenceRequirements(row),
      modelRole: String(row.model_role) as ModelRole, tokenBudget: Number(row.token_budget), allowedTools: parseStrings(row.allowed_tools_json),
      sourceChannel: String(row.source_channel), sourcePeerId: String(row.source_peer_id), ...(runId ? { runId } : {}),
      ...(approvalId ? { approvalId } : {}), ...(result ? { result } : {}), ...(failureReason ? { failureReason } : {}),
      evidenceIds: parseStrings(row.evidence_ids_json), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      ...(completedAt ? { completedAt } : {}),
    };
  }
}
