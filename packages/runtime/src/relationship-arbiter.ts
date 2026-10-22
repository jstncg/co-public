import { id, nowIso, stableId } from "./id.ts";
import type { SqliteStore } from "./store.ts";

type Row = Record<string, string | number | bigint | null | Uint8Array>;

export type RelationshipDeliveryClass =
  | "safety"
  | "operator_smoke"
  | "approval"
  | "requested_reply"
  | "requested_result"
  | "optional_reply"
  | "accepted_burden_repair"
  | "proactive";

export type RelationshipAttentionClass = "safety" | "operator" | "requested" | "unsolicited";
export type RelationshipAdmissionStatus = "held" | "admitted" | "accepted" | "failed" | "uncertain" | "suppressed" | "expired";

export interface RelationshipAdmissionBinding {
  tenantId: string;
  sessionId: string;
  sourceEventId: string;
  runId: string;
  deliveryKey: string;
  /** The existing transport intent ID. The arbiter never derives or rewrites it. */
  deliveryIntentId: string;
  deliveryClass: RelationshipDeliveryClass;
  urgency: number;
  contentDigest: string;
  /** Opaque reference to the domain authority that the caller revalidates. */
  authorityRef: string;
  interventionId?: string;
  notBefore?: string;
  expiresAt?: string;
}

export interface RelationshipAdmissionValidity {
  authorized: boolean;
  fresh: boolean;
  suppressed?: boolean;
  reason: string;
}

export interface RelationshipAdmissionRecord extends RelationshipAdmissionBinding {
  id: string;
  precedence: number;
  attentionClass: RelationshipAttentionClass;
  bindingDigest: string;
  status: RelationshipAdmissionStatus;
  reason: string;
  leaseExpiresAt?: string;
  admittedAt?: string;
  settledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RelationshipAdmissionDecision {
  decision: "admitted" | "held" | "suppressed" | "expired" | "terminal";
  record: RelationshipAdmissionRecord;
  /** Returned only to the process that won a new admission claim. */
  leaseToken?: string;
}

export interface RelationshipAdmissionSettlement {
  outcome: "accepted" | "failed" | "uncertain" | "retryable";
  reason: string;
  retryAt?: string;
}

const CLASS_POLICY: Record<RelationshipDeliveryClass, { precedence: number; attentionClass: RelationshipAttentionClass }> = {
  safety: { precedence: 800, attentionClass: "safety" },
  operator_smoke: { precedence: 700, attentionClass: "operator" },
  approval: { precedence: 600, attentionClass: "requested" },
  requested_reply: { precedence: 500, attentionClass: "requested" },
  requested_result: { precedence: 450, attentionClass: "requested" },
  accepted_burden_repair: { precedence: 300, attentionClass: "unsolicited" },
  optional_reply: { precedence: 200, attentionClass: "unsolicited" },
  proactive: { precedence: 100, attentionClass: "unsolicited" },
};

function required(value: string, field: string, maximum = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${field} must contain 1-${maximum} characters`);
  return normalized;
}

function timestamp(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`);
  return value;
}

function canonicalBinding(binding: RelationshipAdmissionBinding): string {
  return JSON.stringify({
    tenantId: binding.tenantId,
    sessionId: binding.sessionId,
    sourceEventId: binding.sourceEventId,
    runId: binding.runId,
    deliveryKey: binding.deliveryKey,
    deliveryIntentId: binding.deliveryIntentId,
    deliveryClass: binding.deliveryClass,
    urgency: binding.urgency,
    contentDigest: binding.contentDigest,
    authorityRef: binding.authorityRef,
    interventionId: binding.interventionId ?? null,
    notBefore: binding.notBefore ?? null,
    expiresAt: binding.expiresAt ?? null,
  });
}

function normalizedBinding(input: RelationshipAdmissionBinding): RelationshipAdmissionBinding {
  if (!Object.hasOwn(CLASS_POLICY, input.deliveryClass)) throw new Error("Unknown relationship delivery class");
  if (!Number.isFinite(input.urgency) || input.urgency < 0 || input.urgency > 1) throw new Error("Relationship admission urgency must be between zero and one");
  const notBefore = timestamp(input.notBefore, "notBefore");
  const expiresAt = timestamp(input.expiresAt, "expiresAt");
  if (notBefore && expiresAt && notBefore >= expiresAt) throw new Error("Relationship admission must become due before it expires");
  return {
    tenantId: required(input.tenantId, "tenantId", 256),
    sessionId: required(input.sessionId, "sessionId"),
    sourceEventId: required(input.sourceEventId, "sourceEventId"),
    runId: required(input.runId, "runId"),
    deliveryKey: required(input.deliveryKey, "deliveryKey"),
    deliveryIntentId: required(input.deliveryIntentId, "deliveryIntentId"),
    deliveryClass: input.deliveryClass,
    urgency: input.urgency,
    contentDigest: required(input.contentDigest, "contentDigest", 256),
    authorityRef: required(input.authorityRef, "authorityRef", 1_024),
    ...(input.interventionId ? { interventionId: required(input.interventionId, "interventionId") } : {}),
    ...(notBefore ? { notBefore } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function optional(value: Row[string] | undefined): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function finiteNumber(value: Row[string] | undefined, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Relationship admission has invalid ${field}`);
  return parsed;
}

function admissionId(binding: RelationshipAdmissionBinding): string {
  return stableId("radm", `${binding.tenantId}:${binding.sessionId}:${binding.runId}:${binding.deliveryKey}:${binding.deliveryIntentId}`);
}

export class RelationshipArbiter {
  readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  consider(bindingInput: RelationshipAdmissionBinding, validity: RelationshipAdmissionValidity,
    options: { at?: string; leaseMs?: number } = {}): RelationshipAdmissionDecision {
    const binding = normalizedBinding(bindingInput);
    const at = timestamp(options.at ?? nowIso(), "at") as string;
    const leaseMs = this.leaseMilliseconds(options.leaseMs);
    return this.store.transaction(() => {
      this.assertReferences(binding);
      this.recoverExpiredInternal(binding.tenantId, binding.sessionId, at);
      let record = this.createOrGet(binding, at);
      if (["accepted", "failed", "uncertain", "suppressed", "expired"].includes(record.status)) {
        return { decision: "terminal", record };
      }
      if (record.expiresAt && record.expiresAt <= at) {
        if (record.status === "admitted" && this.outboundState(record.deliveryIntentId)) return { decision: "held", record };
        record = this.transition(record, "expired", "candidate expired before relationship admission", at);
        return { decision: "expired", record };
      }
      if (!validity.authorized || validity.suppressed) {
        if (record.status === "admitted" && this.outboundState(record.deliveryIntentId)) return { decision: "held", record };
        record = this.transition(record, "suppressed", validity.reason, at);
        return { decision: "suppressed", record };
      }
      if (!validity.fresh) {
        if (record.status === "admitted" && this.outboundState(record.deliveryIntentId)) return { decision: "held", record };
        record = this.transition(record, "expired", validity.reason, at);
        return { decision: "expired", record };
      }
      if (record.notBefore && record.notBefore > at) {
        record = this.hold(record, `waiting until ${record.notBefore}`, at);
        return { decision: "held", record };
      }
      if (record.status === "admitted") return { decision: "held", record };

      const active = this.active(binding.tenantId, binding.sessionId);
      if (active && active.id !== record.id) {
        const transportStarted = this.outboundState(active.deliveryIntentId);
        if (record.precedence <= active.precedence || transportStarted) {
          record = this.transition(record, "held", `relationship occupied by ${active.deliveryClass} admission ${active.id}`, at,
            active.leaseExpiresAt ? new Date(Date.parse(active.leaseExpiresAt) + 250).toISOString() : new Date(Date.parse(at) + leaseMs).toISOString());
          return { decision: "held", record };
        }
        this.hold(active, `preempted before transport by higher-precedence ${record.deliveryClass} admission ${record.id}`, at);
      }
      const leaseToken = id("relationship_lease");
      const leaseExpiresAt = new Date(Date.parse(at) + leaseMs).toISOString();
      record = this.admit(record, leaseToken, leaseExpiresAt, at);
      return { decision: "admitted", record, leaseToken };
    });
  }

  claimNext(input: { tenantId: string; sessionId: string; validate: (record: RelationshipAdmissionRecord) => RelationshipAdmissionValidity;
    at?: string; leaseMs?: number }): RelationshipAdmissionDecision | undefined {
    const tenantId = required(input.tenantId, "tenantId", 256);
    const sessionId = required(input.sessionId, "sessionId");
    const at = timestamp(input.at ?? nowIso(), "at") as string;
    const leaseMs = this.leaseMilliseconds(input.leaseMs);
    return this.store.transaction(() => {
      this.recoverExpiredInternal(tenantId, sessionId, at);
      const active = this.active(tenantId, sessionId);
      if (active) return { decision: "held", record: active };
      const rows = this.store.db.prepare(`SELECT * FROM relationship_admissions
        WHERE tenant_id=? AND session_id=? AND status='held'
          AND (not_before IS NULL OR not_before<=?) AND (expires_at IS NULL OR expires_at>?)
        ORDER BY precedence DESC,urgency DESC,created_at,id LIMIT 100`).all(tenantId, sessionId, at, at) as Row[];
      for (const row of rows) {
        let record = this.fromRow(row);
        const validity = input.validate(record);
        if (!validity.authorized || validity.suppressed) {
          this.transition(record, "suppressed", validity.reason, at);
          continue;
        }
        if (!validity.fresh) {
          this.transition(record, "expired", validity.reason, at);
          continue;
        }
        const leaseToken = id("relationship_lease");
        const leaseExpiresAt = new Date(Date.parse(at) + leaseMs).toISOString();
        record = this.admit(record, leaseToken, leaseExpiresAt, at);
        return { decision: "admitted", record, leaseToken };
      }
      this.expireDueInternal(tenantId, sessionId, at);
      return undefined;
    });
  }

  assertAdmitted(input: { tenantId: string; admissionId: string; leaseToken: string; binding: RelationshipAdmissionBinding; at?: string }): RelationshipAdmissionRecord {
    const binding = normalizedBinding(input.binding);
    const at = timestamp(input.at ?? nowIso(), "at") as string;
    const expectedDigest = stableId("relationship_binding", canonicalBinding(binding));
    const row = this.store.db.prepare(`SELECT * FROM relationship_admissions WHERE tenant_id=? AND id=?
      AND status='admitted' AND lease_token=? AND lease_expires_at>?`).get(
      required(input.tenantId, "tenantId", 256), required(input.admissionId, "admissionId"), required(input.leaseToken, "leaseToken"), at,
    ) as Row | undefined;
    if (!row) throw new Error("Relationship admission is missing, expired, settled, or fenced by another owner");
    const record = this.fromRow(row);
    if (record.bindingDigest !== expectedDigest || record.id !== admissionId(binding)) {
      throw new Error("Relationship admission immutable binding does not match the dispatch");
    }
    return record;
  }

  heartbeat(tenantId: string, admissionIdInput: string, leaseToken: string, leaseMs = 30_000, at = nowIso()): boolean {
    const current = timestamp(at, "at") as string;
    const expiresAt = new Date(Date.parse(current) + this.leaseMilliseconds(leaseMs)).toISOString();
    const changed = this.store.db.prepare(`UPDATE relationship_admissions SET lease_expires_at=?,updated_at=?
      WHERE tenant_id=? AND id=? AND status='admitted' AND lease_token=? AND lease_expires_at>?`).run(
      expiresAt, current, required(tenantId, "tenantId", 256), required(admissionIdInput, "admissionId"), required(leaseToken, "leaseToken"), current,
    );
    return changed.changes === 1;
  }

  settle(input: { tenantId: string; admissionId: string; leaseToken: string; settlement: RelationshipAdmissionSettlement; at?: string }): RelationshipAdmissionRecord {
    const at = timestamp(input.at ?? nowIso(), "at") as string;
    return this.store.transaction(() => {
      const row = this.store.db.prepare(`SELECT * FROM relationship_admissions WHERE tenant_id=? AND id=?
        AND status='admitted' AND lease_token=? AND lease_expires_at>?`).get(
        required(input.tenantId, "tenantId", 256), required(input.admissionId, "admissionId"), required(input.leaseToken, "leaseToken"), at,
      ) as Row | undefined;
      if (!row) throw new Error("Relationship admission settlement was rejected as stale");
      const record = this.fromRow(row);
      const transport = this.outboundProjection(record.tenantId, record.deliveryIntentId);
      if (input.settlement.outcome === "accepted" && !this.acceptanceProven(record, transport)) {
        throw new Error("Accepted relationship settlement requires an exact outbound acceptance event");
      }
      if (input.settlement.outcome === "failed" && transport?.state !== "failed") throw new Error("Failed relationship settlement requires a failed outbound delivery");
      if (input.settlement.outcome === "uncertain" && transport?.state !== "uncertain") throw new Error("Uncertain relationship settlement requires an uncertain outbound delivery");
      if (input.settlement.outcome === "retryable") {
        if (transport?.state !== "retryable" && transport?.state !== "not_started") throw new Error("Retryable relationship settlement requires a retryable outbound delivery");
        const retryAt = timestamp(input.settlement.retryAt, "retryAt");
        if (!retryAt || retryAt <= at) throw new Error("Retryable relationship settlement requires a future retryAt");
        if (record.expiresAt && retryAt >= record.expiresAt) return this.transition(record, "expired", input.settlement.reason, at);
        return this.transition(record, "held", input.settlement.reason, at, retryAt);
      }
      return this.transition(record, input.settlement.outcome, input.settlement.reason, at);
    });
  }

  recoverExpired(tenantId: string, sessionId: string, at = nowIso()): RelationshipAdmissionRecord[] {
    const current = timestamp(at, "at") as string;
    return this.store.transaction(() => this.recoverExpiredInternal(
      required(tenantId, "tenantId", 256), required(sessionId, "sessionId"), current,
    ));
  }

  expireDue(tenantId: string, sessionId: string, at = nowIso()): number {
    const current = timestamp(at, "at") as string;
    return this.store.transaction(() => this.expireDueInternal(
      required(tenantId, "tenantId", 256), required(sessionId, "sessionId"), current,
    ));
  }

  invalidateBeforeTransport(input: { tenantId: string; admissionId: string; disposition: "suppressed" | "expired"; reason: string; at?: string }): RelationshipAdmissionRecord {
    const at = timestamp(input.at ?? nowIso(), "at") as string;
    return this.store.transaction(() => {
      const record = this.get(required(input.tenantId, "tenantId", 256), required(input.admissionId, "admissionId"));
      if (!record) throw new Error("Unknown relationship admission");
      if (["accepted", "failed", "uncertain", "suppressed", "expired"].includes(record.status)) return record;
      if (this.outboundState(record.deliveryIntentId)) {
        throw new Error("Relationship admission cannot be invalidated after its outbound transport was claimed");
      }
      return this.transition(record, input.disposition, input.reason, at);
    });
  }

  get(tenantId: string, admissionIdInput: string): RelationshipAdmissionRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM relationship_admissions WHERE tenant_id=? AND id=?")
      .get(tenantId, admissionIdInput) as Row | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  list(tenantId: string, sessionId: string, limit = 100): RelationshipAdmissionRecord[] {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    return (this.store.db.prepare(`SELECT * FROM relationship_admissions WHERE tenant_id=? AND session_id=?
      ORDER BY created_at,id LIMIT ?`).all(tenantId, sessionId, boundedLimit) as Row[]).map((row) => this.fromRow(row));
  }

  private createOrGet(binding: RelationshipAdmissionBinding, at: string): RelationshipAdmissionRecord {
    const recordId = admissionId(binding);
    const policy = CLASS_POLICY[binding.deliveryClass];
    const bindingDigest = stableId("relationship_binding", canonicalBinding(binding));
    const inserted = this.store.db.prepare(`INSERT OR IGNORE INTO relationship_admissions(
      id,tenant_id,session_id,source_event_id,run_id,delivery_key,delivery_intent_id,delivery_class,precedence,attention_class,
      urgency,content_digest,authority_ref,binding_digest,intervention_id,status,reason,not_before,expires_at,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      recordId, binding.tenantId, binding.sessionId, binding.sourceEventId, binding.runId, binding.deliveryKey,
      binding.deliveryIntentId, binding.deliveryClass, policy.precedence, policy.attentionClass, binding.urgency,
      binding.contentDigest, binding.authorityRef, bindingDigest, binding.interventionId ?? null, "held", "candidate registered",
      binding.notBefore ?? null, binding.expiresAt ?? null, at, at,
    );
    const row = this.store.db.prepare("SELECT * FROM relationship_admissions WHERE tenant_id=? AND id=?")
      .get(binding.tenantId, recordId) as Row | undefined;
    if (!row) throw new Error("Relationship admission disappeared during creation");
    const record = this.fromRow(row);
    if (record.bindingDigest !== bindingDigest) throw new Error("Relationship admission idempotency key was rebound to different content or routing, or authority");
    if (inserted.changes) this.store.appendEvent({
      id: stableId("evt", `relationship-admission-created:${binding.tenantId}:${recordId}`),
      tenantId: binding.tenantId, stream: `relationship:${binding.sessionId}`, type: "relationship.admission_created",
      causationId: binding.sourceEventId,
      payload: { admissionId: recordId, sessionId: binding.sessionId, deliveryClass: binding.deliveryClass, attentionClass: policy.attentionClass,
        deliveryIntentId: binding.deliveryIntentId, contentDigest: binding.contentDigest, authorityRef: binding.authorityRef },
    });
    return record;
  }

  private assertReferences(binding: RelationshipAdmissionBinding): void {
    const session = this.store.getSession(binding.sessionId, binding.tenantId);
    if (!session) throw new Error("Relationship admission session does not belong to the tenant");
    if (!this.store.getEvent(binding.tenantId, binding.sourceEventId)) throw new Error("Relationship admission source event does not belong to the tenant");
    const delivery = this.store.db.prepare("SELECT tenant_id FROM outbound_deliveries WHERE intent_id=?")
      .get(binding.deliveryIntentId) as { tenant_id: string } | undefined;
    if (delivery && delivery.tenant_id !== binding.tenantId) throw new Error("Relationship admission delivery intent belongs to another tenant");
    if (binding.interventionId) {
      const intervention = this.store.db.prepare("SELECT tenant_id FROM interventions WHERE id=?").get(binding.interventionId) as { tenant_id: string } | undefined;
      if (!intervention || intervention.tenant_id !== binding.tenantId) throw new Error("Relationship admission intervention does not belong to the tenant");
    }
  }

  private active(tenantId: string, sessionId: string): RelationshipAdmissionRecord | undefined {
    const row = this.store.db.prepare(`SELECT * FROM relationship_admissions
      WHERE tenant_id=? AND session_id=? AND status='admitted' LIMIT 1`).get(tenantId, sessionId) as Row | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  private admit(record: RelationshipAdmissionRecord, leaseToken: string, leaseExpiresAt: string, at: string): RelationshipAdmissionRecord {
    const changed = this.store.db.prepare(`UPDATE relationship_admissions SET status='admitted',reason='admitted by relationship arbiter',
      lease_token=?,lease_expires_at=?,admitted_at=COALESCE(admitted_at,?),settled_at=NULL,updated_at=?
      WHERE tenant_id=? AND id=? AND status='held'`).run(leaseToken, leaseExpiresAt, at, at, record.tenantId, record.id);
    if (changed.changes !== 1) throw new Error("Relationship admission changed before it could be claimed");
    this.store.appendEvent({
      id: stableId("evt", `relationship-admitted:${record.tenantId}:${record.id}:${leaseToken}`), tenantId: record.tenantId,
      stream: `relationship:${record.sessionId}`, type: "relationship.admission_admitted", causationId: record.sourceEventId,
      payload: { admissionId: record.id, deliveryClass: record.deliveryClass, deliveryIntentId: record.deliveryIntentId, leaseExpiresAt },
    });
    return this.get(record.tenantId, record.id) as RelationshipAdmissionRecord;
  }

  private hold(record: RelationshipAdmissionRecord, reason: string, at: string): RelationshipAdmissionRecord {
    return this.transition(record, "held", reason, at, record.notBefore);
  }

  private transition(record: RelationshipAdmissionRecord, status: RelationshipAdmissionStatus, reasonInput: string, at: string,
    notBefore = record.notBefore): RelationshipAdmissionRecord {
    const reason = required(reasonInput, "relationship admission reason", 2_000);
    const settledAt = ["accepted", "failed", "uncertain", "suppressed", "expired"].includes(status) ? at : null;
    const changed = this.store.db.prepare(`UPDATE relationship_admissions SET status=?,reason=?,not_before=?,lease_token=NULL,
      lease_expires_at=NULL,settled_at=?,updated_at=? WHERE tenant_id=? AND id=?`).run(
      status, reason, notBefore ?? null, settledAt, at, record.tenantId, record.id,
    );
    if (changed.changes !== 1) throw new Error("Relationship admission disappeared during transition");
    this.store.appendEvent({
      tenantId: record.tenantId, stream: `relationship:${record.sessionId}`, type: `relationship.admission_${status}`,
      causationId: record.sourceEventId,
      payload: { admissionId: record.id, deliveryClass: record.deliveryClass, deliveryIntentId: record.deliveryIntentId, reason,
        notBefore: notBefore ?? null },
    });
    return this.get(record.tenantId, record.id) as RelationshipAdmissionRecord;
  }

  private recoverExpiredInternal(tenantId: string, sessionId: string, at: string): RelationshipAdmissionRecord[] {
    const rows = this.store.db.prepare(`SELECT * FROM relationship_admissions WHERE tenant_id=? AND session_id=?
      AND status='admitted' AND lease_expires_at<=?`).all(tenantId, sessionId, at) as Row[];
    const recovered: RelationshipAdmissionRecord[] = [];
    for (const row of rows) {
      const record = this.fromRow(row);
      const outbound = this.outboundProjection(tenantId, record.deliveryIntentId);
      if (outbound?.state === "running" && outbound.leaseExpiresAt && outbound.leaseExpiresAt > at) {
        this.store.db.prepare("UPDATE relationship_admissions SET lease_expires_at=?,updated_at=? WHERE tenant_id=? AND id=? AND status='admitted'")
          .run(outbound.leaseExpiresAt, at, tenantId, record.id);
        recovered.push(this.get(tenantId, record.id) as RelationshipAdmissionRecord);
        continue;
      }
      const target: RelationshipAdmissionStatus = outbound?.state === "accepted" && this.acceptanceProven(record, outbound) ? "accepted"
        : outbound?.state === "failed" ? "failed"
          : outbound?.state === "uncertain" || outbound?.state === "accepted" ? "uncertain"
            : record.expiresAt && record.expiresAt <= at ? "expired" : "held";
      const reason = target === "held" ? "expired admission recovered before a provider effect became ambiguous"
        : target === "expired" ? "candidate expired while its unused admission lease was stale"
          : `expired admission recovered from outbound delivery state ${outbound?.state ?? "missing"}`;
      recovered.push(this.transition(record, target, reason, at, target === "held" ? at : record.notBefore));
    }
    this.expireDueInternal(tenantId, sessionId, at);
    return recovered;
  }

  private expireDueInternal(tenantId: string, sessionId: string, at: string): number {
    const rows = this.store.db.prepare(`SELECT * FROM relationship_admissions WHERE tenant_id=? AND session_id=?
      AND status='held' AND expires_at IS NOT NULL AND expires_at<=?`).all(tenantId, sessionId, at) as Row[];
    for (const row of rows) this.transition(this.fromRow(row), "expired", "held relationship candidate expired", at);
    return rows.length;
  }

  private outboundState(deliveryIntentId: string): string | undefined {
    const row = this.store.db.prepare("SELECT state FROM outbound_deliveries WHERE intent_id=?").get(deliveryIntentId) as { state: string } | undefined;
    return row?.state;
  }

  private outboundProjection(tenantId: string, deliveryIntentId: string): {
    state: string;
    leaseExpiresAt?: string;
    acceptanceEventId?: string;
  } | undefined {
    const row = this.store.db.prepare(`SELECT state,lease_expires_at,acceptance_event_id FROM outbound_deliveries
      WHERE tenant_id=? AND intent_id=?`).get(tenantId, deliveryIntentId) as Row | undefined;
    if (!row) return undefined;
    return {
      state: String(row.state),
      ...(optional(row.lease_expires_at) ? { leaseExpiresAt: optional(row.lease_expires_at) as string } : {}),
      ...(optional(row.acceptance_event_id) ? { acceptanceEventId: optional(row.acceptance_event_id) as string } : {}),
    };
  }

  private acceptanceProven(record: RelationshipAdmissionRecord, transport: { state: string; acceptanceEventId?: string } | undefined): boolean {
    if (transport?.state !== "accepted" || !transport.acceptanceEventId) return false;
    const event = this.store.getEvent(record.tenantId, transport.acceptanceEventId);
    return Boolean(event && ["message.delivery_accepted", "message.reaction_accepted", "message.delivered"].includes(event.type)
      && event.causationId === record.deliveryIntentId);
  }

  private leaseMilliseconds(value = 30_000): number {
    if (!Number.isSafeInteger(value) || value < 1_000 || value > 5 * 60_000) throw new Error("Relationship admission lease must be between 1 and 300 seconds");
    return value;
  }

  private fromRow(row: Row): RelationshipAdmissionRecord {
    const deliveryClass = String(row.delivery_class) as RelationshipDeliveryClass;
    const attentionClass = String(row.attention_class) as RelationshipAttentionClass;
    const status = String(row.status) as RelationshipAdmissionStatus;
    if (!Object.hasOwn(CLASS_POLICY, deliveryClass) || !["safety", "operator", "requested", "unsolicited"].includes(attentionClass)
      || !["held", "admitted", "accepted", "failed", "uncertain", "suppressed", "expired"].includes(status)) {
      throw new Error("Relationship admission has corrupt enum state");
    }
    const urgency = finiteNumber(row.urgency, "urgency");
    const precedence = finiteNumber(row.precedence, "precedence");
    const policy = CLASS_POLICY[deliveryClass];
    if (urgency < 0 || urgency > 1 || precedence !== policy.precedence || attentionClass !== policy.attentionClass) {
      throw new Error("Relationship admission policy projection is corrupt");
    }
    return {
      id: String(row.id), tenantId: String(row.tenant_id), sessionId: String(row.session_id), sourceEventId: String(row.source_event_id),
      runId: String(row.run_id), deliveryKey: String(row.delivery_key), deliveryIntentId: String(row.delivery_intent_id), deliveryClass,
      precedence, attentionClass, urgency, contentDigest: String(row.content_digest), authorityRef: String(row.authority_ref),
      bindingDigest: String(row.binding_digest), status, reason: String(row.reason), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      ...(optional(row.intervention_id) ? { interventionId: optional(row.intervention_id) as string } : {}),
      ...(optional(row.not_before) ? { notBefore: optional(row.not_before) as string } : {}),
      ...(optional(row.expires_at) ? { expiresAt: optional(row.expires_at) as string } : {}),
      ...(optional(row.lease_expires_at) ? { leaseExpiresAt: optional(row.lease_expires_at) as string } : {}),
      ...(optional(row.admitted_at) ? { admittedAt: optional(row.admitted_at) as string } : {}),
      ...(optional(row.settled_at) ? { settledAt: optional(row.settled_at) as string } : {}),
    };
  }
}
