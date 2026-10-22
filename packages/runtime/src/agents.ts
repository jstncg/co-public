import { id, nowIso, stableId } from "./id.ts";
import { ResponsibilityManager } from "./responsibilities.ts";
import type { SqliteStore } from "./store.ts";
import type { JsonObject, JsonValue, ModelRole, RunResult } from "./types.ts";

type Row = Record<string, unknown>;

export type RetainedAgentStatus = "accepted" | "queued" | "running" | "waiting_approval" | "idle" | "failed" | "cancelled" | "retired";
export type AgentMessageStatus = "queued" | "delivered" | "completed" | "failed" | "cancelled";
export type AgentMessageKind = "objective" | "follow_up" | "message" | "result" | "system";

export interface RetainedAgentRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  ownerSessionId: string;
  parentAgentId?: string;
  admittedByRunId: string;
  name: string;
  objective: string;
  deliverable: string;
  modelRole: ModelRole;
  tokenBudget: number;
  depth: number;
  allowedTools: string[];
  status: RetainedAgentStatus;
  lastRunId?: string;
  createdAt: string;
  updatedAt: string;
  retiredAt?: string;
}

export interface AgentMessageRecord {
  seq: number;
  id: string;
  tenantId: string;
  agentId: string;
  senderAgentId?: string;
  senderRunId?: string;
  kind: AgentMessageKind;
  content: string;
  status: AgentMessageStatus;
  runId?: string;
  idempotencyKey?: string;
  createdAt: string;
  deliveredAt?: string;
  completedAt?: string;
}

export interface AgentAdmission {
  agent: RetainedAgentRecord;
  message: AgentMessageRecord;
  jobId: string;
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

function role(value: ModelRole | undefined): ModelRole {
  return value === "foreground" || value === "deliberation" || value === "critic" ? value : "background";
}

export class RetainedAgentManager {
  readonly store: SqliteStore;
  readonly maxChildrenPerRun: number;
  readonly maxQueuedChildren: number;

  constructor(store: SqliteStore, limits: { maxChildrenPerRun?: number; maxQueuedChildren?: number } = {}) {
    this.store = store;
    this.maxChildrenPerRun = Math.max(1, Math.floor(limits.maxChildrenPerRun ?? 12));
    this.maxQueuedChildren = Math.max(1, Math.floor(limits.maxQueuedChildren ?? 24));
  }

  admit(input: {
    tenantId: string;
    ownerSessionId: string;
    admittedByRunId: string;
    objective: string;
    deliverable: string;
    name?: string;
    modelRole?: ModelRole;
    tokenBudget?: number;
    depth: number;
    allowedTools: string[];
    parentAgentId?: string;
  }): AgentAdmission {
    const parentRun = this.store.getRun(input.admittedByRunId, input.tenantId);
    if (!parentRun) throw new Error(`Admitting run ${input.admittedByRunId} does not belong to tenant ${input.tenantId}`);
    if (!this.store.getSession(input.ownerSessionId, input.tenantId)) throw new Error(`Owner session ${input.ownerSessionId} does not belong to tenant ${input.tenantId}`);
    const parentAgent = input.parentAgentId ? this.get(input.tenantId, input.parentAgentId) : undefined;
    if (input.parentAgentId && !parentAgent) throw new Error(`Parent agent ${input.parentAgentId} does not belong to tenant ${input.tenantId}`);
    if (parentAgent && parentAgent.ownerSessionId !== input.ownerSessionId) throw new Error("Parent agent and child must share an owner session");

    const objective = bounded(input.objective, "objective", 20_000);
    const deliverable = bounded(input.deliverable, "deliverable", 10_000);
    const agentId = id("agt");
    const name = bounded(input.name ?? `agent-${agentId.slice(-8)}`, "name", 64);
    const current = nowIso();
    const modelRole = role(input.modelRole);
    const tokenBudget = Math.max(256, Math.min(20_000, Math.floor(input.tokenBudget ?? 4_000)));
    const allowedTools = [...new Set(input.allowedTools.filter(Boolean))].slice(0, 64);

    return this.store.transaction(() => {
      const admittedForRun = this.store.db.prepare("SELECT COUNT(*) AS count FROM retained_agents WHERE tenant_id=? AND admitted_by_run_id=?")
        .get(input.tenantId, input.admittedByRunId) as Row;
      if (Number(admittedForRun.count) >= this.maxChildrenPerRun) {
        throw new Error(`Run ${input.admittedByRunId} reached its child admission limit (${this.maxChildrenPerRun})`);
      }
      const activeForTenant = this.store.db.prepare(`SELECT COUNT(*) AS count FROM jobs
        WHERE tenant_id=? AND type='agent.turn' AND status IN ('queued','running')`).get(input.tenantId) as Row;
      if (Number(activeForTenant.count) >= this.maxQueuedChildren) {
        throw new Error(`Tenant ${input.tenantId} reached its queued child limit (${this.maxQueuedChildren})`);
      }
      const session = this.store.ensureSession(input.tenantId, "agent", agentId);
      this.store.db.prepare(`INSERT INTO retained_agents(
        id,tenant_id,session_id,owner_session_id,parent_agent_id,admitted_by_run_id,name,objective,deliverable,model_role,token_budget,depth,allowed_tools_json,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        agentId, input.tenantId, session.id, input.ownerSessionId, input.parentAgentId ?? null, input.admittedByRunId,
        name, objective, deliverable, modelRole, tokenBudget, Math.max(0, Math.floor(input.depth)), JSON.stringify(allowedTools), "accepted", current, current,
      );
      const content = `OBJECTIVE\n${objective}\n\nDELIVERABLE\n${deliverable}\n\nReturn a compact result with evidence, uncertainties, and what you actually verified.`;
      const responsibilities = new ResponsibilityManager(this.store);
      const runResponsibility = responsibilities.forEntity(input.tenantId, "run", input.admittedByRunId);
      const parentResponsibility = input.parentAgentId ? responsibilities.forEntity(input.tenantId, "agent", input.parentAgentId) : undefined;
      if (runResponsibility && parentResponsibility && runResponsibility !== parentResponsibility) throw new Error("Agent parent and admitting run have different responsibilities");
      const responsibilityId = runResponsibility ?? parentResponsibility;
      if (responsibilityId) responsibilities.bind(input.tenantId, "agent", agentId, responsibilityId);
      const message = this.insertMessage({
        tenantId: input.tenantId, agentId, ...(input.parentAgentId ? { senderAgentId: input.parentAgentId } : {}), senderRunId: input.admittedByRunId,
        kind: "objective", content, idempotencyKey: `admission:${agentId}`,
      });
      const job = this.store.enqueueJob(input.tenantId, "agent.turn", { agentId, messageId: message.id }, {
        idempotencyKey: `agent-message:${message.id}`, ...(parentRun.releaseId ? { releaseId: parentRun.releaseId } : {}),
      });
      this.store.db.prepare("UPDATE retained_agents SET status='queued',updated_at=? WHERE id=? AND tenant_id=?").run(nowIso(), agentId, input.tenantId);
      this.store.appendEvent({
        tenantId: input.tenantId, stream: `agent:${agentId}`, type: "agent.admitted", correlationId: agentId,
        causationId: input.admittedByRunId, payload: {
          agentId, name, parentAgentId: input.parentAgentId ?? null, ownerSessionId: input.ownerSessionId,
          modelRole, tokenBudget, depth: Math.max(0, Math.floor(input.depth)), allowedTools, messageId: message.id, jobId: job.id,
        },
      });
      return { agent: this.get(input.tenantId, agentId) as RetainedAgentRecord, message, jobId: job.id };
    });
  }

  send(input: {
    tenantId: string;
    senderRunId: string;
    senderSessionId: string;
    targetAgentId: string;
    content: string;
    kind?: "follow_up" | "message";
    idempotencyKey?: string;
  }): { message: AgentMessageRecord; jobId: string } {
    const target = this.requireAddressable(input.tenantId, input.targetAgentId);
    const senderRun = this.store.getRun(input.senderRunId, input.tenantId);
    if (!senderRun) throw new Error(`Sender run ${input.senderRunId} does not belong to tenant ${input.tenantId}`);
    const sender = this.getBySession(input.tenantId, input.senderSessionId);
    if (!this.canAddress(sender, input.senderSessionId, target)) throw new Error(`Agent ${target.id} is outside the sender's family or owner session`);
    const content = bounded(input.content, "content", 50_000);
    return this.store.transaction(() => {
      const responsibilities = new ResponsibilityManager(this.store);
      const responsibilityId = responsibilities.forEntity(input.tenantId, "run", input.senderRunId);
      if (responsibilityId && responsibilities.forEntity(input.tenantId, "agent", target.id) !== responsibilityId) {
        throw new Error("Agent messages cannot escape their execution responsibility");
      }
      const message = this.insertMessage({
        tenantId: input.tenantId, agentId: target.id, ...(sender ? { senderAgentId: sender.id } : {}), senderRunId: input.senderRunId,
        kind: input.kind ?? "message", content, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      });
      const job = this.store.enqueueJob(input.tenantId, "agent.turn", { agentId: target.id, messageId: message.id }, {
        idempotencyKey: `agent-message:${message.id}`, ...(senderRun.releaseId ? { releaseId: senderRun.releaseId } : {}),
      });
      this.store.db.prepare("UPDATE retained_agents SET status='queued',updated_at=? WHERE id=? AND tenant_id=? AND status NOT IN ('cancelled','retired')")
        .run(nowIso(), target.id, input.tenantId);
      this.store.appendEvent({
        tenantId: input.tenantId, stream: `agent:${target.id}`, type: "agent.message_queued", correlationId: target.id,
        causationId: input.senderRunId, payload: { agentId: target.id, messageId: message.id, senderAgentId: sender?.id ?? null, kind: message.kind, jobId: job.id },
      });
      return { message, jobId: job.id };
    });
  }

  sendFromOwner(input: {
    tenantId: string;
    targetAgentId: string;
    content: string;
    kind?: "follow_up" | "message";
    idempotencyKey?: string;
  }): { message: AgentMessageRecord; jobId: string } {
    const target = this.requireAddressable(input.tenantId, input.targetAgentId);
    const content = bounded(input.content, "content", 50_000);
    if (input.idempotencyKey) {
      const row = this.store.db.prepare("SELECT * FROM agent_messages WHERE tenant_id=? AND idempotency_key=?")
        .get(input.tenantId, input.idempotencyKey) as Row | undefined;
      if (row) {
        const message = this.messageFromRow(row);
        if (message.agentId !== target.id || message.kind !== (input.kind ?? "follow_up") || message.content !== content) {
          throw new Error(`Agent message idempotency key ${input.idempotencyKey} was reused with different content`);
        }
        const job = this.store.enqueueJob(input.tenantId, "agent.turn", { agentId: target.id, messageId: message.id }, { idempotencyKey: `agent-message:${message.id}` });
        return { message, jobId: job.id };
      }
    }
    return this.store.transaction(() => {
      const message = this.insertMessage({
        tenantId: input.tenantId, agentId: target.id, kind: input.kind ?? "follow_up", content,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      });
      const job = this.store.enqueueJob(input.tenantId, "agent.turn", { agentId: target.id, messageId: message.id }, { idempotencyKey: `agent-message:${message.id}` });
      this.store.db.prepare("UPDATE retained_agents SET status='queued',updated_at=? WHERE id=? AND tenant_id=? AND status NOT IN ('cancelled','retired')")
        .run(nowIso(), target.id, input.tenantId);
      this.store.appendEvent({
        tenantId: input.tenantId, stream: `agent:${target.id}`, type: "agent.message_queued", correlationId: target.id,
        payload: { agentId: target.id, messageId: message.id, sender: "operator", kind: message.kind, jobId: job.id },
      });
      return { message, jobId: job.id };
    });
  }

  get(tenantId: string, agentId: string): RetainedAgentRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM retained_agents WHERE tenant_id=? AND id=?").get(tenantId, agentId) as Row | undefined;
    return row ? this.agentFromRow(row) : undefined;
  }

  getBySession(tenantId: string, sessionId: string): RetainedAgentRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM retained_agents WHERE tenant_id=? AND session_id=?").get(tenantId, sessionId) as Row | undefined;
    return row ? this.agentFromRow(row) : undefined;
  }

  getByRun(tenantId: string, runId: string): RetainedAgentRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM retained_agents WHERE tenant_id=? AND last_run_id=?").get(tenantId, runId) as Row | undefined;
    return row ? this.agentFromRow(row) : undefined;
  }

  list(tenantId: string, options: { ownerSessionId?: string; status?: RetainedAgentStatus; limit?: number } = {}): RetainedAgentRecord[] {
    const clauses = ["tenant_id=?"];
    const values: Array<string | number> = [tenantId];
    if (options.ownerSessionId) { clauses.push("owner_session_id=?"); values.push(options.ownerSessionId); }
    if (options.status) { clauses.push("status=?"); values.push(options.status); }
    values.push(Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 200))));
    return (this.store.db.prepare(`SELECT * FROM retained_agents WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`).all(...values) as Row[])
      .map((row) => this.agentFromRow(row));
  }

  getMessage(tenantId: string, messageId: string): AgentMessageRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM agent_messages WHERE tenant_id=? AND id=?").get(tenantId, messageId) as Row | undefined;
    return row ? this.messageFromRow(row) : undefined;
  }

  messages(tenantId: string, agentId: string, options: { afterSeq?: number; limit?: number } = {}): AgentMessageRecord[] {
    if (!this.get(tenantId, agentId)) throw new Error(`Unknown agent ${agentId}`);
    return (this.store.db.prepare(`SELECT * FROM agent_messages WHERE tenant_id=? AND agent_id=? AND seq>? ORDER BY seq LIMIT ?`)
      .all(tenantId, agentId, Math.max(0, Math.floor(options.afterSeq ?? 0)), Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)))) as Row[])
      .map((row) => this.messageFromRow(row));
  }

  addressable(tenantId: string, senderSessionId: string, targetAgentId: string): RetainedAgentRecord {
    const target = this.get(tenantId, targetAgentId);
    if (!target) throw new Error(`Unknown agent ${targetAgentId}`);
    const sender = this.getBySession(tenantId, senderSessionId);
    if (!this.canAddress(sender, senderSessionId, target)) throw new Error(`Agent ${target.id} is outside the sender's family or owner session`);
    return target;
  }

  listAddressable(tenantId: string, senderSessionId: string, limit = 100): RetainedAgentRecord[] {
    const sender = this.getBySession(tenantId, senderSessionId);
    return this.list(tenantId, { ownerSessionId: sender?.ownerSessionId ?? senderSessionId, limit })
      .filter((candidate) => this.canAddress(sender, senderSessionId, candidate));
  }

  failMessage(tenantId: string, agentId: string, messageId: string, error: string): void {
    const current = nowIso();
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE agent_messages SET status='failed',completed_at=COALESCE(completed_at,?) WHERE tenant_id=? AND id=? AND agent_id=?")
        .run(current, tenantId, messageId, agentId);
      const agent = this.get(tenantId, agentId);
      if (agent && agent.status !== "retired" && agent.status !== "cancelled") {
        this.store.db.prepare("UPDATE retained_agents SET status='failed',updated_at=? WHERE tenant_id=? AND id=?").run(current, tenantId, agentId);
      }
      this.store.appendEvent({
        tenantId, stream: `agent:${agentId}`, type: "agent.turn_failed", correlationId: agentId, causationId: messageId,
        payload: { agentId, messageId, error: error.slice(0, 2_000) },
      });
    });
  }

  markRunning(tenantId: string, agentId: string, messageId: string): void {
    const agent = this.requireAddressable(tenantId, agentId);
    const message = this.getMessage(tenantId, messageId);
    if (!message || message.agentId !== agent.id) throw new Error(`Message ${messageId} does not belong to agent ${agentId}`);
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE agent_messages SET status='delivered',delivered_at=COALESCE(delivered_at,?) WHERE tenant_id=? AND id=? AND status='queued'")
        .run(nowIso(), tenantId, messageId);
      this.store.db.prepare("UPDATE retained_agents SET status='running',updated_at=? WHERE tenant_id=? AND id=? AND status NOT IN ('cancelled','retired')")
        .run(nowIso(), tenantId, agentId);
      this.store.appendEvent({ tenantId, stream: `agent:${agentId}`, type: "agent.turn_started", correlationId: agentId, causationId: messageId, payload: { agentId, messageId } });
    });
  }

  bindRun(tenantId: string, agentId: string, messageId: string, result: RunResult): void {
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE agent_messages SET run_id=? WHERE tenant_id=? AND id=? AND agent_id=?")
        .run(result.runId, tenantId, messageId, agentId);
      this.store.db.prepare("UPDATE retained_agents SET last_run_id=?,updated_at=? WHERE tenant_id=? AND id=?")
        .run(result.runId, nowIso(), tenantId, agentId);
      this.syncRunResult(tenantId, result);
    });
  }

  syncRunResult(tenantId: string, result: RunResult): void {
    const agent = this.getByRun(tenantId, result.runId);
    if (!agent) return;
    const current = nowIso();
    const status: RetainedAgentStatus = result.status === "waiting_approval" ? "waiting_approval"
      : result.status === "completed" ? "idle"
        : result.status === "cancelled" ? "cancelled"
          : result.status === "failed" ? "failed" : "running";
    const retainedStatus = agent.status === "retired" || agent.status === "cancelled" ? agent.status : status;
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE retained_agents SET status=?,updated_at=? WHERE tenant_id=? AND id=?")
        .run(retainedStatus, current, tenantId, agent.id);
      const source = this.store.db.prepare("SELECT id FROM agent_messages WHERE tenant_id=? AND agent_id=? AND run_id=? AND kind!='result' ORDER BY seq DESC LIMIT 1")
        .get(tenantId, agent.id, result.runId) as Row | undefined;
      if (source && result.status !== "waiting_approval" && result.status !== "running") {
        const terminal = result.status === "failed" ? "failed" : result.status === "cancelled" ? "cancelled" : "completed";
        this.store.db.prepare("UPDATE agent_messages SET status=?,completed_at=COALESCE(completed_at,?) WHERE tenant_id=? AND id=?")
          .run(terminal, current, tenantId, String(source.id));
        this.insertMessage({
          tenantId, agentId: agent.id, senderAgentId: agent.id, kind: "result", content: result.text || `Run ${result.status}`,
          idempotencyKey: `result:${result.runId}`, status: terminal === "completed" ? "completed" : "failed", runId: result.runId,
        });
      }
      const eventType = result.status === "waiting_approval" ? "agent.waiting_approval"
        : result.status === "completed" ? "agent.turn_completed"
          : result.status === "failed" ? "agent.turn_failed"
            : result.status === "cancelled" ? "agent.turn_cancelled" : "agent.turn_running";
      this.store.appendEvent({
        id: stableId("evt", `agent-run-projection:${tenantId}:${agent.id}:${result.runId}:${result.status}`),
        tenantId, stream: `agent:${agent.id}`, type: eventType, correlationId: agent.id, causationId: result.runId,
        payload: {
          agentId: agent.id, runId: result.runId, status: result.status, outputPreview: result.text.slice(0, 2_000),
          usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, reasoningTokens: result.usage.reasoningTokens },
        },
      });
    });
  }

  cancel(tenantId: string, agentId: string, causationId?: string): RetainedAgentRecord {
    const agent = this.get(tenantId, agentId);
    if (!agent) throw new Error(`Unknown agent ${agentId}`);
    if (agent.status === "retired") return agent;
    return this.store.transaction(() => {
      const current = nowIso();
      const activeRuns = this.store.db.prepare(`SELECT id FROM runs
        WHERE tenant_id=? AND session_id=? AND status IN ('running','waiting_approval')`).all(tenantId, agent.sessionId) as Row[];
      for (const row of activeRuns) {
        const runId = String(row.id);
        this.store.db.prepare(`UPDATE approvals SET status='denied',decided_at=?
          WHERE tenant_id=? AND run_id=? AND status='pending'`).run(current, tenantId, runId);
        this.store.db.prepare(`UPDATE runs SET status='cancelled',state_json=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
          WHERE tenant_id=? AND id=? AND status IN ('running','waiting_approval')`).run(current, tenantId, runId);
        this.store.appendEvent({
          tenantId,
          stream: `run:${runId}`,
          type: "run.cancelled",
          correlationId: runId,
          ...(causationId ? { causationId } : {}),
          payload: { runId, agentId, reason: "retained_agent_cancelled" },
        });
      }
      this.store.db.prepare("UPDATE retained_agents SET status='cancelled',updated_at=? WHERE tenant_id=? AND id=?").run(current, tenantId, agentId);
      this.store.db.prepare(`UPDATE agent_messages SET status='cancelled',completed_at=? WHERE tenant_id=? AND agent_id=? AND status='queued'`).run(current, tenantId, agentId);
      this.store.db.prepare(`UPDATE jobs SET status='cancelled',updated_at=? WHERE tenant_id=? AND type='agent.turn' AND status='queued' AND json_extract(payload_json,'$.agentId')=?`)
        .run(current, tenantId, agentId);
      this.store.appendEvent({ tenantId, stream: `agent:${agentId}`, type: "agent.cancelled", correlationId: agentId, ...(causationId ? { causationId } : {}), payload: { agentId } });
      return this.get(tenantId, agentId) as RetainedAgentRecord;
    });
  }

  retire(tenantId: string, agentId: string, causationId?: string): RetainedAgentRecord {
    const agent = this.get(tenantId, agentId);
    if (!agent) throw new Error(`Unknown agent ${agentId}`);
    if (agent.status === "retired") return agent;
    return this.store.transaction(() => {
      this.cancel(tenantId, agentId, causationId);
      const current = nowIso();
      this.store.db.prepare("UPDATE retained_agents SET status='retired',retired_at=?,updated_at=? WHERE tenant_id=? AND id=?")
        .run(current, current, tenantId, agentId);
      this.store.appendEvent({ tenantId, stream: `agent:${agentId}`, type: "agent.retired", correlationId: agentId, ...(causationId ? { causationId } : {}), payload: { agentId, historyRetained: true } });
      return this.get(tenantId, agentId) as RetainedAgentRecord;
    });
  }

  asJson(agent: RetainedAgentRecord): JsonObject {
    return {
      agentId: agent.id, name: agent.name, status: agent.status, objective: agent.objective, deliverable: agent.deliverable,
      ownerSessionId: agent.ownerSessionId, parentAgentId: agent.parentAgentId ?? null, admittedByRunId: agent.admittedByRunId,
      modelRole: agent.modelRole, tokenBudget: agent.tokenBudget, depth: agent.depth, allowedTools: agent.allowedTools,
      lastRunId: agent.lastRunId ?? null, createdAt: agent.createdAt, updatedAt: agent.updatedAt, retiredAt: agent.retiredAt ?? null,
    };
  }

  messageJson(message: AgentMessageRecord): JsonValue {
    return {
      seq: message.seq, messageId: message.id, agentId: message.agentId, senderAgentId: message.senderAgentId ?? null,
      senderRunId: message.senderRunId ?? null, kind: message.kind, content: message.content, status: message.status,
      runId: message.runId ?? null, createdAt: message.createdAt, deliveredAt: message.deliveredAt ?? null, completedAt: message.completedAt ?? null,
    };
  }

  private requireAddressable(tenantId: string, agentId: string): RetainedAgentRecord {
    const agent = this.get(tenantId, agentId);
    if (!agent) throw new Error(`Unknown agent ${agentId}`);
    if (agent.status === "retired" || agent.status === "cancelled") throw new Error(`Agent ${agentId} is ${agent.status}`);
    return agent;
  }

  private canAddress(sender: RetainedAgentRecord | undefined, senderSessionId: string, target: RetainedAgentRecord): boolean {
    if (!sender) return target.ownerSessionId === senderSessionId;
    if (sender.id === target.id) return true;
    if (sender.parentAgentId === target.id || target.parentAgentId === sender.id) return true;
    return Boolean(sender.parentAgentId && sender.parentAgentId === target.parentAgentId);
  }

  private insertMessage(input: {
    tenantId: string;
    agentId: string;
    senderAgentId?: string;
    senderRunId?: string;
    kind: AgentMessageKind;
    content: string;
    status?: AgentMessageStatus;
    runId?: string;
    idempotencyKey?: string;
  }): AgentMessageRecord {
    const messageId = id("amsg");
    const current = nowIso();
    this.store.db.prepare(`INSERT OR IGNORE INTO agent_messages(
      id,tenant_id,agent_id,sender_agent_id,sender_run_id,kind,content,status,run_id,idempotency_key,created_at,completed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      messageId, input.tenantId, input.agentId, input.senderAgentId ?? null, input.senderRunId ?? null, input.kind, input.content,
      input.status ?? "queued", input.runId ?? null, input.idempotencyKey ?? null, current,
      input.status === "completed" || input.status === "failed" || input.status === "cancelled" ? current : null,
    );
    const row = input.idempotencyKey
      ? this.store.db.prepare("SELECT * FROM agent_messages WHERE tenant_id=? AND idempotency_key=?").get(input.tenantId, input.idempotencyKey) as Row
      : this.store.db.prepare("SELECT * FROM agent_messages WHERE tenant_id=? AND id=?").get(input.tenantId, messageId) as Row;
    return this.messageFromRow(row);
  }

  private agentFromRow(row: Row): RetainedAgentRecord {
    const parentAgentId = optional(row.parent_agent_id);
    const lastRunId = optional(row.last_run_id);
    const retiredAt = optional(row.retired_at);
    return {
      id: String(row.id), tenantId: String(row.tenant_id), sessionId: String(row.session_id), ownerSessionId: String(row.owner_session_id),
      ...(parentAgentId ? { parentAgentId } : {}), admittedByRunId: String(row.admitted_by_run_id), name: String(row.name),
      objective: String(row.objective), deliverable: String(row.deliverable), modelRole: String(row.model_role) as ModelRole,
      tokenBudget: Number(row.token_budget), depth: Number(row.depth), allowedTools: parseStrings(row.allowed_tools_json),
      status: String(row.status) as RetainedAgentStatus, ...(lastRunId ? { lastRunId } : {}),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), ...(retiredAt ? { retiredAt } : {}),
    };
  }

  private messageFromRow(row: Row): AgentMessageRecord {
    const senderAgentId = optional(row.sender_agent_id);
    const senderRunId = optional(row.sender_run_id);
    const runId = optional(row.run_id);
    const idempotencyKey = optional(row.idempotency_key);
    const deliveredAt = optional(row.delivered_at);
    const completedAt = optional(row.completed_at);
    return {
      seq: Number(row.seq), id: String(row.id), tenantId: String(row.tenant_id), agentId: String(row.agent_id),
      ...(senderAgentId ? { senderAgentId } : {}), ...(senderRunId ? { senderRunId } : {}), kind: String(row.kind) as AgentMessageKind,
      content: String(row.content), status: String(row.status) as AgentMessageStatus, ...(runId ? { runId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}), createdAt: String(row.created_at),
      ...(deliveredAt ? { deliveredAt } : {}), ...(completedAt ? { completedAt } : {}),
    };
  }
}
