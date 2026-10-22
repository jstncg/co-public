import { id, nowIso } from "./id.ts";
import type { RuntimeConfig } from "./types.ts";
import type { SqliteStore } from "./store.ts";
import { KnownnessGate, type KnownnessDecision } from "./knownness.ts";
import { OutcomeLearner } from "./outcome-learner.ts";
import { InquiryManager } from "./inquiries.ts";

export const OWNER_OUTCOME_URGENT_OVERRIDE = "owner outcome suppression overridden only for an urgent, evidenced material change";

export function ownerOutcomeSuppressionReason(kind: string | undefined): string {
  return `owner outcome gate: the last delivered intervention on this exact topic was ${kind ?? "negatively rated"}`;
}

export interface AttentionSignal {
  kind?: "operational" | "perceptual";
  sourceEventId: string;
  hypothesisId?: string;
  /** Runtime-issued foreground decision; never supplied by source content. */
  inquiryDecisionId?: string;
  topicKey: string;
  evidence: number;
  novelty: number;
  urgency: number;
  usefulness: number;
  actionability: number;
  confidence: number;
  interruptionCost: number;
  perceptualValue?: number;
  specificity?: number;
  temporalBreadth?: number;
  genericity?: number;
  sensitivity?: number;
  content: string;
  /** Optional result from a bounded backstage semantic comparison. Local exact/conflict evidence always wins. */
  verifiedKnownness?: KnownnessDecision;
  channel?: string;
  peerId?: string;
}

export interface AttentionDecision {
  send: boolean;
  score: number;
  reason: string;
  knownness: KnownnessDecision;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function attentionSignalScore(signal: AttentionSignal): number {
  const kind = signal.kind ?? "operational";
  return kind === "perceptual"
    ? clamp(
      clamp(signal.perceptualValue ?? 0) * 0.24 + clamp(signal.novelty) * 0.14 + clamp(signal.specificity ?? 0) * 0.15 +
      clamp(signal.confidence) * 0.12 + clamp(signal.temporalBreadth ?? 0) * 0.1 + clamp(signal.evidence / 3) * 0.08 +
      clamp(signal.usefulness) * 0.12 - clamp(signal.genericity ?? 1) * 0.18 - clamp(signal.interruptionCost) * 0.18 -
      clamp(signal.sensitivity ?? 0) * 0.08,
    )
    : clamp(
      clamp(signal.usefulness) * 0.26 + clamp(signal.urgency) * 0.18 + clamp(signal.actionability) * 0.16 +
      clamp(signal.novelty) * 0.14 + clamp(signal.confidence) * 0.16 + clamp(signal.evidence / 3) * 0.1 -
      clamp(signal.interruptionCost) * 0.24,
    );
}

/** Content-only preflight used to avoid semantic calls for candidates that
 * cannot clear the attention bar regardless of knownness or live policy. */
export function attentionSignalClearsContentBar(signal: AttentionSignal): boolean {
  const kind = signal.kind ?? "operational";
  const score = attentionSignalScore(signal);
  return kind === "perceptual"
    ? score >= 0.68 && signal.evidence >= 3 && signal.confidence >= 0.72 && (signal.specificity ?? 0) >= 0.68 &&
      (signal.genericity ?? 1) <= 0.35 && (signal.sensitivity ?? 0) <= 0.7 && signal.content.trim().length > 0
    : score >= 0.62 && signal.evidence >= 1 && signal.confidence >= 0.55 && signal.content.trim().length > 0;
}

function localHour(timezone: string, at = new Date()): number {
  const hour = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone }).format(at);
  return Number.parseInt(hour, 10) % 24;
}

function quiet(hour: number, start: number, end: number): boolean {
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

function afterQuietHours(timezone: string, start: number, end: number, from = new Date()): string {
  for (let minutes = 15; minutes <= 26 * 60; minutes += 15) {
    const candidate = new Date(from.getTime() + minutes * 60_000);
    if (!quiet(localHour(timezone, candidate), start, end)) return candidate.toISOString();
  }
  return new Date(from.getTime() + 26 * 60 * 60_000).toISOString();
}

function later(left: string | undefined, right: string): string {
  return !left || right > left ? right : left;
}

export class AttentionGate {
  readonly config: RuntimeConfig;
  readonly store: SqliteStore;
  readonly knownness: KnownnessGate;
  readonly outcomeLearner: OutcomeLearner;

  constructor(config: RuntimeConfig, store: SqliteStore, outcomeLearner = new OutcomeLearner(store)) {
    this.config = config;
    this.store = store;
    this.knownness = new KnownnessGate(store);
    this.outcomeLearner = outcomeLearner;
  }

  evaluate(tenantId: string, signal: AttentionSignal): AttentionDecision {
    const kind = signal.kind ?? "operational";
    const score = attentionSignalScore(signal);
    const evaluatedAt = new Date();
    const hour = localHour(this.config.timezone, evaluatedAt);
    return this.store.transaction(() => {
      const inquiryValidity = signal.inquiryDecisionId
        ? new InquiryManager(this.store).deliveryValidity(tenantId, signal.inquiryDecisionId, signal.sourceEventId) : undefined;
      const localKnownness = this.knownness.evaluate(tenantId, signal.content, signal.sourceEventId, signal.novelty);
      const semanticKnownness = signal.verifiedKnownness;
      const knownness = localKnownness.status === "known" || localKnownness.polarityConflict
        ? localKnownness
        : semanticKnownness?.status === "known" || semanticKnownness?.polarityConflict
          ? semanticKnownness
          : localKnownness.status === "uncertain" && semanticKnownness
            ? semanticKnownness
            : localKnownness;
      let send = attentionSignalClearsContentBar(signal);
      let reason = send
        ? kind === "perceptual" ? "mature, specific longitudinal insight worth the interruption" : "specific, evidence-bearing, useful, and worth the interruption"
        : kind === "perceptual" ? "perception remained too weak, generic, or interruptive to surface" : "did not clear the evidence/usefulness/interruption threshold";

      if (send && knownness.status === "known") {
        send = false;
        reason = `knownness gate: ${knownness.reason}`;
      } else if (send && knownness.polarityConflict) {
        send = false;
        reason = `knownness gate: ${knownness.reason}`;
      } else if (send && knownness.status === "uncertain" && (kind === "perceptual" || semanticKnownness !== undefined || knownness.score >= 0.78)) {
        send = false;
        reason = `knownness gate: ${knownness.reason}`;
      }

      const learned = this.outcomeLearner.guidance(tenantId, signal.topicKey);
      if (send && learned.disposition === "suppress") {
        const urgentMaterialChange = kind === "operational" && signal.urgency >= 0.95 && signal.evidence >= 2 && signal.novelty >= 0.8;
        if (!urgentMaterialChange) {
          send = false;
          reason = ownerOutcomeSuppressionReason(learned.kind);
        } else {
          reason = `${reason}; ${OWNER_OUTCOME_URGENT_OVERRIDE}`;
        }
      }

      let holdUntil: string | undefined;
      if (send && quiet(hour, this.config.autonomy.quietHoursStart, this.config.autonomy.quietHoursEnd) && signal.urgency < 0.9) {
        send = false;
        reason = "temporary attention hold: quiet hours; not urgent enough to interrupt";
        holdUntil = afterQuietHours(this.config.timezone, this.config.autonomy.quietHoursStart, this.config.autonomy.quietHoursEnd, evaluatedAt);
      }
      const sinceDay = new Date(evaluatedAt.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const daily = this.store.db.prepare(`SELECT COUNT(*) AS count,MIN(COALESCE(attention_reserved_at,accepted_at,sent_at,created_at)) AS oldest
        FROM interventions WHERE tenant_id=? AND decision='send'
          AND COALESCE(attention_reserved_at,accepted_at,sent_at,created_at)>=?`)
        .get(tenantId, sinceDay) as { count: number; oldest: string | null };
      if (send && Number(daily.count) >= this.config.autonomy.maxDailyInterventions) {
        send = false;
        reason = "temporary attention hold: daily attention budget exhausted";
        holdUntil = later(holdUntil, new Date(Date.parse(daily.oldest ?? nowIso()) + 24 * 60 * 60_000 + 1_000).toISOString());
      }
      const priorHypothesis = kind === "perceptual" && signal.hypothesisId
        ? this.store.db.prepare("SELECT id FROM interventions WHERE tenant_id=? AND hypothesis_id=? AND decision IN ('send','held') LIMIT 1")
          .get(tenantId, signal.hypothesisId) as { id: string } | undefined
        : undefined;
      if (send && priorHypothesis) {
        send = false;
        reason = "hypothesis was already queued or held; do not repeat it automatically";
      }
      const cooldownSince = new Date(evaluatedAt.getTime() - this.config.autonomy.interventionCooldownMinutes * 60_000).toISOString();
      const recent = this.store.db.prepare(`SELECT id,COALESCE(attention_reserved_at,accepted_at,sent_at,created_at) AS admitted_at
        FROM interventions WHERE tenant_id=? AND topic_key=? AND decision='send'
          AND COALESCE(attention_reserved_at,accepted_at,sent_at,created_at)>=?
        ORDER BY COALESCE(attention_reserved_at,accepted_at,sent_at,created_at) DESC LIMIT 1`)
        .get(tenantId, signal.topicKey, cooldownSince) as { id: string; admitted_at: string } | undefined;
      if (send && recent) {
        send = false;
        reason = "temporary attention hold: same-topic cooldown; avoid repeating the intervention";
        holdUntil = later(holdUntil, new Date(Date.parse(recent.admitted_at) + this.config.autonomy.interventionCooldownMinutes * 60_000 + 1_000).toISOString());
      }

      if (inquiryValidity && (!inquiryValidity.authorized || !inquiryValidity.fresh)) {
        send = false;
        holdUntil = undefined;
        reason = inquiryValidity.reason;
      }
      const decision = send ? "send" : holdUntil ? "held" : "silence";
      this.store.db.prepare(`INSERT INTO interventions(id,tenant_id,source_event_id,hypothesis_id,inquiry_decision_id,topic_key,score,urgency,decision,reason,content,channel,peer_id,next_attempt_at,created_at,attention_reserved_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id("int"), tenantId, signal.sourceEventId, signal.hypothesisId ?? null, signal.inquiryDecisionId ?? null, signal.topicKey, score, clamp(signal.urgency), decision, reason,
        signal.content || null, signal.channel ?? null, signal.peerId ?? null, holdUntil ?? null, nowIso(), send ? evaluatedAt.toISOString() : null,
      );
      this.store.appendEvent({ tenantId, stream: `attention:${signal.topicKey}`, type: send ? "intervention.queued" : holdUntil ? "intervention.held" : "intervention.suppressed", causationId: signal.sourceEventId, payload: { score, reason, topicKey: signal.topicKey, content: signal.content, kind, hypothesisId: signal.hypothesisId ?? null, nextAttemptAt: holdUntil ?? null, knownness: { status: knownness.status, score: knownness.score, reason: knownness.reason, matchedSourceEventId: knownness.matchedSourceEventId ?? null }, outcomeLearning: { disposition: learned.disposition, feedbackId: learned.feedbackId ?? null, interventionId: learned.interventionId ?? null, kind: learned.kind ?? null } } });
      return { send, score, reason, knownness };
    });
  }

  suppressInvalidInquiry(tenantId: string, interventionId: string): boolean {
    return this.store.transaction(() => {
      const row = this.store.db.prepare(`SELECT inquiry_decision_id,source_event_id,topic_key FROM interventions
        WHERE tenant_id=? AND id=? AND accepted_at IS NULL AND decision IN ('send','held')`)
        .get(tenantId, interventionId) as { inquiry_decision_id: string | null; source_event_id: string; topic_key: string } | undefined;
      if (!row?.inquiry_decision_id) return false;
      const validity = new InquiryManager(this.store).deliveryValidity(tenantId, row.inquiry_decision_id, row.source_event_id);
      if (validity.authorized && validity.fresh) return false;
      this.store.db.prepare(`UPDATE interventions SET decision='silence',reason=?,next_attempt_at=NULL,attention_reserved_at=NULL
        WHERE tenant_id=? AND id=?`).run(validity.reason, tenantId, interventionId);
      this.store.appendEvent({ tenantId, stream: `attention:${row.topic_key}`, type: "intervention.suppressed",
        causationId: row.source_event_id, payload: { interventionId, inquiryDecisionId: row.inquiry_decision_id, reason: validity.reason } });
      return true;
    });
  }

  /** Reconsider one time-held intervention without regenerating its content.
   * Permanent suppressions and delivery failures have no due time and are never
   * promoted by this path. */
  reactivateOneDue(tenantId: string): boolean {
    return this.store.transaction(() => {
      const current = new Date();
      const currentIso = current.toISOString();
      const row = this.store.db.prepare(`SELECT id,topic_key,source_event_id,hypothesis_id,content FROM interventions
        WHERE tenant_id=? AND decision='held' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?
          AND reason LIKE 'temporary attention hold:%'
        ORDER BY next_attempt_at,created_at LIMIT 1`).get(tenantId, currentIso) as {
          id: string; topic_key: string; source_event_id: string; hypothesis_id: string | null; content: string | null;
      } | undefined;
      if (!row) return false;
      if (this.suppressInvalidInquiry(tenantId, row.id)) return true;
      const learned = this.outcomeLearner.guidance(tenantId, row.topic_key);
      if (learned.disposition === "suppress") {
        const reason = ownerOutcomeSuppressionReason(learned.kind);
        const changed = this.store.db.prepare(`UPDATE interventions SET decision='silence',reason=?,next_attempt_at=NULL
          WHERE tenant_id=? AND id=? AND decision='held'`).run(reason, tenantId, row.id);
        if (changed.changes !== 1) return false;
        this.store.appendEvent({
          tenantId, stream: `attention:${row.topic_key}`, type: "intervention.suppressed",
          causationId: learned.sourceEventId ?? row.source_event_id,
          payload: {
            interventionId: row.id, topicKey: row.topic_key, reason,
            outcomeLearning: { disposition: learned.disposition, feedbackId: learned.feedbackId ?? null, kind: learned.kind ?? null },
          },
        });
        return true;
      }
      const knownness = this.knownness.evaluate(tenantId, String(row.content ?? ""), row.source_event_id, 1);
      if (knownness.status === "uncertain" && knownness.reason.includes("retrieval failed")) {
        const nextAttemptAt = new Date(current.getTime() + 15 * 60_000).toISOString();
        this.store.db.prepare(`UPDATE interventions SET reason=?,next_attempt_at=?
          WHERE tenant_id=? AND id=? AND decision='held'`).run(
          `temporary attention hold: held intervention revalidation failed; ${knownness.reason}`, nextAttemptAt, tenantId, row.id,
        );
        return true;
      }
      if (knownness.status === "known" || knownness.polarityConflict
        || ((row.hypothesis_id || knownness.score >= 0.78) && knownness.status === "uncertain")) {
        const reason = `held intervention revalidation: ${knownness.reason}`;
        const changed = this.store.db.prepare(`UPDATE interventions SET decision='silence',reason=?,next_attempt_at=NULL
          WHERE tenant_id=? AND id=? AND decision='held'`).run(reason, tenantId, row.id);
        if (changed.changes !== 1) return false;
        this.store.appendEvent({
          tenantId, stream: `attention:${row.topic_key}`, type: "intervention.suppressed",
          causationId: knownness.matchedSourceEventId ?? row.source_event_id,
          payload: {
            interventionId: row.id, topicKey: row.topic_key, reason,
            revalidation: { knownness: knownness.status, score: knownness.score, polarityConflict: knownness.polarityConflict ?? false },
          },
        });
        return true;
      }
      let nextAttemptAt: string | undefined;
      let reason: string | undefined;
      if (quiet(localHour(this.config.timezone, current), this.config.autonomy.quietHoursStart, this.config.autonomy.quietHoursEnd)) {
        reason = "temporary attention hold: quiet hours still active";
        nextAttemptAt = afterQuietHours(this.config.timezone, this.config.autonomy.quietHoursStart, this.config.autonomy.quietHoursEnd, current);
      }
      const sinceDay = new Date(current.getTime() - 24 * 60 * 60_000).toISOString();
      const daily = this.store.db.prepare(`SELECT COUNT(*) AS count,MIN(COALESCE(attention_reserved_at,accepted_at,sent_at,created_at)) AS oldest FROM interventions
        WHERE tenant_id=? AND decision='send'
          AND COALESCE(attention_reserved_at,accepted_at,sent_at,created_at)>=? AND id<>?`).get(tenantId, sinceDay, row.id) as { count: number; oldest: string | null };
      if (Number(daily.count) >= this.config.autonomy.maxDailyInterventions) {
        reason = "temporary attention hold: daily attention budget still exhausted";
        nextAttemptAt = later(nextAttemptAt, new Date(Date.parse(daily.oldest ?? currentIso) + 24 * 60 * 60_000 + 1_000).toISOString());
      }
      const cooldownSince = new Date(current.getTime() - this.config.autonomy.interventionCooldownMinutes * 60_000).toISOString();
      const recent = this.store.db.prepare(`SELECT COALESCE(attention_reserved_at,accepted_at,sent_at,created_at) AS admitted_at FROM interventions WHERE tenant_id=? AND topic_key=?
        AND decision='send' AND COALESCE(attention_reserved_at,accepted_at,sent_at,created_at)>=? AND id<>?
        ORDER BY COALESCE(attention_reserved_at,accepted_at,sent_at,created_at) DESC LIMIT 1`)
        .get(tenantId, row.topic_key, cooldownSince, row.id) as { admitted_at: string } | undefined;
      if (recent) {
        reason = "temporary attention hold: same-topic cooldown still active";
        nextAttemptAt = later(nextAttemptAt, new Date(Date.parse(recent.admitted_at) + this.config.autonomy.interventionCooldownMinutes * 60_000 + 1_000).toISOString());
      }
      if (nextAttemptAt) {
        this.store.db.prepare("UPDATE interventions SET reason=?,next_attempt_at=? WHERE tenant_id=? AND id=? AND decision='held'")
          .run(reason ?? "temporary attention hold: release condition still active", nextAttemptAt, tenantId, row.id);
        return true;
      }
      const changed = this.store.db.prepare(`UPDATE interventions SET decision='send',reason=reason || '; reactivated when the temporary hold cleared',next_attempt_at=NULL,attention_reserved_at=?
        WHERE tenant_id=? AND id=? AND decision='held'`).run(currentIso, tenantId, row.id);
      if (changed.changes !== 1) return false;
      this.store.appendEvent({ tenantId, stream: `attention:${row.topic_key}`, type: "intervention.reactivated", causationId: row.source_event_id,
        payload: { interventionId: row.id, topicKey: row.topic_key } });
      return true;
    });
  }
}
