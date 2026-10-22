import { AsyncLocalStorage } from "node:async_hooks";
import { id, nowIso } from "./id.ts";
import type { SqliteStore } from "./store.ts";
import type { JsonObject, ProviderRequest, ProviderResponse } from "./types.ts";

type EntityKind = "run" | "work_order" | "agent";
const tables: Record<EntityKind, string> = { run: "runs", work_order: "work_orders", agent: "retained_agents" };
type Row = Record<string, unknown>;

function positive(value: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid responsibility ${field}`);
  return value;
}

/** An operational envelope, not a new goal or permission to act. Members may
 * deposit indefinitely without creating one. Existing action policy still owns
 * authorization; this layer can only reduce execution. */
export class ResponsibilityManager {
  readonly store: SqliteStore;
  private readonly context = new AsyncLocalStorage<{ tenantId: string; runId: string }>();

  constructor(store: SqliteStore) { this.store = store; }

  create(input: { tenantId: string; sourceEventId: string; ownerSessionId: string; objective: string;
    tokenLimit: number; modelCallLimit: number; toolCallLimit: number; deadlineAt: string; idempotencyKey: string }): string {
    const tokens = positive(input.tokenLimit, 1_000_000_000, "token limit");
    const models = positive(input.modelCallLimit, 10_000, "model call limit");
    const tools = positive(input.toolCallLimit, 100_000, "tool call limit");
    const deadline = new Date(input.deadlineAt).toISOString();
    if (deadline <= nowIso() || !input.objective.trim() || input.objective.length > 20_000
      || !input.idempotencyKey.trim() || input.idempotencyKey.length > 256) throw new Error("Invalid responsibility objective, deadline, or key");
    return this.store.transaction(() => {
      if (!this.store.getEvent(input.tenantId, input.sourceEventId) || !this.store.getSession(input.ownerSessionId, input.tenantId)) {
        throw new Error("Responsibility source and owner session must belong to its tenant");
      }
      const existing = this.store.db.prepare("SELECT * FROM responsibilities WHERE tenant_id=? AND idempotency_key=?")
        .get(input.tenantId, input.idempotencyKey) as Row | undefined;
      if (existing) {
        if (existing.source_event_id !== input.sourceEventId || existing.owner_session_id !== input.ownerSessionId
          || existing.objective !== input.objective.trim() || existing.token_limit !== tokens || existing.model_call_limit !== models
          || existing.tool_call_limit !== tools || existing.deadline_at !== deadline) throw new Error("Responsibility idempotency key was rebound");
        return String(existing.id);
      }
      const responsibilityId = id("rsp");
      this.store.db.prepare(`INSERT INTO responsibilities(id,tenant_id,source_event_id,owner_session_id,objective,status,
        token_limit,model_call_limit,tool_call_limit,deadline_at,idempotency_key,created_at,updated_at)
        VALUES(?,?,?,?,?,'active',?,?,?,?,?,?,?)`).run(responsibilityId, input.tenantId, input.sourceEventId,
        input.ownerSessionId, input.objective.trim(), tokens, models, tools, deadline, input.idempotencyKey, nowIso(), nowIso());
      this.store.appendEvent({ tenantId: input.tenantId, stream: `responsibility:${responsibilityId}`, type: "responsibility.created",
        causationId: input.sourceEventId, payload: { responsibilityId, tokenLimit: tokens, modelCallLimit: models, toolCallLimit: tools, deadlineAt: deadline } });
      return responsibilityId;
    });
  }

  forEntity(tenantId: string, kind: EntityKind, entityId: string): string | undefined {
    const row = this.store.db.prepare("SELECT responsibility_id FROM responsibility_bindings WHERE tenant_id=? AND entity_kind=? AND entity_id=?")
      .get(tenantId, kind, entityId) as Row | undefined;
    return row ? String(row.responsibility_id) : undefined;
  }

  bind(tenantId: string, kind: EntityKind, entityId: string, responsibilityId: string): void {
    this.store.transaction(() => {
      this.assertActive(tenantId, responsibilityId);
      if (!Object.hasOwn(tables, kind) || !this.store.db.prepare(`SELECT 1 FROM ${tables[kind]} WHERE tenant_id=? AND id=?`).get(tenantId, entityId)) {
        throw new Error("Responsibility binding must name a tenant-owned execution unit");
      }
      const previous = this.forEntity(tenantId, kind, entityId);
      if (previous && previous !== responsibilityId) throw new Error("Execution responsibility cannot be rebound");
      this.store.db.prepare(`INSERT OR IGNORE INTO responsibility_bindings(tenant_id,entity_kind,entity_id,responsibility_id)
        VALUES(?,?,?,?)`).run(tenantId, kind, entityId, responsibilityId);
    });
  }

  assertActive(tenantId: string, responsibilityId: string): Row {
    const row = this.store.db.prepare("SELECT * FROM responsibilities WHERE tenant_id=? AND id=?").get(tenantId, responsibilityId) as Row | undefined;
    if (!row) throw new Error("Execution responsibility is missing");
    if (row.status !== "active") throw new Error(`Execution responsibility is ${String(row.status)}`);
    const deadline = Date.parse(String(row.deadline_at));
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("Execution responsibility expired");
    positive(Number(row.token_limit), 1_000_000_000, "stored token limit");
    positive(Number(row.model_call_limit), 10_000, "stored model call limit");
    positive(Number(row.tool_call_limit), 100_000, "stored tool call limit");
    return row;
  }

  cancel(tenantId: string, responsibilityId: string): void {
    this.store.transaction(() => {
      const result = this.store.db.prepare("UPDATE responsibilities SET status='cancelled',updated_at=? WHERE tenant_id=? AND id=? AND status IN ('active','blocked')")
        .run(nowIso(), tenantId, responsibilityId);
      if (result.changes) this.store.appendEvent({ tenantId, stream: `responsibility:${responsibilityId}`, type: "responsibility.cancelled",
        payload: { responsibilityId, historyRetained: true } });
    });
  }

  withRun<T>(tenantId: string, runId: string, operation: () => T): T { return this.context.run({ tenantId, runId }, operation); }

  private reserve(tenantId: string, runId: string, kind: "model" | "tool", tokens: number): { id: string; responsibilityId: string } | undefined {
    const responsibilityId = this.forEntity(tenantId, "run", runId);
    if (!responsibilityId) return undefined;
    return this.store.transaction(() => {
      const owner = this.assertActive(tenantId, responsibilityId);
      const usage = this.usage(tenantId, responsibilityId);
      if (usage.chargedTokens + tokens > Number(owner.token_limit)
        || (kind === "model" ? usage.modelCalls >= Number(owner.model_call_limit) : usage.toolCalls >= Number(owner.tool_call_limit))) {
        throw new Error("Shared responsibility budget exhausted before execution");
      }
      const reservationId = id("rsv");
      this.store.db.prepare(`INSERT INTO responsibility_reservations(id,tenant_id,responsibility_id,run_id,kind,charged_tokens,state,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(reservationId, tenantId, responsibilityId, runId, kind, tokens, kind === "tool" ? "settled" : "reserved", nowIso());
      return { id: reservationId, responsibilityId };
    });
  }

  beforeTool(tenantId: string, runId: string, toolName: string): void {
    // These admissions do not yet carry the responsibility into their detached
    // worker paths. Refuse them in an owned run rather than silently escaping
    // its budget. Work orders and retained-agent messages are already bound.
    if (this.forEntity(tenantId, "run", runId) && ["schedule.create", "scout.create", "research.commission",
      "consequence.work.submit", "content.ingest_url", "promise.accept", "goal.create", "goal.check"].includes(toolName)) {
      throw new Error(`${toolName} has no responsibility propagation contract yet`);
    }
    this.reserve(tenantId, runId, "tool", 0);
  }

  async complete(request: ProviderRequest, next: () => Promise<ProviderResponse>): Promise<ProviderResponse> {
    const context = this.context.getStore();
    if (!context) return next();
    if (context.tenantId !== request.tenantId) throw new Error("Provider request crossed responsibility tenant context");
    if (this.forEntity(request.tenantId, "run", context.runId)
      && request.messages.some((message) => message.parts.some((part) => part.type === "image"))) {
      throw new Error("Budgeted image work requires a model-specific visual-token reservation; text-byte accounting is insufficient");
    }
    // Conservative byte-based input allowance plus output cap; this is token
    // accounting, not invented dollar pricing for subscription CLI providers.
    const bound = Buffer.byteLength(JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools }), "utf8")
      + 4_096 + positive(request.route.maxOutputTokens, 1_000_000, "provider output cap");
    const reservation = this.reserve(request.tenantId, context.runId, "model", bound);
    if (!reservation) return next();
    try {
      const response = await next();
      const usage = response.usage;
      if (![usage.inputTokens, usage.outputTokens, usage.reasoningTokens].every((n) => Number.isSafeInteger(n) && n >= 0)
        || usage.inputTokens + usage.outputTokens === 0) throw new Error("Provider usage is missing or invalid; reservation retained");
      const actual = usage.inputTokens + usage.outputTokens;
      if (actual > bound) {
        this.store.db.prepare("UPDATE responsibilities SET status='blocked',updated_at=? WHERE tenant_id=? AND id=? AND status='active'")
          .run(nowIso(), request.tenantId, reservation.responsibilityId);
        this.store.db.prepare("UPDATE responsibility_reservations SET charged_tokens=? WHERE tenant_id=? AND id=? AND state='reserved'")
          .run(actual, request.tenantId, reservation.id);
        throw new Error("Provider exceeded its reserved token envelope; further work must stop");
      }
      this.store.db.prepare("UPDATE responsibility_reservations SET charged_tokens=?,state='settled' WHERE tenant_id=? AND id=? AND state='reserved'")
        .run(actual, request.tenantId, reservation.id);
      this.assertActive(request.tenantId, reservation.responsibilityId);
      return response;
    } catch (error) {
      // An error or crash is not evidence of zero usage. Never refund it on a
      // timer or retry; a still-reserved row also continues consuming capacity.
      this.store.db.prepare("UPDATE responsibility_reservations SET state='uncertain' WHERE tenant_id=? AND id=? AND state='reserved'")
        .run(request.tenantId, reservation.id);
      throw error;
    }
  }

  usage(tenantId: string, responsibilityId: string): { chargedTokens: number; modelCalls: number; toolCalls: number } {
    if (this.store.db.prepare(`SELECT 1 FROM responsibility_reservations WHERE tenant_id=? AND responsibility_id=?
      AND (typeof(charged_tokens)!='integer' OR charged_tokens<0 OR kind NOT IN ('model','tool')
        OR state NOT IN ('reserved','settled','uncertain')) LIMIT 1`).get(tenantId, responsibilityId)) {
      throw new Error("Responsibility accounting is malformed; refusing further execution");
    }
    const row = this.store.db.prepare(`SELECT COALESCE(SUM(charged_tokens),0) AS tokens,
      COALESCE(SUM(kind='model'),0) AS models,COALESCE(SUM(kind='tool'),0) AS tools
      FROM responsibility_reservations WHERE tenant_id=? AND responsibility_id=?`).get(tenantId, responsibilityId) as Row;
    if (![row.tokens, row.models, row.tools].every((value) => Number.isSafeInteger(value) && Number(value) >= 0)) {
      throw new Error("Responsibility accounting totals are invalid");
    }
    return { chargedTokens: Number(row.tokens), modelCalls: Number(row.models), toolCalls: Number(row.tools) };
  }

  view(tenantId: string, responsibilityId: string): JsonObject | undefined {
    const row = this.store.db.prepare("SELECT * FROM responsibilities WHERE tenant_id=? AND id=?").get(tenantId, responsibilityId) as Row | undefined;
    if (!row) return undefined;
    const bindings = this.store.db.prepare(`SELECT entity_kind,entity_id FROM responsibility_bindings
      WHERE tenant_id=? AND responsibility_id=? ORDER BY entity_kind,entity_id LIMIT 201`).all(tenantId, responsibilityId);
    return { id: String(row.id), tenantId, sourceEventId: String(row.source_event_id), ownerSessionId: String(row.owner_session_id),
      objective: String(row.objective), status: String(row.status), tokenLimit: Number(row.token_limit), modelCallLimit: Number(row.model_call_limit),
      toolCallLimit: Number(row.tool_call_limit), deadlineAt: String(row.deadline_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      usage: this.usage(tenantId, responsibilityId),
      bindingsTruncated: bindings.length > 200,
      bindings: bindings.slice(0, 200).map((binding) => ({ kind: String(binding.entity_kind), id: String(binding.entity_id) })) };
  }
}
