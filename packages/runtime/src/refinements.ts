import { id, nowIso } from "./id.ts";
import type { RetainedAgentManager } from "./agents.ts";
import type { SqliteStore } from "./store.ts";
import type { JsonObject } from "./types.ts";

type Row = Record<string, unknown>;

export type RefinementKind = "prompt_overlay" | "agent_spec" | "procedure" | "memory_policy";
export type RefinementScope = "local" | "tenant" | "distribution";
export type RefinementStatus = "proposed" | "approved" | "rejected" | "applied" | "retired";

export interface RefinementProposalRecord {
  id: string;
  tenantId: string;
  kind: RefinementKind;
  scope: RefinementScope;
  targetId: string;
  title: string;
  rationale: string;
  expectedEffect: string;
  patch: JsonObject;
  evidenceEventIds: string[];
  sourceRunId?: string;
  sourceEventId: string;
  supersedesId?: string;
  baseVersion: number;
  proposedVersion: number;
  status: RefinementStatus;
  review?: JsonObject;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  appliedAt?: string;
  retiredAt?: string;
}

export interface HarnessOverlayRecord {
  id: string;
  tenantId: string;
  kind: RefinementKind;
  scope: RefinementScope;
  targetId: string;
  version: number;
  content: JsonObject;
  sourceProposalId: string;
  status: "active" | "superseded" | "retired";
  createdAt: string;
  supersededAt?: string;
  retiredAt?: string;
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function parseObject(value: unknown): JsonObject {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
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

export class RefinementManager {
  readonly store: SqliteStore;
  readonly agents: RetainedAgentManager;

  constructor(store: SqliteStore, agents: RetainedAgentManager) {
    this.store = store;
    this.agents = agents;
  }

  propose(input: {
    tenantId: string;
    kind: RefinementKind;
    scope: RefinementScope;
    targetId: string;
    title: string;
    rationale: string;
    expectedEffect: string;
    patch: JsonObject;
    evidenceEventIds: string[];
    sourceRunId?: string;
    sourceEventId: string;
    supersedesId?: string;
  }): RefinementProposalRecord {
    const targetId = bounded(input.targetId, "targetId", 256);
    if (input.scope === "local" && !this.agents.get(input.tenantId, targetId)) throw new Error(`Local refinement target ${targetId} must be a retained agent in this tenant`);
    if (input.scope === "tenant" && targetId !== input.tenantId) throw new Error(`Tenant refinement target must be ${input.tenantId}`);
    this.validatePatch(input.kind, input.patch);
    if (!this.store.getEvent(input.tenantId, input.sourceEventId)) throw new Error(`Source event ${input.sourceEventId} does not belong to tenant ${input.tenantId}`);
    if (input.sourceRunId && !this.store.getRun(input.sourceRunId, input.tenantId)) throw new Error(`Run ${input.sourceRunId} does not belong to tenant ${input.tenantId}`);
    const evidenceEventIds = [...new Set(input.evidenceEventIds)].slice(0, 64);
    for (const eventId of evidenceEventIds) if (!this.store.getEvent(input.tenantId, eventId)) throw new Error(`Evidence event ${eventId} does not belong to tenant ${input.tenantId}`);
    const supersedes = input.supersedesId ? this.get(input.tenantId, input.supersedesId) : undefined;
    if (input.supersedesId && !supersedes) throw new Error(`Unknown superseded refinement ${input.supersedesId}`);
    if (supersedes && (supersedes.kind !== input.kind || supersedes.scope !== input.scope || supersedes.targetId !== targetId)) throw new Error("A refinement revision must keep the same kind, scope, and target");

    const baseVersion = this.currentVersion(input.tenantId, input.kind, input.scope, targetId);
    const proposalId = id("rfp");
    const current = nowIso();
    this.store.transaction(() => {
      this.store.db.prepare(`INSERT INTO refinement_proposals(
        id,tenant_id,kind,scope,target_id,title,rationale,expected_effect,patch_json,evidence_event_ids_json,source_run_id,source_event_id,
        supersedes_id,base_version,proposed_version,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        proposalId, input.tenantId, input.kind, input.scope, targetId, bounded(input.title, "title", 256), bounded(input.rationale, "rationale", 5_000),
        bounded(input.expectedEffect, "expectedEffect", 2_000), JSON.stringify(input.patch), JSON.stringify(evidenceEventIds), input.sourceRunId ?? null,
        input.sourceEventId, input.supersedesId ?? null, baseVersion, baseVersion + 1, "proposed", current, current,
      );
      this.store.appendEvent({
        tenantId: input.tenantId, stream: `refinement:${proposalId}`, type: "refinement.proposed", correlationId: proposalId, causationId: input.sourceEventId,
        payload: { proposalId, kind: input.kind, scope: input.scope, targetId, baseVersion, proposedVersion: baseVersion + 1, evidenceEventIds },
      });
    });
    return this.get(input.tenantId, proposalId) as RefinementProposalRecord;
  }

  get(tenantId: string, proposalId: string): RefinementProposalRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM refinement_proposals WHERE tenant_id=? AND id=?").get(tenantId, proposalId) as Row | undefined;
    return row ? this.proposalFromRow(row) : undefined;
  }

  list(tenantId: string, status?: RefinementStatus, limit = 100): RefinementProposalRecord[] {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = status
      ? this.store.db.prepare("SELECT * FROM refinement_proposals WHERE tenant_id=? AND status=? ORDER BY created_at DESC LIMIT ?").all(tenantId, status, boundedLimit) as Row[]
      : this.store.db.prepare("SELECT * FROM refinement_proposals WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?").all(tenantId, boundedLimit) as Row[];
    return rows.map((row) => this.proposalFromRow(row));
  }

  approve(tenantId: string, proposalId: string, review: JsonObject = {}): RefinementProposalRecord {
    return this.transition(tenantId, proposalId, ["proposed"], "approved", review);
  }

  reject(tenantId: string, proposalId: string, review: JsonObject = {}): RefinementProposalRecord {
    return this.transition(tenantId, proposalId, ["proposed", "approved"], "rejected", review);
  }

  apply(tenantId: string, proposalId: string): { proposal: RefinementProposalRecord; overlay: HarnessOverlayRecord } {
    const proposal = this.get(tenantId, proposalId);
    if (!proposal) throw new Error(`Unknown refinement proposal ${proposalId}`);
    if (proposal.status === "applied") {
      const existing = this.store.db.prepare("SELECT * FROM harness_overlays WHERE tenant_id=? AND source_proposal_id=?")
        .get(tenantId, proposalId) as Row | undefined;
      if (!existing) throw new Error(`Applied refinement ${proposalId} has no overlay`);
      return { proposal, overlay: this.overlayFromRow(existing) };
    }
    if (proposal.status !== "approved") throw new Error(`Refinement proposal ${proposalId} must be approved before apply`);
    this.validatePatch(proposal.kind, proposal.patch);
    return this.store.transaction(() => {
      const active = this.activeOverlay(tenantId, proposal.kind, proposal.scope, proposal.targetId);
      const currentVersion = this.currentVersion(tenantId, proposal.kind, proposal.scope, proposal.targetId);
      if (currentVersion !== proposal.baseVersion) throw new Error(`Refinement conflict: planned from version ${proposal.baseVersion}, active version is ${currentVersion}`);
      const current = nowIso();
      if (active) this.store.db.prepare("UPDATE harness_overlays SET status='superseded',superseded_at=? WHERE tenant_id=? AND id=? AND status='active'")
        .run(current, tenantId, active.id);
      const overlayId = id("hov");
      this.store.db.prepare(`INSERT INTO harness_overlays(id,tenant_id,kind,scope,target_id,version,content_json,source_proposal_id,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        overlayId, tenantId, proposal.kind, proposal.scope, proposal.targetId, proposal.proposedVersion, JSON.stringify(proposal.patch), proposal.id, "active", current,
      );
      this.store.db.prepare("UPDATE refinement_proposals SET status='applied',updated_at=?,decided_at=COALESCE(decided_at,?),applied_at=? WHERE tenant_id=? AND id=? AND status='approved'")
        .run(current, current, current, tenantId, proposal.id);
      this.store.appendEvent({
        tenantId, stream: `refinement:${proposal.id}`, type: "refinement.applied", correlationId: proposal.id,
        payload: { proposalId: proposal.id, overlayId, kind: proposal.kind, scope: proposal.scope, targetId: proposal.targetId, version: proposal.proposedVersion, priorOverlayId: active?.id ?? null },
      });
      const row = this.store.db.prepare("SELECT * FROM harness_overlays WHERE tenant_id=? AND id=?").get(tenantId, overlayId) as Row;
      return { proposal: this.get(tenantId, proposal.id) as RefinementProposalRecord, overlay: this.overlayFromRow(row) };
    });
  }

  retire(tenantId: string, proposalId: string): RefinementProposalRecord {
    const proposal = this.get(tenantId, proposalId);
    if (!proposal) throw new Error(`Unknown refinement proposal ${proposalId}`);
    if (proposal.status === "retired") return proposal;
    if (proposal.status !== "applied") throw new Error(`Only an applied refinement can be retired; ${proposalId} is ${proposal.status}`);
    const current = nowIso();
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE harness_overlays SET status='retired',retired_at=? WHERE tenant_id=? AND source_proposal_id=? AND status='active'")
        .run(current, tenantId, proposalId);
      this.store.db.prepare("UPDATE refinement_proposals SET status='retired',retired_at=?,updated_at=? WHERE tenant_id=? AND id=?")
        .run(current, current, tenantId, proposalId);
      this.store.appendEvent({ tenantId, stream: `refinement:${proposalId}`, type: "refinement.retired", correlationId: proposalId, payload: { proposalId, historyRetained: true } });
    });
    return this.get(tenantId, proposalId) as RefinementProposalRecord;
  }

  rollback(tenantId: string, sourceProposalId: string): { proposal: RefinementProposalRecord; overlay: HarnessOverlayRecord } {
    const sourceProposal = this.get(tenantId, sourceProposalId);
    if (!sourceProposal) throw new Error(`Unknown refinement proposal ${sourceProposalId}`);
    const sourceOverlayRow = this.store.db.prepare("SELECT * FROM harness_overlays WHERE tenant_id=? AND source_proposal_id=?")
      .get(tenantId, sourceProposalId) as Row | undefined;
    if (!sourceOverlayRow) throw new Error(`Refinement ${sourceProposalId} was never applied and cannot be restored`);
    const sourceOverlay = this.overlayFromRow(sourceOverlayRow);
    const trigger = this.store.appendEvent({
      tenantId, stream: `refinement:${sourceProposalId}`, type: "refinement.rollback_requested", correlationId: sourceProposalId,
      payload: { sourceProposalId, sourceOverlayId: sourceOverlay.id, sourceVersion: sourceOverlay.version },
    });
    const proposal = this.propose({
      tenantId, kind: sourceProposal.kind, scope: sourceProposal.scope, targetId: sourceProposal.targetId,
      title: `Restore ${sourceProposal.title} (version ${sourceOverlay.version})`,
      rationale: `Operator requested a non-erasing rollback to overlay ${sourceOverlay.id}.`,
      expectedEffect: `Restore the reviewed behavior from version ${sourceOverlay.version} as a new version.`,
      patch: sourceOverlay.content, evidenceEventIds: [sourceProposal.sourceEventId], sourceEventId: trigger.id,
    });
    this.approve(tenantId, proposal.id, { operatorRollback: true, sourceProposalId, sourceOverlayId: sourceOverlay.id });
    return this.apply(tenantId, proposal.id);
  }

  activeOverlay(tenantId: string, kind: RefinementKind, scope: RefinementScope, targetId: string): HarnessOverlayRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM harness_overlays WHERE tenant_id=? AND kind=? AND scope=? AND target_id=? AND status='active'")
      .get(tenantId, kind, scope, targetId) as Row | undefined;
    return row ? this.overlayFromRow(row) : undefined;
  }

  overlays(tenantId: string, options: { status?: "active" | "superseded" | "retired"; limit?: number } = {}): HarnessOverlayRecord[] {
    const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 100)));
    const rows = options.status
      ? this.store.db.prepare("SELECT * FROM harness_overlays WHERE tenant_id=? AND status=? ORDER BY created_at DESC LIMIT ?").all(tenantId, options.status, limit) as Row[]
      : this.store.db.prepare("SELECT * FROM harness_overlays WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?").all(tenantId, limit) as Row[];
    return rows.map((row) => this.overlayFromRow(row));
  }

  promptInstructions(tenantId: string, distributionId: string, agentId?: string): string {
    const targets: Array<[RefinementScope, string]> = [["distribution", distributionId], ["tenant", tenantId]];
    if (agentId) targets.push(["local", agentId]);
    return targets.flatMap(([scope, targetId]) => {
      const overlay = this.activeOverlay(tenantId, "prompt_overlay", scope, targetId);
      const instructions = overlay?.content.instructions;
      return overlay && typeof instructions === "string" && instructions.trim()
        ? [`- [overlay ${overlay.id}; ${scope}:${targetId}; v${overlay.version}] ${instructions.trim()}`]
        : [];
    }).join("\n");
  }

  asJson(proposal: RefinementProposalRecord): JsonObject {
    return {
      proposalId: proposal.id, kind: proposal.kind, scope: proposal.scope, targetId: proposal.targetId, title: proposal.title,
      rationale: proposal.rationale, expectedEffect: proposal.expectedEffect, patch: proposal.patch, evidenceEventIds: proposal.evidenceEventIds,
      sourceRunId: proposal.sourceRunId ?? null, sourceEventId: proposal.sourceEventId, supersedesId: proposal.supersedesId ?? null,
      baseVersion: proposal.baseVersion, proposedVersion: proposal.proposedVersion, status: proposal.status, review: proposal.review ?? null,
      createdAt: proposal.createdAt, updatedAt: proposal.updatedAt, decidedAt: proposal.decidedAt ?? null,
      appliedAt: proposal.appliedAt ?? null, retiredAt: proposal.retiredAt ?? null,
    };
  }

  overlayJson(overlay: HarnessOverlayRecord): JsonObject {
    return {
      overlayId: overlay.id, kind: overlay.kind, scope: overlay.scope, targetId: overlay.targetId, version: overlay.version,
      content: overlay.content, sourceProposalId: overlay.sourceProposalId, status: overlay.status, createdAt: overlay.createdAt,
      supersededAt: overlay.supersededAt ?? null, retiredAt: overlay.retiredAt ?? null,
    };
  }

  private validatePatch(kind: RefinementKind, patch: JsonObject): void {
    const allowed = kind === "prompt_overlay" ? new Set(["instructions"])
      : kind === "agent_spec" ? new Set(["instructions", "preferredModelRole", "tokenBudget"])
        : kind === "procedure" ? new Set(["instructions", "description"])
          : new Set(["retrievalNotes", "retentionNotes"]);
    const unknown = Object.keys(patch).filter((key) => !allowed.has(key));
    if (unknown.length) throw new Error(`Refinement patch contains authority-bearing or unknown fields: ${unknown.join(", ")}`);
    if (!Object.keys(patch).length) throw new Error("Refinement patch cannot be empty");
    for (const [key, value] of Object.entries(patch)) {
      if (key === "tokenBudget") {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 256 || value > 20_000) throw new Error("agent_spec tokenBudget must be an integer from 256 to 20000");
      } else if (key === "preferredModelRole") {
        if (value !== "foreground" && value !== "deliberation" && value !== "background" && value !== "critic") throw new Error("preferredModelRole is invalid");
      } else if (typeof value !== "string" || !value.trim() || value.length > 30_000) throw new Error(`${key} must be a non-empty string under 30000 characters`);
    }
  }

  private currentVersion(tenantId: string, kind: RefinementKind, scope: RefinementScope, targetId: string): number {
    const row = this.store.db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM harness_overlays WHERE tenant_id=? AND kind=? AND scope=? AND target_id=?")
      .get(tenantId, kind, scope, targetId) as Row;
    return Number(row.version ?? 0);
  }

  private transition(tenantId: string, proposalId: string, from: RefinementStatus[], to: RefinementStatus, review: JsonObject): RefinementProposalRecord {
    const current = nowIso();
    const placeholders = from.map(() => "?").join(",");
    const result = this.store.db.prepare(`UPDATE refinement_proposals SET status=?,review_json=?,updated_at=?,decided_at=? WHERE tenant_id=? AND id=? AND status IN (${placeholders})`)
      .run(to, JSON.stringify(review), current, current, tenantId, proposalId, ...from);
    if (result.changes !== 1) {
      const existing = this.get(tenantId, proposalId);
      if (!existing) throw new Error(`Unknown refinement proposal ${proposalId}`);
      if (existing.status === to) return existing;
      throw new Error(`Refinement proposal ${proposalId} cannot transition from ${existing.status} to ${to}`);
    }
    this.store.appendEvent({
      tenantId, stream: `refinement:${proposalId}`, type: `refinement.${to}`, correlationId: proposalId,
      payload: { proposalId, to, review },
    });
    return this.get(tenantId, proposalId) as RefinementProposalRecord;
  }

  private proposalFromRow(row: Row): RefinementProposalRecord {
    const sourceRunId = optional(row.source_run_id);
    const supersedesId = optional(row.supersedes_id);
    const reviewRaw = optional(row.review_json);
    const decidedAt = optional(row.decided_at);
    const appliedAt = optional(row.applied_at);
    const retiredAt = optional(row.retired_at);
    return {
      id: String(row.id), tenantId: String(row.tenant_id), kind: String(row.kind) as RefinementKind, scope: String(row.scope) as RefinementScope,
      targetId: String(row.target_id), title: String(row.title), rationale: String(row.rationale), expectedEffect: String(row.expected_effect),
      patch: parseObject(row.patch_json), evidenceEventIds: parseStrings(row.evidence_event_ids_json), ...(sourceRunId ? { sourceRunId } : {}),
      sourceEventId: String(row.source_event_id), ...(supersedesId ? { supersedesId } : {}), baseVersion: Number(row.base_version),
      proposedVersion: Number(row.proposed_version), status: String(row.status) as RefinementStatus, ...(reviewRaw ? { review: parseObject(reviewRaw) } : {}),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), ...(decidedAt ? { decidedAt } : {}),
      ...(appliedAt ? { appliedAt } : {}), ...(retiredAt ? { retiredAt } : {}),
    };
  }

  private overlayFromRow(row: Row): HarnessOverlayRecord {
    const supersededAt = optional(row.superseded_at);
    const retiredAt = optional(row.retired_at);
    return {
      id: String(row.id), tenantId: String(row.tenant_id), kind: String(row.kind) as RefinementKind, scope: String(row.scope) as RefinementScope,
      targetId: String(row.target_id), version: Number(row.version), content: parseObject(row.content_json), sourceProposalId: String(row.source_proposal_id),
      status: String(row.status) as HarnessOverlayRecord["status"], createdAt: String(row.created_at),
      ...(supersededAt ? { supersededAt } : {}), ...(retiredAt ? { retiredAt } : {}),
    };
  }
}
