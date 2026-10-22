import { nowIso, stableId } from "./id.ts";
import { OutcomeLearner } from "./outcome-learner.ts";
import type { SqliteStore } from "./store.ts";
import type { JsonObject, JsonValue, MessagePart } from "./types.ts";

type Row = Record<string, string | number | bigint | null | Uint8Array>;

export type MemberOutcomeKind = "useful_surprise" | "useful" | "obvious" | "annoying" | "neutral";
export type ContextAdvantage = "yes" | "no" | "unknown";

export interface MemberOutcomeFeedback {
  id: string;
  tenantId: string;
  sessionId: string;
  targetMessageId: string;
  sourceEventId: string;
  kind: MemberOutcomeKind;
  contextAdvantage: ContextAdvantage;
  observedAt: string;
  proactive: boolean;
  proactiveAt?: string;
  createdAt: string;
}

export interface ProductQualitySnapshot {
  generatedAt: string;
  relationshipStartedAt: string | null;
  ownerMessages: number;
  authoredSubstantiveMessages: number;
  ratedMessages: number;
  feedbackCoverageRatio: number;
  byKind: Record<MemberOutcomeKind, number>;
  /** Member-validated positive responses over every substantive response Co chose to send. */
  goodResponseRatio: number;
  /** Member-validated obvious/annoying responses over every substantive response Co chose to send. */
  obviousOrAnnoyingResponseRatio: number;
  ratedGoodResponseRatio: number | null;
  ratedObviousOrAnnoyingRatio: number | null;
  usefulSurprises: number;
  firstUsefulSurpriseAt: string | null;
  firstUsefulSurpriseElapsedDays: number | null;
  ownerMessagesBeforeFirstUsefulSurprise: number | null;
  contextAdvantageRated: number;
  contextAdvantagePositive: number;
  contextAdvantageRatio: number | null;
  silentResponses: number;
  tapbackResponses: number;
  proactiveAccepted: number;
  proactiveDelivered: number;
  proactiveInterruptionsSent: number;
  /** Maximum admissions in any inclusive rolling 24-hour window; exact activity timestamps stay private. */
  proactiveAdmissionCount: number;
  maximumRolling24HourAdmissions: number;
  attentionAdmissionProjectionValid: boolean;
  proactiveRatedMessages: number;
  proactiveFeedbackCoverageRatio: number;
  proactiveByKind: Record<MemberOutcomeKind, number>;
  /** Member-validated positive proactive messages over all provider-accepted proactive messages. */
  proactiveGoodResponseRatio: number;
  /** Member-validated obvious/annoying proactive messages over all provider-accepted proactive messages. */
  proactiveObviousOrAnnoyingResponseRatio: number;
  proactiveRatedGoodResponseRatio: number | null;
  proactiveRatedObviousOrAnnoyingRatio: number | null;
  tenureMonths: Array<{
    month: number;
    ownerMessages: number;
    authoredSubstantiveMessages: number;
    ratedMessages: number;
    usefulSurprises: number;
    useful: number;
    obvious: number;
    annoying: number;
    neutral: number;
    ratedGoodResponseRatio: number | null;
    proactiveAccepted: number;
    proactiveDelivered: number;
    proactiveInterruptionsSent: number;
    proactiveRatedMessages: number;
    proactiveFeedbackCoverageRatio: number | null;
    proactiveByKind: Record<MemberOutcomeKind, number>;
    goodResponseRatio: number;
    obviousOrAnnoyingResponseRatio: number;
    proactiveGoodResponseRatio: number;
    proactiveObviousOrAnnoyingResponseRatio: number;
    proactiveRatedGoodResponseRatio: number | null;
    proactiveRatedObviousOrAnnoyingRatio: number | null;
  }>;
  promises: { due: number; completed: number; released: number; overdue: number; accepted: number };
  consequentialEffects: { total: number; notStarted: number; confirmed: number; accepted: number; failed: number; uncertain: number };
}

const OUTCOME_KINDS = ["useful_surprise", "useful", "obvious", "annoying", "neutral"] as const;

// This expression mirrors OutcomeLearner's causal boundary. A target counts as
// proactive only when its assistant message points to an accepted delivery
// whose exact intent and intervention correlation are both still present.
const PROACTIVE_AT_SQL = `(SELECT COALESCE(intervention.sent_at,acceptance.at,intervention.accepted_at,target.created_at)
  FROM messages target
  JOIN events acceptance
    ON acceptance.tenant_id=f.tenant_id AND acceptance.id=target.event_id
    AND acceptance.type='message.delivery_accepted'
  JOIN outbound_deliveries delivery
    ON delivery.tenant_id=f.tenant_id AND delivery.acceptance_event_id=acceptance.id
    AND delivery.intent_id=acceptance.causation_id AND delivery.state='accepted'
  JOIN interventions intervention
    ON intervention.tenant_id=f.tenant_id
    AND acceptance.correlation_id='intervention:' || intervention.id
  WHERE target.tenant_id=f.tenant_id AND target.id=f.target_message_id AND target.role='assistant'
  LIMIT 1)`;

function outcomeKind(value: string): MemberOutcomeKind {
  if (OUTCOME_KINDS.includes(value as MemberOutcomeKind)) return value as MemberOutcomeKind;
  throw new Error(`Unknown member outcome kind: ${value}`);
}

function contextAdvantage(value: string): ContextAdvantage {
  if (value === "yes" || value === "no" || value === "unknown") return value;
  throw new Error(`Unknown context-advantage value: ${value}`);
}

function messageHasSubstantiveText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let parts: unknown;
  try { parts = JSON.parse(value); } catch { return false; }
  return Array.isArray(parts) && !parts.some((part) => (part as { type?: unknown })?.type === "tool_call") && parts.some((part) => {
    const candidate = part as Partial<MessagePart>;
    return candidate?.type === "text" && typeof candidate.text === "string" && candidate.text.trim().length >= 12;
  });
}

function messageText(value: unknown): string {
  if (typeof value !== "string") return "";
  let parts: unknown;
  try { parts = JSON.parse(value); } catch { return ""; }
  if (!Array.isArray(parts)) return "";
  return parts.flatMap((part) => {
    const candidate = part as { type?: unknown; text?: unknown };
    return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  }).join("\n");
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function cueText(value: string): string {
  return normalizedText(value)
    .replace(/[’‘]/g, "'")
    .replace(/\bnot only\b/g, "")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasPositiveCue(value: string): boolean {
  return /\b(useful|helpful|valuable|surprising|surprised|insightful|excellent|great|loved|love|needed|nailed|worked|actionable)\b/.test(value);
}

function hasNegativeCue(value: string): boolean {
  return /\b(useless|unhelpful|annoying|irritating|obvious|repetitive|repeated|generic|unwanted|wrong|irrelevant)\b/.test(value)
    || /\b(nothing new|already knew|did not help|didn't help|was not useful|wasn't useful|not useful|not helpful|do not need|don't need|did not need|didn't need|stop sending|too many)\b/.test(value);
}

function assertSemanticSupport(kind: MemberOutcomeKind, quote: string): void {
  const cue = cueText(quote);
  const positive = hasPositiveCue(cue);
  const negative = hasNegativeCue(cue);
  const supported = kind === "useful" || kind === "useful_surprise"
    ? positive && !negative
    : kind === "obvious"
      ? /\b(obvious|repetitive|repeated|generic|nothing new|already knew|restat(?:e|ed|ement))\b/.test(cue)
      : kind === "annoying"
        ? /\b(annoying|irritating|unwanted|stop sending|too many|bother(?:ed|ing)?)\b/.test(cue)
        : /\b(neutral|neither|no opinion|fine|okay|ok)\b/.test(cue) && !positive && !negative;
  if (!supported) {
    throw new Error(`Member outcome quote does not unambiguously support the ${kind} classification`);
  }
}

function assertContextSupport(advantage: ContextAdvantage, quote: string): void {
  if (advantage === "unknown") return;
  const cue = cueText(quote);
  const namesContext = /\b(context|history|remember(?:ed|ing)?|earlier|past|knew me|knowing me)\b/.test(cue);
  const deniesAdvantage = /\b(did not|didn't|does not|doesn't|not|without|unnecessary|irrelevant)\b.{0,40}\b(context|history|remember|earlier|past|knew|knowing)\b/.test(cue)
    || /\b(context|history|remember|earlier|past|knew|knowing)\b.{0,40}\b(did not|didn't|does not|doesn't|not needed|unnecessary|irrelevant)\b/.test(cue);
  if (!namesContext || (advantage === "yes" ? deniesAdvantage : !deniesAdvantage)) {
    throw new Error(`Context evidence quote does not unambiguously support context advantage ${advantage}`);
  }
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null;
}

function countMap(rows: Row[], key: string): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [String(row[key]), Number(row.count ?? 0)]));
}

function outcomeCounts(rows: Row[]): Record<MemberOutcomeKind, number> {
  return Object.fromEntries(OUTCOME_KINDS.map((kind) => [
    kind, rows.filter((row) => row.kind === kind).length,
  ])) as Record<MemberOutcomeKind, number>;
}

function elapsedDays(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const elapsed = Date.parse(end) - Date.parse(start);
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.round((elapsed / 86_400_000) * 10_000) / 10_000 : null;
}

function rolling24HourAdmissionProjection(timestamps: string[]): { maximum: number; valid: boolean } {
  const times = timestamps.map((value) => Date.parse(value));
  if (times.some((value) => !Number.isFinite(value))) return { maximum: 0, valid: false };
  times.sort((left, right) => left - right);
  let left = 0;
  let maximum = 0;
  for (let right = 0; right < times.length; right += 1) {
    while ((times[right] ?? 0) - (times[left] ?? 0) > 24 * 60 * 60_000) left += 1;
    maximum = Math.max(maximum, right - left + 1);
  }
  return { maximum, valid: true };
}

/**
 * Records product feedback only when it is causally bound to an actual owner
 * message and the immediately preceding substantive assistant message in the
 * same relationship. The model supplies a small classification; it cannot
 * choose the target, write a note, or grade its own output without owner text.
 */
export class ProductOutcomeManager {
  readonly store: SqliteStore;
  readonly learner: OutcomeLearner;

  constructor(store: SqliteStore, learner = new OutcomeLearner(store)) {
    this.store = store;
    this.learner = learner;
  }

  record(input: {
    tenantId: string;
    sessionId: string;
    sourceEventId: string;
    kind: MemberOutcomeKind;
    contextAdvantage?: ContextAdvantage;
    evidenceQuote: string;
    contextEvidenceQuote?: string;
  }): MemberOutcomeFeedback {
    const classified = outcomeKind(input.kind);
    const advantage = contextAdvantage(input.contextAdvantage ?? "unknown");
    const sources = this.store.db.prepare(`SELECT rowid,id,role,event_id,parts_json,created_at FROM messages
      WHERE tenant_id=? AND session_id=? AND event_id=? LIMIT 2`).all(
      input.tenantId, input.sessionId, input.sourceEventId,
    ) as Row[];
    const source = sources[0];
    const event = this.store.getEvent(input.tenantId, input.sourceEventId);
    if (sources.length !== 1 || !source || source.role !== "user" || !event || event.type !== "message.received") {
      throw new Error("Member outcome feedback must be bound to the current owner message");
    }
    const ownerText = normalizedText(messageText(source.parts_json));
    const evidenceQuote = input.evidenceQuote.trim();
    if (evidenceQuote.length < 2 || evidenceQuote.length > 240
      || !ownerText.includes(normalizedText(evidenceQuote))) {
      throw new Error("Member outcome feedback requires a short verbatim quote from the current owner message");
    }
    if (advantage !== "unknown") {
      const contextQuote = input.contextEvidenceQuote?.trim() ?? "";
      if (contextQuote.length < 2 || contextQuote.length > 240 || !ownerText.includes(normalizedText(contextQuote))) {
        throw new Error("A context-advantage rating requires its own short verbatim quote from the current owner message");
      }
    }
    const candidates = this.store.db.prepare(`SELECT rowid,id,parts_json FROM messages
      WHERE tenant_id=? AND session_id=? AND role='assistant' AND rowid<?
      ORDER BY rowid DESC LIMIT 20`).all(input.tenantId, input.sessionId, Number(source.rowid)) as Row[];
    const target = candidates.find((candidate) => messageHasSubstantiveText(candidate.parts_json));
    if (!target) throw new Error("Member outcome feedback has no preceding substantive Co message in this relationship");
    const feedbackId = stableId("mof", `${input.tenantId}:${input.sourceEventId}`);
    const prior = this.get(input.tenantId, feedbackId);
    if (prior) {
      if (prior.sessionId !== input.sessionId || prior.targetMessageId !== String(target.id)
        || prior.kind !== classified || prior.contextAdvantage !== advantage) {
        throw new Error("Member outcome feedback source was reused with a conflicting classification");
      }
      return prior;
    }
    assertSemanticSupport(classified, evidenceQuote);
    if (advantage !== "unknown") assertContextSupport(advantage, input.contextEvidenceQuote?.trim() ?? "");
    const createdAt = nowIso();
    return this.store.transaction(() => {
      const concurrent = this.get(input.tenantId, feedbackId);
      if (concurrent) {
        if (concurrent.sessionId !== input.sessionId || concurrent.targetMessageId !== String(target.id)
          || concurrent.kind !== classified || concurrent.contextAdvantage !== advantage) {
          throw new Error("Member outcome feedback source was reused with a conflicting classification");
        }
        return concurrent;
      }
      const superseded = this.store.db.prepare(`SELECT f.id FROM member_outcome_feedback f
        LEFT JOIN messages source ON source.tenant_id=f.tenant_id AND source.session_id=f.session_id AND source.event_id=f.source_event_id
        WHERE f.tenant_id=? AND f.target_message_id=?
        ORDER BY COALESCE(source.rowid,0) DESC,f.created_at DESC,f.id DESC LIMIT 1`)
        .get(input.tenantId, String(target.id)) as Row | undefined;
      this.store.db.prepare(`INSERT INTO member_outcome_feedback(
        id,tenant_id,session_id,target_message_id,source_event_id,kind,context_advantage,created_at
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        feedbackId, input.tenantId, input.sessionId, String(target.id), input.sourceEventId, classified, advantage, createdAt,
      );
      this.store.appendEvent({
        id: stableId("evt", `member-outcome:${input.tenantId}:${feedbackId}`), tenantId: input.tenantId,
        stream: `session:${input.sessionId}`, type: "product.member_outcome_recorded",
        correlationId: input.sessionId, causationId: input.sourceEventId,
        payload: {
          feedbackId, targetMessageId: String(target.id), kind: classified, contextAdvantage: advantage,
          supersedesFeedbackId: superseded ? String(superseded.id) : null,
        },
      });
      const feedback = this.get(input.tenantId, feedbackId) as MemberOutcomeFeedback;
      this.learner.record(feedback);
      return feedback;
    });
  }

  get(tenantId: string, feedbackId: string): MemberOutcomeFeedback | undefined {
    const row = this.store.db.prepare(`SELECT f.*,COALESCE(observed.at,source.created_at,f.created_at) AS observed_at,
      ${PROACTIVE_AT_SQL} AS proactive_at
      FROM member_outcome_feedback f
      LEFT JOIN messages source
        ON source.tenant_id=f.tenant_id AND source.session_id=f.session_id AND source.event_id=f.source_event_id
      LEFT JOIN events observed
        ON observed.tenant_id=f.tenant_id AND observed.id=f.source_event_id AND observed.type='message.received'
      WHERE f.tenant_id=? AND f.id=?`)
      .get(tenantId, feedbackId) as Row | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  list(tenantId: string, limit = 200): MemberOutcomeFeedback[] {
    const rows = this.store.db.prepare(`SELECT f.*,COALESCE(observed.at,source.created_at,f.created_at) AS observed_at,
      ${PROACTIVE_AT_SQL} AS proactive_at
      FROM member_outcome_feedback f
      LEFT JOIN messages source
        ON source.tenant_id=f.tenant_id AND source.session_id=f.session_id AND source.event_id=f.source_event_id
      LEFT JOIN events observed
        ON observed.tenant_id=f.tenant_id AND observed.id=f.source_event_id AND observed.type='message.received'
      WHERE f.tenant_id=? ORDER BY f.created_at DESC,f.id DESC LIMIT ?`)
      .all(tenantId, Math.max(1, Math.min(1_000, Math.floor(limit)))) as Row[];
    return rows.map((row) => this.fromRow(row));
  }

  summary(tenantId: string, at = new Date()): ProductQualitySnapshot {
    const currentFeedback = this.store.db.prepare(`SELECT * FROM (
      SELECT f.*,COALESCE(observed.at,source.created_at,f.created_at) AS observed_at,
        ${PROACTIVE_AT_SQL} AS proactive_at,
        ROW_NUMBER() OVER (
        PARTITION BY f.target_message_id ORDER BY COALESCE(source.rowid,0) DESC,f.created_at DESC,f.id DESC
      ) AS current_rank
      FROM member_outcome_feedback f
      LEFT JOIN messages source ON source.tenant_id=f.tenant_id AND source.session_id=f.session_id AND source.event_id=f.source_event_id
      LEFT JOIN events observed
        ON observed.tenant_id=f.tenant_id AND observed.id=f.source_event_id AND observed.type='message.received'
      WHERE f.tenant_id=?
    ) WHERE current_rank=1`).all(tenantId) as Row[];
    const byKind = outcomeCounts(currentFeedback);
    const proactiveFeedback = currentFeedback.filter((row) => typeof row.proactive_at === "string");
    const proactiveByKind = outcomeCounts(proactiveFeedback);
    const messages = this.store.db.prepare(`SELECT message.role,message.parts_json,message.created_at,
      COALESCE(source.at,message.created_at) AS observed_at
      FROM messages message LEFT JOIN events source
        ON source.tenant_id=message.tenant_id AND source.id=message.event_id
      WHERE message.tenant_id=?`)
      .all(tenantId) as Row[];
    const authoredSubstantiveMessages = messages.filter((row) => row.role === "assistant" && messageHasSubstantiveText(row.parts_json)).length;
    const ratedMessages = currentFeedback.length;
    const positive = byKind.useful_surprise + byKind.useful;
    const negative = byKind.obvious + byKind.annoying;
    const ratedNonNeutral = positive + negative;
    const proactivePositive = proactiveByKind.useful_surprise + proactiveByKind.useful;
    const proactiveNegative = proactiveByKind.obvious + proactiveByKind.annoying;
    const proactiveRatedNonNeutral = proactivePositive + proactiveNegative;
    const first = currentFeedback.filter((row) => row.kind === "useful_surprise")
      .sort((left, right) => String(left.observed_at).localeCompare(String(right.observed_at)) || String(left.id).localeCompare(String(right.id)))[0];
    const ownerMessagesBeforeFirstUsefulSurprise = first
      ? Number((this.store.db.prepare(`SELECT COUNT(*) AS count FROM messages
          WHERE tenant_id=? AND role='user' AND rowid<=(
            SELECT rowid FROM messages WHERE tenant_id=? AND event_id=? AND role='user' LIMIT 1
          )`).get(tenantId, tenantId, String(first.source_event_id)) as Row).count ?? 0)
      : null;
    const currentSurpriseFeedback = currentFeedback.filter((row) => row.kind === "useful_surprise");
    const contextAdvantagePositive = currentSurpriseFeedback.filter((row) => row.context_advantage === "yes").length;
    const contextAdvantageRated = currentSurpriseFeedback.filter((row) => row.context_advantage === "yes" || row.context_advantage === "no").length;
    const promiseRows = countMap(this.store.db.prepare(`SELECT status,COUNT(*) AS count FROM promises
      WHERE tenant_id=? AND (due_at<=? OR status IN ('completed','released')) GROUP BY status`)
      .all(tenantId, at.toISOString()) as Row[], "status");
    const due = Object.values(promiseRows).reduce((sum, count) => sum + count, 0);
    const effectRows = countMap(this.store.db.prepare(`SELECT effect_state,COUNT(*) AS count FROM tool_receipts
      WHERE tenant_id=? AND risk IN ('external-write','destructive') GROUP BY effect_state`).all(tenantId) as Row[], "effect_state");
    const consequentialTotal = Object.values(effectRows).reduce((sum, count) => sum + count, 0);
    const proactiveTotals = this.store.db.prepare(`SELECT
      SUM(CASE WHEN accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered
      FROM interventions WHERE tenant_id=? AND decision='send'`).get(tenantId) as Row;
    const proactiveAccepted = Number(proactiveTotals.accepted ?? 0);
    const proactiveDelivered = Number(proactiveTotals.delivered ?? 0);
    const proactiveInterruptionsSent = proactiveDelivered;
    const proactiveAdmissionTimes = (this.store.db.prepare(`SELECT attention_reserved_at FROM interventions
      WHERE tenant_id=? AND attention_reserved_at IS NOT NULL ORDER BY attention_reserved_at,id`).all(tenantId) as Row[])
      .flatMap((row) => typeof row.attention_reserved_at === "string" ? [row.attention_reserved_at] : []);
    const proactiveAdmissionCount = proactiveAdmissionTimes.length;
    const admissionProjection = rolling24HourAdmissionProjection(proactiveAdmissionTimes);
    const maximumRolling24HourAdmissions = admissionProjection.maximum;
    const silentResponses = Number((this.store.db.prepare(`SELECT COUNT(*) AS count FROM events
      WHERE tenant_id=? AND type='relationship.response_silenced'`).get(tenantId) as Row).count ?? 0);
    const tapbackResponses = Number((this.store.db.prepare(`SELECT COUNT(*) AS count FROM events
      WHERE tenant_id=? AND type='relationship.reaction_sent'`).get(tenantId) as Row).count ?? 0);
    const relationship = this.store.db.prepare(`SELECT MIN(COALESCE(source.at,message.created_at)) AS started_at,COUNT(*) AS count
      FROM messages message LEFT JOIN events source
        ON source.tenant_id=message.tenant_id AND source.id=message.event_id
      WHERE message.tenant_id=? AND message.role='user'`)
      .get(tenantId) as Row;
    const relationshipStartedAt = typeof relationship.started_at === "string" ? relationship.started_at : null;
    const ownerMessages = Number(relationship.count ?? 0);
    const tenure = new Map<number, {
      month: number; ownerMessages: number; authoredSubstantiveMessages: number; ratedMessages: number;
      usefulSurprises: number; useful: number; obvious: number; annoying: number; neutral: number;
      proactiveAccepted: number; proactiveDelivered: number; proactiveInterruptionsSent: number;
      proactiveRatedMessages: number; proactiveByKind: Record<MemberOutcomeKind, number>;
    }>();
    const tenureBucket = (timestamp: string): number | undefined => {
      if (!relationshipStartedAt) return undefined;
      const elapsed = Date.parse(timestamp) - Date.parse(relationshipStartedAt);
      return Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / (30.4375 * 24 * 60 * 60_000))) : undefined;
    };
    const bucket = (month: number) => {
      const existing = tenure.get(month);
      if (existing) return existing;
      const created = {
        month, ownerMessages: 0, authoredSubstantiveMessages: 0, ratedMessages: 0,
        usefulSurprises: 0, useful: 0, obvious: 0, annoying: 0, neutral: 0,
        proactiveAccepted: 0, proactiveDelivered: 0, proactiveInterruptionsSent: 0,
        proactiveRatedMessages: 0, proactiveByKind: outcomeCounts([]),
      };
      tenure.set(month, created);
      return created;
    };
    const datedFeedback = [...currentFeedback]
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) || String(left.id).localeCompare(String(right.id)));
    for (const row of datedFeedback) {
      const month = tenureBucket(String(row.observed_at));
      if (month === undefined) continue;
      const item = bucket(month);
      const kind = outcomeKind(String(row.kind));
      item.ratedMessages += 1;
      if (kind === "useful_surprise") item.usefulSurprises += 1;
      else item[kind] += 1;
      if (typeof row.proactive_at === "string") {
        const proactiveMonth = tenureBucket(String(row.proactive_at));
        if (proactiveMonth !== undefined) {
          const proactiveItem = bucket(proactiveMonth);
          proactiveItem.proactiveRatedMessages += 1;
          proactiveItem.proactiveByKind[kind] += 1;
        }
      }
    }
    for (const row of messages) {
      const month = tenureBucket(String(row.observed_at));
      if (month === undefined) continue;
      if (row.role === "user") bucket(month).ownerMessages += 1;
      else if (row.role === "assistant" && messageHasSubstantiveText(row.parts_json)) bucket(month).authoredSubstantiveMessages += 1;
    }
    const datedInterruptions = this.store.db.prepare(`SELECT accepted_at,sent_at FROM interventions
      WHERE tenant_id=? AND decision='send' AND accepted_at IS NOT NULL ORDER BY accepted_at,id`).all(tenantId) as Row[];
    for (const row of datedInterruptions) {
      const acceptedMonth = tenureBucket(String(row.accepted_at));
      if (acceptedMonth !== undefined) bucket(acceptedMonth).proactiveAccepted += 1;
      if (typeof row.sent_at === "string") {
        const deliveredMonth = tenureBucket(row.sent_at);
        if (deliveredMonth !== undefined) {
          bucket(deliveredMonth).proactiveDelivered += 1;
          bucket(deliveredMonth).proactiveInterruptionsSent += 1;
        }
      }
    }
    const tenureMonths = [...tenure.values()].sort((left, right) => left.month - right.month).map((item) => {
      const proactiveGood = item.proactiveByKind.useful_surprise + item.proactiveByKind.useful;
      const proactiveBad = item.proactiveByKind.obvious + item.proactiveByKind.annoying;
      return {
        ...item,
        goodResponseRatio: ratio(item.usefulSurprises + item.useful, item.authoredSubstantiveMessages) ?? 0,
        obviousOrAnnoyingResponseRatio: ratio(item.obvious + item.annoying, item.authoredSubstantiveMessages) ?? 0,
        ratedGoodResponseRatio: ratio(item.usefulSurprises + item.useful,
          item.usefulSurprises + item.useful + item.obvious + item.annoying),
        proactiveGoodResponseRatio: ratio(proactiveGood, item.proactiveAccepted) ?? 0,
        proactiveObviousOrAnnoyingResponseRatio: ratio(proactiveBad, item.proactiveAccepted) ?? 0,
        proactiveFeedbackCoverageRatio: ratio(item.proactiveRatedMessages, item.proactiveAccepted),
        proactiveRatedGoodResponseRatio: ratio(proactiveGood, proactiveGood + proactiveBad),
        proactiveRatedObviousOrAnnoyingRatio: ratio(proactiveBad, proactiveGood + proactiveBad),
      };
    });
    const firstUsefulSurpriseAt = first ? String(first.observed_at) : null;
    return {
      generatedAt: at.toISOString(), relationshipStartedAt, ownerMessages, authoredSubstantiveMessages, ratedMessages,
      feedbackCoverageRatio: ratio(ratedMessages, authoredSubstantiveMessages) ?? 0,
      byKind,
      goodResponseRatio: ratio(positive, authoredSubstantiveMessages) ?? 0,
      obviousOrAnnoyingResponseRatio: ratio(negative, authoredSubstantiveMessages) ?? 0,
      ratedGoodResponseRatio: ratio(positive, ratedNonNeutral),
      ratedObviousOrAnnoyingRatio: ratio(negative, ratedNonNeutral),
      usefulSurprises: byKind.useful_surprise,
      firstUsefulSurpriseAt,
      firstUsefulSurpriseElapsedDays: elapsedDays(relationshipStartedAt, firstUsefulSurpriseAt),
      ownerMessagesBeforeFirstUsefulSurprise,
      contextAdvantageRated, contextAdvantagePositive,
      contextAdvantageRatio: ratio(contextAdvantagePositive, contextAdvantageRated),
      silentResponses, tapbackResponses, proactiveAccepted, proactiveDelivered, proactiveInterruptionsSent,
      proactiveAdmissionCount, maximumRolling24HourAdmissions, attentionAdmissionProjectionValid: admissionProjection.valid,
      proactiveRatedMessages: proactiveFeedback.length,
      proactiveFeedbackCoverageRatio: ratio(proactiveFeedback.length, proactiveAccepted) ?? 0,
      proactiveByKind,
      proactiveGoodResponseRatio: ratio(proactivePositive, proactiveAccepted) ?? 0,
      proactiveObviousOrAnnoyingResponseRatio: ratio(proactiveNegative, proactiveAccepted) ?? 0,
      proactiveRatedGoodResponseRatio: ratio(proactivePositive, proactiveRatedNonNeutral),
      proactiveRatedObviousOrAnnoyingRatio: ratio(proactiveNegative, proactiveRatedNonNeutral),
      tenureMonths,
      promises: {
        due, completed: promiseRows.completed ?? 0, released: promiseRows.released ?? 0,
        overdue: promiseRows.overdue ?? 0, accepted: promiseRows.accepted ?? 0,
      },
      consequentialEffects: {
        total: consequentialTotal, notStarted: effectRows.not_started ?? 0, confirmed: effectRows.confirmed ?? 0, accepted: effectRows.accepted ?? 0,
        failed: effectRows.failed ?? 0, uncertain: effectRows.uncertain ?? 0,
      },
    };
  }

  asJson(feedback: MemberOutcomeFeedback): JsonValue {
    return {
      recorded: true, feedbackId: feedback.id, kind: feedback.kind, contextAdvantage: feedback.contextAdvantage,
    } as unknown as JsonObject;
  }

  private fromRow(row: Row): MemberOutcomeFeedback {
    return {
      id: String(row.id), tenantId: String(row.tenant_id), sessionId: String(row.session_id),
      targetMessageId: String(row.target_message_id), sourceEventId: String(row.source_event_id),
      kind: outcomeKind(String(row.kind)), contextAdvantage: contextAdvantage(String(row.context_advantage)),
      observedAt: String(row.observed_at ?? row.created_at), proactive: typeof row.proactive_at === "string",
      ...(typeof row.proactive_at === "string" ? { proactiveAt: row.proactive_at } : {}),
      createdAt: String(row.created_at),
    };
  }
}
