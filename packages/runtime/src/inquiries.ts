import { nowIso, stableId } from "./id.ts";
import type { SqliteStore } from "./store.ts";

type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, SqlValue>;

export type InquiryAnswerability = "records" | "public" | "member" | "unavailable";
export type InquiryStatus = "proposed" | "investigating" | "resolved" | "insufficient" | "needs_member" | "expired" | "retired";
export type InquiryForegroundDisposition = "backstage" | "natural_opening" | "interrupt" | "suppressed" | "expired";

export interface InquiryRecord {
  id: string;
  tenantId: string;
  sourceEventId: string;
  sessionId?: string;
  triggerKind: string;
  triggerBasis: string;
  question: string;
  concreteBenefit: string;
  answerability: InquiryAnswerability;
  status: InquiryStatus;
  competingHypotheses: string[];
  falsifiers: string[];
  retrievalPlan: string[];
  maxSteps: number;
  stopCondition: string;
  expiresAt: string;
  finding?: string;
  counterevidence?: string;
  remainingUncertainty?: string;
  nextPermittedConsequence?: string;
  memberQuestion?: string;
  foregroundDisposition: InquiryForegroundDisposition;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface InquiryForegroundDecisionRecord {
  id: string;
  tenantId: string;
  inquiryId: string;
  disposition: InquiryForegroundDisposition;
  memberDelta: number;
  whyNow: string;
  bestQuietAlternative: string;
  answerUnavailablePrivately: boolean;
  timingLoss: number;
  naturalOpeningEventId?: string;
  reason: string;
  createdAt: string;
  revokedAt?: string;
}

function text(value: string, name: string, maximum: number, minimum = 1): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length < minimum) throw new Error(`${name} must contain at least ${minimum} characters`);
  if (clean.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  return clean;
}

function strings(values: string[], name: string, maximumItems: number, minimumItems = 0): string[] {
  const clean = [...new Set(values.map((value) => text(value, name, 2_000, 3)))].slice(0, maximumItems);
  if (clean.length < minimumItems) throw new Error(`${name} requires at least ${minimumItems} distinct entries`);
  return clean;
}

function parseStrings(value: SqlValue | undefined, name: string): string[] {
  if (typeof value !== "string") throw new Error(`${name} is missing`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${name} is corrupt`); }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error(`${name} is corrupt`);
  return parsed;
}

function optional(value: SqlValue | undefined): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function answerability(value: string): InquiryAnswerability {
  if (["records", "public", "member", "unavailable"].includes(value)) return value as InquiryAnswerability;
  throw new Error(`Unknown inquiry answerability: ${value}`);
}

/**
 * Durable uncertainty management. This class deliberately has no connector or
 * delivery dependency: learning something, or wanting to ask something, can
 * never send a message by itself.
 */
export class InquiryManager {
  readonly store: SqliteStore;

  constructor(store: SqliteStore) { this.store = store; }

  create(input: {
    tenantId: string;
    sourceEventId: string;
    sessionId?: string;
    triggerKind: string;
    triggerBasis: string;
    question: string;
    concreteBenefit: string;
    answerability: InquiryAnswerability;
    competingHypotheses: string[];
    falsifiers: string[];
    retrievalPlan: string[];
    maxSteps?: number;
    stopCondition: string;
    expiresAt?: string;
    idempotencyKey: string;
  }): InquiryRecord {
    const source = this.store.getEvent(input.tenantId, input.sourceEventId);
    if (!source) throw new Error("Inquiry source event does not exist");
    if (input.sessionId && !this.store.getSession(input.sessionId, input.tenantId)) throw new Error("Inquiry session does not belong to tenant");
    const question = text(input.question, "question", 4_000, 12);
    const concreteBenefit = text(input.concreteBenefit, "concreteBenefit", 4_000, 12);
    const triggerKind = text(input.triggerKind, "triggerKind", 80, 2).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    const triggerBasis = text(input.triggerBasis, "triggerBasis", 4_000, 12);
    const competingHypotheses = strings(input.competingHypotheses, "competingHypotheses", 8, 2);
    const falsifiers = strings(input.falsifiers, "falsifiers", 8, 1);
    const retrievalPlan = strings(input.retrievalPlan, "retrievalPlan", 12, 1);
    const maxSteps = Math.max(1, Math.min(32, Math.floor(input.maxSteps ?? 8)));
    const stopCondition = text(input.stopCondition, "stopCondition", 2_000, 8);
    const current = nowIso();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt).toISOString() : new Date(Date.now() + 14 * 24 * 60 * 60_000).toISOString();
    if (Number.isNaN(Date.parse(expiresAt)) || expiresAt <= current) throw new Error("Inquiry expiration must be in the future");
    const inquiryId = stableId("inq", `${input.tenantId}:${input.idempotencyKey}`);
    return this.store.transaction(() => {
      const prior = this.get(input.tenantId, inquiryId);
      if (prior) {
        const same = prior.sourceEventId === input.sourceEventId && prior.sessionId === input.sessionId
          && prior.triggerKind === triggerKind && prior.triggerBasis === triggerBasis && prior.question === question
          && prior.concreteBenefit === concreteBenefit && prior.answerability === input.answerability
          && JSON.stringify(prior.competingHypotheses) === JSON.stringify(competingHypotheses)
          && JSON.stringify(prior.falsifiers) === JSON.stringify(falsifiers)
          && JSON.stringify(prior.retrievalPlan) === JSON.stringify(retrievalPlan)
          && prior.maxSteps === maxSteps && prior.stopCondition === stopCondition
          && (!input.expiresAt || prior.expiresAt === expiresAt);
        if (!same) throw new Error("Inquiry idempotency key was reused with different content");
        return prior;
      }
      this.store.db.prepare(`INSERT INTO inquiries(
        id,tenant_id,source_event_id,session_id,trigger_kind,trigger_basis,question,concrete_benefit,answerability,status,
        competing_hypotheses_json,falsifiers_json,retrieval_plan_json,max_steps,stop_condition,expires_at,
        foreground_disposition,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'proposed',?,?,?,?,?,?,'backstage',?,?)`).run(
        inquiryId, input.tenantId, input.sourceEventId, input.sessionId ?? null, triggerKind, triggerBasis, question,
        concreteBenefit, answerability(input.answerability), JSON.stringify(competingHypotheses), JSON.stringify(falsifiers),
        JSON.stringify(retrievalPlan), maxSteps, stopCondition, expiresAt, current, current,
      );
      this.store.appendEvent({
        id: stableId("evt", `inquiry-created:${input.tenantId}:${inquiryId}`), tenantId: input.tenantId,
        stream: `inquiry:${inquiryId}`, type: "inquiry.created", causationId: input.sourceEventId,
        ...(input.sessionId ? { correlationId: input.sessionId } : {}),
        payload: { inquiryId, triggerKind, question, concreteBenefit, answerability: input.answerability, maxSteps, expiresAt, foregroundDisposition: "backstage" },
      });
      return this.require(input.tenantId, inquiryId);
    });
  }

  begin(tenantId: string, inquiryId: string): InquiryRecord {
    return this.store.transaction(() => {
      const inquiry = this.require(tenantId, inquiryId);
      if (inquiry.status === "investigating") return inquiry;
      if (inquiry.status !== "proposed") throw new Error(`Inquiry ${inquiryId} cannot begin from ${inquiry.status}`);
      const current = nowIso();
      if (inquiry.expiresAt <= current) return this.expire(tenantId, inquiryId, "expired before investigation began");
      this.store.db.prepare("UPDATE inquiries SET status='investigating',updated_at=? WHERE tenant_id=? AND id=?")
        .run(current, tenantId, inquiryId);
      this.store.appendEvent({
        id: stableId("evt", `inquiry-began:${tenantId}:${inquiryId}`), tenantId, stream: `inquiry:${inquiryId}`,
        type: "inquiry.investigation_started", causationId: inquiry.sourceEventId, payload: { inquiryId },
      });
      return this.require(tenantId, inquiryId);
    });
  }

  resolve(input: {
    tenantId: string;
    inquiryId: string;
    status: "resolved" | "insufficient" | "needs_member";
    finding: string;
    counterevidence: string;
    remainingUncertainty: string;
    nextPermittedConsequence: string;
    memberQuestion?: string;
  }): InquiryRecord {
    return this.store.transaction(() => {
      const inquiry = this.require(input.tenantId, input.inquiryId);
      if (["resolved", "insufficient", "needs_member"].includes(inquiry.status)) return inquiry;
      if (inquiry.status !== "investigating") throw new Error(`Inquiry ${inquiry.id} cannot resolve from ${inquiry.status}`);
      const finding = text(input.finding, "finding", 12_000, 3);
      const counterevidence = text(input.counterevidence, "counterevidence", 8_000, 3);
      const remainingUncertainty = text(input.remainingUncertainty, "remainingUncertainty", 8_000, 3);
      const nextPermittedConsequence = text(input.nextPermittedConsequence, "nextPermittedConsequence", 4_000, 3);
      const memberQuestion = input.memberQuestion ? text(input.memberQuestion, "memberQuestion", 1_000, 5) : undefined;
      if (input.status === "needs_member" && !memberQuestion) throw new Error("needs_member inquiries require a concrete memberQuestion");
      if (input.status !== "needs_member" && memberQuestion) throw new Error("Only needs_member inquiries may retain a memberQuestion");
      const current = nowIso();
      this.store.db.prepare(`UPDATE inquiries SET status=?,finding=?,counterevidence=?,remaining_uncertainty=?,
        next_permitted_consequence=?,member_question=?,updated_at=?,resolved_at=? WHERE tenant_id=? AND id=?`).run(
        input.status, finding, counterevidence, remainingUncertainty, nextPermittedConsequence, memberQuestion ?? null,
        current, current, input.tenantId, inquiry.id,
      );
      this.store.appendEvent({
        id: stableId("evt", `inquiry-resolved:${input.tenantId}:${inquiry.id}:${input.status}`), tenantId: input.tenantId,
        stream: `inquiry:${inquiry.id}`, type: `inquiry.${input.status}`, causationId: inquiry.sourceEventId,
        payload: { inquiryId: inquiry.id, finding, counterevidence, remainingUncertainty, nextPermittedConsequence, memberQuestion: memberQuestion ?? null, foregroundDisposition: "backstage" },
      });
      return this.require(input.tenantId, inquiry.id);
    });
  }

  decideForeground(input: {
    tenantId: string;
    inquiryId: string;
    disposition: InquiryForegroundDisposition;
    memberDelta: number;
    whyNow: string;
    bestQuietAlternative: string;
    answerUnavailablePrivately: boolean;
    timingLoss: number;
    naturalOpeningEventId?: string;
    reason: string;
  }): InquiryForegroundDecisionRecord {
    return this.store.transaction(() => {
      const inquiry = this.require(input.tenantId, input.inquiryId);
      const memberDelta = clamp(input.memberDelta);
      const timingLoss = clamp(input.timingLoss);
      const whyNow = text(input.whyNow, "whyNow", 2_000, 3);
      const bestQuietAlternative = text(input.bestQuietAlternative, "bestQuietAlternative", 2_000, 3);
      const reason = text(input.reason, "reason", 2_000, 3);
      const foreground = input.disposition === "natural_opening" || input.disposition === "interrupt";
      if (foreground && (!Number.isFinite(Date.parse(inquiry.expiresAt)) || inquiry.expiresAt <= nowIso())) {
        throw new Error("Foreground inquiry decisions cannot use an expired inquiry");
      }
      if (foreground && inquiry.status !== "resolved" && inquiry.status !== "needs_member") {
        throw new Error("Foreground inquiry decisions require a completed private investigation");
      }
      if (foreground && memberDelta < 0.75) throw new Error("Foreground inquiry decisions require a material member delta");
      if (foreground && inquiry.status === "needs_member" && !input.answerUnavailablePrivately) {
        throw new Error("Co must investigate privately before asking the member");
      }
      if (input.disposition === "natural_opening") {
        const opening = input.naturalOpeningEventId ? this.store.getEvent(input.tenantId, input.naturalOpeningEventId) : undefined;
        if (!opening) {
          throw new Error("A natural-opening decision requires a current tenant-owned event");
        }
        if (opening.id !== inquiry.sourceEventId && (!inquiry.sessionId || opening.correlationId !== inquiry.sessionId)) {
          throw new Error("A natural-opening event must belong to the inquiry's relationship context");
        }
        const openingAgeMs = Date.now() - Date.parse(opening.at);
        if (!Number.isFinite(openingAgeMs) || openingAgeMs < -5 * 60_000 || openingAgeMs > 30 * 60_000) {
          throw new Error("A natural-opening event must still be conversationally current");
        }
      }
      if (input.disposition === "interrupt" && timingLoss < 0.8) throw new Error("An inquiry may interrupt only when waiting destroys material value");
      if (input.disposition === "interrupt" && !input.answerUnavailablePrivately) throw new Error("An inquiry may not interrupt for an answer available privately");
      if (foreground && inquiry.memberQuestion) {
        const repeated = this.store.db.prepare(`SELECT d.id FROM inquiry_foreground_decisions d
          JOIN inquiries i ON i.id=d.inquiry_id AND i.tenant_id=d.tenant_id
          WHERE d.tenant_id=? AND d.inquiry_id<>? AND d.disposition IN ('natural_opening','interrupt')
            AND lower(trim(i.member_question))=lower(trim(?)) AND d.created_at>=?
          LIMIT 1`).get(input.tenantId, inquiry.id, inquiry.memberQuestion, new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString());
        if (repeated) throw new Error("An equivalent member question already spent recent relationship attention");
      }
      const decisionId = stableId("iqd", `${input.tenantId}:${inquiry.id}:${inquiry.updatedAt}:${input.disposition}:${reason}`);
      const current = nowIso();
      this.store.db.prepare(`INSERT OR IGNORE INTO inquiry_foreground_decisions(
        id,tenant_id,inquiry_id,disposition,member_delta,why_now,best_quiet_alternative,answer_unavailable_privately,
        timing_loss,natural_opening_event_id,reason,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        decisionId, input.tenantId, inquiry.id, input.disposition, memberDelta, whyNow, bestQuietAlternative,
        input.answerUnavailablePrivately ? 1 : 0, timingLoss, input.naturalOpeningEventId ?? null, reason, current,
      );
      this.store.db.prepare("UPDATE inquiries SET foreground_disposition=?,updated_at=? WHERE tenant_id=? AND id=?")
        .run(input.disposition, current, input.tenantId, inquiry.id);
      if (!foreground) this.store.db.prepare(`UPDATE inquiry_foreground_decisions SET revoked_at=COALESCE(revoked_at,?)
        WHERE tenant_id=? AND inquiry_id=? AND disposition IN ('natural_opening','interrupt')`)
        .run(current, input.tenantId, inquiry.id);
      this.store.appendEvent({
        id: stableId("evt", `inquiry-foreground:${input.tenantId}:${decisionId}`), tenantId: input.tenantId,
        stream: `inquiry:${inquiry.id}`, type: "inquiry.foreground_decided", causationId: inquiry.sourceEventId,
        ...(input.naturalOpeningEventId ? { correlationId: input.naturalOpeningEventId } : {}),
        payload: { inquiryId: inquiry.id, decisionId, disposition: input.disposition, memberDelta, timingLoss, reason },
      });
      return this.foregroundDecisions(input.tenantId, inquiry.id).find((item) => item.id === decisionId) as InquiryForegroundDecisionRecord;
    });
  }

  /** Exact decision authority, not an inferred relationship by topic or source.
   * Called again at transport initiation; no model or JSON parsing is needed. */
  deliveryValidity(tenantId: string, decisionId: string, sourceEventId: string, sessionId?: string): {
    authorized: boolean; fresh: boolean; reason: string;
  } {
    const row = this.store.db.prepare(`SELECT d.disposition,d.revoked_at,d.natural_opening_event_id,
      i.status,i.foreground_disposition,i.source_event_id,i.session_id,i.expires_at
      FROM inquiry_foreground_decisions d JOIN inquiries i ON i.tenant_id=d.tenant_id AND i.id=d.inquiry_id
      WHERE d.tenant_id=? AND d.id=?`).get(tenantId, decisionId) as Row | undefined;
    if (!row || row.source_event_id !== sourceEventId || (sessionId && row.session_id && row.session_id !== sessionId)
      || row.revoked_at || !["resolved", "needs_member"].includes(String(row.status))
      || !["natural_opening", "interrupt"].includes(String(row.disposition))
      || !["natural_opening", "interrupt"].includes(String(row.foreground_disposition))) {
      return { authorized: false, fresh: false, reason: "Inquiry delivery decision is missing, revoked, or belongs to another context" };
    }
    const expiry = Date.parse(String(row.expires_at));
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      return { authorized: true, fresh: false, reason: "Inquiry delivery window expired" };
    }
    if (row.disposition === "natural_opening") {
      const opening = typeof row.natural_opening_event_id === "string"
        ? this.store.db.prepare("SELECT at FROM events WHERE tenant_id=? AND id=?").get(tenantId, row.natural_opening_event_id) as Row | undefined : undefined;
      const age = opening ? Date.now() - Date.parse(String(opening.at)) : NaN;
      if (!Number.isFinite(age) || age < -5 * 60_000 || age > 30 * 60_000) {
        return { authorized: true, fresh: false, reason: "Inquiry conversational opening closed; do not turn a held reply into an interruption" };
      }
    }
    return { authorized: true, fresh: true, reason: "Exact inquiry decision remains eligible" };
  }

  expire(tenantId: string, inquiryId: string, reason: string): InquiryRecord {
    return this.store.transaction(() => {
      this.expireState(tenantId, inquiryId, reason);
      return this.require(tenantId, inquiryId);
    });
  }

  expireDue(tenantId: string, limit = 100): number {
    const rows = this.store.db.prepare(`SELECT id FROM inquiries WHERE tenant_id=? AND expires_at<=?
      AND status NOT IN ('expired','retired') AND foreground_disposition!='expired'
      ORDER BY expires_at,id LIMIT ?`).all(tenantId, nowIso(), Math.max(1, Math.min(500, Math.floor(limit)))) as Row[];
    let expired = 0;
    for (const row of rows) {
      expired += this.store.transaction(() => this.expireState(tenantId, String(row.id), "The useful investigation window closed.")) ? 1 : 0;
    }
    return expired;
  }

  private expireState(tenantId: string, inquiryId: string, reason: string): boolean {
    // Lifecycle maintenance needs no parsed hypothesis/plan content. A damaged
    // historical JSON field must not prevent other inquiries from expiring.
    const row = this.store.db.prepare("SELECT status,foreground_disposition,source_event_id FROM inquiries WHERE tenant_id=? AND id=?")
      .get(tenantId, inquiryId) as Row | undefined;
    if (!row) throw new Error(`Unknown inquiry ${inquiryId}`);
    if (row.status === "expired" || row.status === "retired" || row.foreground_disposition === "expired") return false;
    const current = nowIso();
    this.store.db.prepare(`UPDATE inquiries SET status=CASE WHEN status IN ('resolved','insufficient') THEN status ELSE 'expired' END,
      foreground_disposition='expired',updated_at=?,resolved_at=COALESCE(resolved_at,?) WHERE tenant_id=? AND id=?`)
      .run(current, current, tenantId, inquiryId);
    this.store.db.prepare(`UPDATE inquiry_foreground_decisions SET revoked_at=COALESCE(revoked_at,?)
      WHERE tenant_id=? AND inquiry_id=? AND disposition IN ('natural_opening','interrupt')`).run(current, tenantId, inquiryId);
    this.store.appendEvent({ id: stableId("evt", `inquiry-expired:${tenantId}:${inquiryId}`), tenantId, stream: `inquiry:${inquiryId}`,
      type: "inquiry.expired", causationId: String(row.source_event_id),
      payload: { inquiryId, reason: text(reason, "reason", 2_000, 3), priorStatus: String(row.status) } });
    return true;
  }

  get(tenantId: string, inquiryId: string): InquiryRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM inquiries WHERE tenant_id=? AND id=?").get(tenantId, inquiryId) as Row | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  forSource(tenantId: string, sourceEventId: string): InquiryRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM inquiries WHERE tenant_id=? AND source_event_id=? ORDER BY created_at DESC LIMIT 1")
      .get(tenantId, sourceEventId) as Row | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  list(tenantId: string, options: { status?: InquiryStatus; limit?: number } = {}): InquiryRecord[] {
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    const rows = options.status
      ? this.store.db.prepare("SELECT * FROM inquiries WHERE tenant_id=? AND status=? ORDER BY updated_at DESC LIMIT ?").all(tenantId, options.status, limit) as Row[]
      : this.store.db.prepare("SELECT * FROM inquiries WHERE tenant_id=? ORDER BY updated_at DESC LIMIT ?").all(tenantId, limit) as Row[];
    return rows.map((row) => this.fromRow(row));
  }

  foregroundDecisions(tenantId: string, inquiryId: string): InquiryForegroundDecisionRecord[] {
    const rows = this.store.db.prepare("SELECT * FROM inquiry_foreground_decisions WHERE tenant_id=? AND inquiry_id=? ORDER BY created_at ASC,id ASC")
      .all(tenantId, inquiryId) as Row[];
    return rows.map((row) => {
      const naturalOpeningEventId = optional(row.natural_opening_event_id);
      const revokedAt = optional(row.revoked_at);
      return {
        id: String(row.id), tenantId: String(row.tenant_id), inquiryId: String(row.inquiry_id),
        disposition: String(row.disposition) as InquiryForegroundDisposition, memberDelta: Number(row.member_delta),
        whyNow: String(row.why_now), bestQuietAlternative: String(row.best_quiet_alternative),
        answerUnavailablePrivately: Number(row.answer_unavailable_privately) === 1, timingLoss: Number(row.timing_loss),
        ...(naturalOpeningEventId ? { naturalOpeningEventId } : {}), reason: String(row.reason), createdAt: String(row.created_at),
        ...(revokedAt ? { revokedAt } : {}),
      };
    });
  }

  private require(tenantId: string, inquiryId: string): InquiryRecord {
    const inquiry = this.get(tenantId, inquiryId);
    if (!inquiry) throw new Error(`Unknown inquiry ${inquiryId}`);
    return inquiry;
  }

  private fromRow(row: Row): InquiryRecord {
    const sessionId = optional(row.session_id);
    const finding = optional(row.finding);
    const counterevidence = optional(row.counterevidence);
    const remainingUncertainty = optional(row.remaining_uncertainty);
    const nextPermittedConsequence = optional(row.next_permitted_consequence);
    const memberQuestion = optional(row.member_question);
    const resolvedAt = optional(row.resolved_at);
    return {
      id: String(row.id), tenantId: String(row.tenant_id), sourceEventId: String(row.source_event_id),
      ...(sessionId ? { sessionId } : {}),
      triggerKind: String(row.trigger_kind), triggerBasis: String(row.trigger_basis), question: String(row.question),
      concreteBenefit: String(row.concrete_benefit), answerability: answerability(String(row.answerability)),
      status: String(row.status) as InquiryStatus,
      competingHypotheses: parseStrings(row.competing_hypotheses_json, "competing_hypotheses_json"),
      falsifiers: parseStrings(row.falsifiers_json, "falsifiers_json"), retrievalPlan: parseStrings(row.retrieval_plan_json, "retrieval_plan_json"),
      maxSteps: Number(row.max_steps), stopCondition: String(row.stop_condition), expiresAt: String(row.expires_at),
      ...(finding ? { finding } : {}), ...(counterevidence ? { counterevidence } : {}),
      ...(remainingUncertainty ? { remainingUncertainty } : {}),
      ...(nextPermittedConsequence ? { nextPermittedConsequence } : {}), ...(memberQuestion ? { memberQuestion } : {}),
      foregroundDisposition: String(row.foreground_disposition) as InquiryForegroundDisposition,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      ...(resolvedAt ? { resolvedAt } : {}),
    };
  }
}
