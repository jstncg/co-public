import { stableId } from "./id.ts";
import type { SqliteStore } from "./store.ts";

type Row = Record<string, string | number | bigint | null | Uint8Array>;

export type OutcomeLearningDisposition = "none" | "positive" | "suppress";
export type OutcomeLearningKind = "useful_surprise" | "useful" | "obvious" | "annoying" | "neutral";

export interface OutcomeLearningSignal {
  disposition: OutcomeLearningDisposition;
  feedbackId?: string;
  interventionId?: string;
  topicKey?: string;
  hypothesisId?: string;
  goalId?: string;
  motiveHypothesisId?: string;
  kind?: OutcomeLearningKind;
  sourceEventId?: string;
}

export interface GoalMotiveOutcomeSink {
  recordMotiveOutcome(input: {
    tenantId: string;
    feedbackId: string;
    targetMessageId: string;
    sourceEventId: string;
    kind: OutcomeLearningKind;
    motiveHypothesisId: string;
  }): { goalId: string; motiveHypothesisId: string; retiredFromAttention: boolean };
}

interface FeedbackReference {
  id: string;
  tenantId: string;
  targetMessageId: string;
  sourceEventId: string;
  kind: OutcomeLearningKind;
}

function disposition(kind: OutcomeLearningKind): OutcomeLearningDisposition {
  if (kind === "annoying" || kind === "obvious") return "suppress";
  if (kind === "useful" || kind === "useful_surprise") return "positive";
  return "none";
}

function learningKind(value: unknown): OutcomeLearningKind {
  if (value === "useful_surprise" || value === "useful" || value === "obvious" || value === "annoying" || value === "neutral") return value;
  throw new Error(`Corrupt member outcome kind: ${String(value)}`);
}

/**
 * Turns authenticated member outcome statements into a narrow, reversible
 * attention-policy input and a private correction signal for an exactly linked
 * goal-motive hypothesis. The canonical feedback and delivery history remain
 * append-only; this class derives the current attention view on every read so
 * a later correction supersedes behavior without erasing the earlier statement.
 *
 * This service deliberately cannot grant authority, raise scores, increase an
 * interruption budget, mutate prompts, or publish a learned skill.
 */
export class OutcomeLearner {
  readonly store: SqliteStore;
  private readonly goalMotives: GoalMotiveOutcomeSink | undefined;

  constructor(store: SqliteStore, goalMotives?: GoalMotiveOutcomeSink) {
    this.store = store;
    this.goalMotives = goalMotives;
  }

  /** Record whether a verified feedback statement can be causally traced to a
   * proactively delivered intervention. Unlinked conversational feedback is
   * still measured, but cannot silently affect the attention policy. */
  record(feedback: FeedbackReference): OutcomeLearningSignal {
    const canonical = this.store.db.prepare(`SELECT target_message_id,source_event_id,kind
      FROM member_outcome_feedback WHERE tenant_id=? AND id=?`).get(feedback.tenantId, feedback.id) as Row | undefined;
    if (!canonical || String(canonical.target_message_id) !== feedback.targetMessageId
      || String(canonical.source_event_id) !== feedback.sourceEventId || learningKind(canonical.kind) !== feedback.kind) {
      throw new Error("Outcome learning requires the exact canonical member feedback row");
    }
    const linked = this.linkForFeedback(feedback.tenantId, feedback.id);
    const motive = this.goalMotiveLinkForFeedback(feedback.tenantId, feedback.id);
    const signal: OutcomeLearningSignal = linked || motive
      ? {
          disposition: disposition(feedback.kind), feedbackId: feedback.id,
          ...(linked ? { interventionId: linked.interventionId, topicKey: linked.topicKey } : {}),
          ...(linked?.hypothesisId ? { hypothesisId: linked.hypothesisId } : {}),
          ...(motive ? { goalId: motive.goalId, motiveHypothesisId: motive.motiveHypothesisId } : {}),
          kind: feedback.kind, sourceEventId: feedback.sourceEventId,
        }
      : { disposition: "none", feedbackId: feedback.id, kind: feedback.kind, sourceEventId: feedback.sourceEventId };
    this.store.appendEvent({
      id: stableId("evt", `outcome-learning:${feedback.tenantId}:${feedback.id}`),
      tenantId: feedback.tenantId,
      stream: linked ? `attention:${linked.topicKey}` : motive ? `goal:${motive.goalId}` : `session-outcome:${feedback.targetMessageId}`,
      type: "product.outcome_learning_recorded",
      causationId: feedback.sourceEventId,
      ...(linked ? { correlationId: `intervention:${linked.interventionId}` } : {}),
      payload: {
        feedbackId: feedback.id,
        targetMessageId: feedback.targetMessageId,
        kind: feedback.kind,
        disposition: signal.disposition,
        appliedToAttentionPolicy: Boolean(linked),
        appliedToGoalMotive: Boolean(motive && this.goalMotives),
        interventionId: linked?.interventionId ?? null,
        topicKey: linked?.topicKey ?? null,
        hypothesisId: linked?.hypothesisId ?? null,
        goalId: motive?.goalId ?? null,
        motiveHypothesisId: motive?.motiveHypothesisId ?? null,
      },
    });
    if (motive && this.goalMotives) this.goalMotives.recordMotiveOutcome({
      tenantId: feedback.tenantId, feedbackId: feedback.id, targetMessageId: feedback.targetMessageId,
      sourceEventId: feedback.sourceEventId, kind: feedback.kind, motiveHypothesisId: motive.motiveHypothesisId,
    });
    return signal;
  }

  /** Return only the newest owner classification for previously delivered
   * interventions with this exact tenant and topic. Positive outcomes are
   * observable but intentionally do not relax any attention threshold. */
  guidance(tenantId: string, topicKey: string): OutcomeLearningSignal {
    const row = this.store.db.prepare(`WITH ranked_feedback AS (
      SELECT f.id,f.tenant_id,f.target_message_id,f.source_event_id,f.kind,
        COALESCE(source.rowid,0) AS source_rowid,
        ROW_NUMBER() OVER (
          PARTITION BY f.target_message_id
          ORDER BY COALESCE(source.rowid,0) DESC,f.created_at DESC,f.id DESC
        ) AS current_rank
      FROM member_outcome_feedback f
      LEFT JOIN messages source
        ON source.tenant_id=f.tenant_id AND source.session_id=f.session_id AND source.event_id=f.source_event_id
      WHERE f.tenant_id=?
    )
    SELECT f.id AS feedback_id,f.source_event_id,f.kind,
      intervention.id AS intervention_id,intervention.topic_key,intervention.hypothesis_id
    FROM ranked_feedback f
    JOIN messages target
      ON target.tenant_id=f.tenant_id AND target.id=f.target_message_id AND target.role='assistant'
    JOIN events acceptance
      ON acceptance.tenant_id=f.tenant_id AND acceptance.id=target.event_id
      AND acceptance.type='message.delivery_accepted'
    JOIN outbound_deliveries delivery
      ON delivery.tenant_id=f.tenant_id AND delivery.acceptance_event_id=acceptance.id
      AND delivery.intent_id=acceptance.causation_id AND delivery.state='accepted'
    JOIN interventions intervention
      ON intervention.tenant_id=f.tenant_id
      AND acceptance.correlation_id='intervention:' || intervention.id
    WHERE f.current_rank=1 AND intervention.topic_key=?
    ORDER BY f.source_rowid DESC,f.id DESC LIMIT 1`).get(tenantId, topicKey) as Row | undefined;
    if (!row) return { disposition: "none" };
    const kind = learningKind(row.kind);
    const hypothesisId = row.hypothesis_id === null ? undefined : String(row.hypothesis_id);
    return {
      disposition: disposition(kind),
      feedbackId: String(row.feedback_id),
      interventionId: String(row.intervention_id),
      topicKey: String(row.topic_key),
      ...(hypothesisId ? { hypothesisId } : {}),
      kind,
      sourceEventId: String(row.source_event_id),
    };
  }

  private linkForFeedback(tenantId: string, feedbackId: string): {
    interventionId: string;
    topicKey: string;
    hypothesisId?: string;
  } | undefined {
    const row = this.store.db.prepare(`SELECT intervention.id AS intervention_id,
      intervention.topic_key,intervention.hypothesis_id
    FROM member_outcome_feedback feedback
    JOIN messages target
      ON target.tenant_id=feedback.tenant_id AND target.id=feedback.target_message_id AND target.role='assistant'
    JOIN events acceptance
      ON acceptance.tenant_id=feedback.tenant_id AND acceptance.id=target.event_id
      AND acceptance.type='message.delivery_accepted'
    JOIN outbound_deliveries delivery
      ON delivery.tenant_id=feedback.tenant_id AND delivery.acceptance_event_id=acceptance.id
      AND delivery.intent_id=acceptance.causation_id AND delivery.state='accepted'
    JOIN interventions intervention
      ON intervention.tenant_id=feedback.tenant_id
      AND acceptance.correlation_id='intervention:' || intervention.id
    WHERE feedback.tenant_id=? AND feedback.id=? LIMIT 1`).get(tenantId, feedbackId) as Row | undefined;
    if (!row) return undefined;
    const hypothesisId = row.hypothesis_id === null ? undefined : String(row.hypothesis_id);
    return {
      interventionId: String(row.intervention_id), topicKey: String(row.topic_key),
      ...(hypothesisId ? { hypothesisId } : {}),
    };
  }

  private goalMotiveLinkForFeedback(tenantId: string, feedbackId: string): {
    goalId: string;
    motiveHypothesisId: string;
  } | undefined {
    const row = this.store.db.prepare(`SELECT check_.goal_id,check_.motive_hypothesis_id
      FROM member_outcome_feedback feedback
      JOIN messages target
        ON target.tenant_id=feedback.tenant_id AND target.id=feedback.target_message_id AND target.role='assistant'
      JOIN events acceptance
        ON acceptance.tenant_id=feedback.tenant_id AND acceptance.id=target.event_id
        AND acceptance.type='message.delivery_accepted'
      JOIN outbound_deliveries delivery
        ON delivery.tenant_id=feedback.tenant_id AND delivery.acceptance_event_id=acceptance.id
        AND delivery.intent_id=acceptance.causation_id AND delivery.state='accepted'
      JOIN goal_reality_checks check_
        ON check_.tenant_id=feedback.tenant_id AND check_.message_id=target.id
        AND check_.acceptance_event_id=acceptance.id AND check_.motive_hypothesis_id IS NOT NULL
      WHERE feedback.tenant_id=? AND feedback.id=? LIMIT 1`).get(tenantId, feedbackId) as Row | undefined;
    return row ? { goalId: String(row.goal_id), motiveHypothesisId: String(row.motive_hypothesis_id) } : undefined;
  }
}
