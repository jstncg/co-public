import { redactForObservability } from "./logger.ts";
import { ResponsibilityManager } from "./responsibilities.ts";
import type { RetainedAgentManager, RetainedAgentStatus } from "./agents.ts";
import type { RunRecord } from "./types.ts";
import type { SqliteStore } from "./store.ts";

interface ReceiptSummary {
  toolName: string;
  risk: string;
  status: string;
  startedAt: string;
  completedAt?: string;
}

export interface AgentSnapshotNode {
  runId: string;
  parentRunId?: string;
  kind: RunRecord["kind"];
  status: RunRecord["status"];
  modelRole: RunRecord["modelRole"];
  provider?: string;
  model?: string;
  objective: string;
  outputPreview?: string;
  iteration?: number;
  tokenBudget?: number;
  estimatedCostUsd?: number;
  usage: { inputTokens: number; outputTokens: number };
  activeTools: ReceiptSummary[];
  pendingApprovals: Array<{ id: string; toolName: string; risk: string; createdAt: string }>;
  lastEvents: Array<{ seq: number; type: string; at: string }>;
  createdAt: string;
  updatedAt: string;
  children: AgentSnapshotNode[];
}

export interface RetainedAgentSnapshot {
  responsibilityId?: string;
  agentId: string;
  name: string;
  status: RetainedAgentStatus;
  parentAgentId?: string;
  admittedByRunId: string;
  ownerSessionId: string;
  modelRole: RunRecord["modelRole"];
  objective: string;
  deliverable: string;
  tokenBudget: number;
  depth: number;
  lastRunId?: string;
  mailbox: { queued: number; total: number; lastSeq: number; lastResultPreview?: string };
  lastRun?: AgentSnapshotNode;
  createdAt: string;
  updatedAt: string;
  retiredAt?: string;
}

function preview(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  const redacted = redactForObservability(value);
  if (typeof redacted !== "string") return undefined;
  return redacted.length > maximum ? `${redacted.slice(0, maximum)}…` : redacted;
}

export class AgentMonitor {
  readonly store: SqliteStore;
  readonly agents: RetainedAgentManager;

  constructor(store: SqliteStore, agents: RetainedAgentManager) {
    this.store = store;
    this.agents = agents;
  }

  snapshot(tenantId: string, limit = 200): { generatedAt: string; retainedAgents: RetainedAgentSnapshot[]; roots: AgentSnapshotNode[]; flat: AgentSnapshotNode[] } {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const runs = this.store.listRuns(tenantId, boundedLimit);
    const nodes = new Map(runs.map((run) => [run.id, this.node(tenantId, run)]));
    const roots: AgentSnapshotNode[] = [];
    for (const run of runs) {
      const node = nodes.get(run.id) as AgentSnapshotNode;
      const parent = run.parentRunId ? nodes.get(run.parentRunId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const sort = (items: AgentSnapshotNode[]) => {
      items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      for (const item of items) sort(item.children);
    };
    sort(roots);
    const retainedAgents = this.agents.list(tenantId, { limit: boundedLimit }).map((agent) => this.retained(tenantId, agent.id) as RetainedAgentSnapshot);
    return { generatedAt: new Date().toISOString(), retainedAgents, roots, flat: [...nodes.values()].map((node) => ({ ...node, children: [] })) };
  }

  run(tenantId: string, runId: string): AgentSnapshotNode | undefined {
    const run = this.store.getRun(runId, tenantId);
    return run ? this.node(tenantId, run) : undefined;
  }

  retained(tenantId: string, agentId: string): RetainedAgentSnapshot | undefined {
    const agent = this.agents.get(tenantId, agentId);
    if (!agent) return undefined;
    const messages = this.agents.messages(tenantId, agentId, { limit: 100 });
    const lastResult = [...messages].reverse().find((message) => message.kind === "result");
    const lastResultPreview = preview(lastResult?.content, 2_000);
    const lastRun = agent.lastRunId ? this.run(tenantId, agent.lastRunId) : undefined;
    const responsibilityId = new ResponsibilityManager(this.store).forEntity(tenantId, "agent", agent.id);
    return {
      ...(responsibilityId ? { responsibilityId } : {}),
      agentId: agent.id, name: agent.name, status: agent.status,
      ...(agent.parentAgentId ? { parentAgentId: agent.parentAgentId } : {}),
      admittedByRunId: agent.admittedByRunId, ownerSessionId: agent.ownerSessionId, modelRole: agent.modelRole,
      objective: preview(agent.objective, 1_000) ?? "", deliverable: preview(agent.deliverable, 1_000) ?? "",
      tokenBudget: agent.tokenBudget, depth: agent.depth, ...(agent.lastRunId ? { lastRunId: agent.lastRunId } : {}),
      mailbox: {
        queued: messages.filter((message) => message.status === "queued").length,
        total: messages.length, lastSeq: messages.at(-1)?.seq ?? 0,
        ...(lastResultPreview ? { lastResultPreview } : {}),
      },
      ...(lastRun ? { lastRun } : {}), createdAt: agent.createdAt, updatedAt: agent.updatedAt,
      ...(agent.retiredAt ? { retiredAt: agent.retiredAt } : {}),
    };
  }

  private node(tenantId: string, run: RunRecord): AgentSnapshotNode {
    const receiptRows = this.store.db.prepare(`SELECT tool_name,risk,status,started_at,completed_at FROM tool_receipts
      WHERE tenant_id=? AND run_id=? ORDER BY started_at DESC LIMIT 20`).all(tenantId, run.id) as Array<Record<string, unknown>>;
    const activeTools = receiptRows.filter((row) => row.status === "running").map((row) => ({
      toolName: String(row.tool_name), risk: String(row.risk), status: String(row.status), startedAt: String(row.started_at),
      ...(typeof row.completed_at === "string" ? { completedAt: row.completed_at } : {}),
    }));
    const approvalRows = this.store.db.prepare(`SELECT id,tool_name,risk,created_at FROM approvals
      WHERE tenant_id=? AND run_id=? AND status='pending' ORDER BY created_at`).all(tenantId, run.id) as Array<Record<string, unknown>>;
    const eventRows = this.store.db.prepare(`SELECT seq,type,at FROM events WHERE tenant_id=? AND correlation_id=? ORDER BY seq DESC LIMIT 12`)
      .all(tenantId, run.id) as Array<Record<string, unknown>>;
    const outputPreview = preview(run.output, 2_000);
    const costRow = this.store.db.prepare(`SELECT COALESCE(SUM(CASE
      WHEN json_valid(payload_json) AND json_type(payload_json,'$.cost.estimatedUsd') IN ('integer','real')
      THEN json_extract(payload_json,'$.cost.estimatedUsd') ELSE 0 END),0) AS estimated_cost
      FROM events WHERE tenant_id=? AND correlation_id=? AND type='model.completed'`).get(tenantId, run.id) as Record<string, unknown>;
    const estimatedCostUsd = Number(Number(costRow.estimated_cost ?? 0).toFixed(6));
    return {
      runId: run.id,
      ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
      kind: run.kind,
      status: run.status,
      modelRole: run.modelRole,
      ...(run.provider ? { provider: run.provider } : {}),
      ...(run.model ? { model: run.model } : {}),
      objective: preview(run.input, 1_000) ?? "",
      ...(outputPreview ? { outputPreview } : {}),
      ...(run.state ? { iteration: run.state.iteration, tokenBudget: run.state.tokenBudget } : {}),
      ...(estimatedCostUsd > 0 ? { estimatedCostUsd } : {}),
      usage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens },
      activeTools,
      pendingApprovals: approvalRows.map((row) => ({ id: String(row.id), toolName: String(row.tool_name), risk: String(row.risk), createdAt: String(row.created_at) })),
      lastEvents: eventRows.map((row) => ({ seq: Number(row.seq), type: String(row.type), at: String(row.at) })),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      children: [],
    };
  }
}
