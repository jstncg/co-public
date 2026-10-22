import {
  assembleTemporalContext,
  candidateFromSynthesis,
  decideAwareness,
  type AwarenessEvidence,
} from "@co/awareness";
import {
  contextEventTaskPayloadSchema,
  featureFlagsFromEnvironment,
  harnessAgentOutputSchema,
  type ContextEventTaskPayload,
} from "@co/contracts";
import { task } from "@trigger.dev/sdk/v3";
import {
  awarenessProviderFromEnvironment,
  buildAwarenessCollaborationRequest,
} from "../lib/awareness-preset";
import { loadContextEvidence } from "../lib/context-evidence";
import { serviceDb, type Db } from "../lib/db";
import { runCollaborationV1 } from "./collaboration-run-v1";

export type { ContextEventTaskPayload };

type ContextEventRow = {
  id: string;
  user_id: string;
  resource_type: "message" | "calendar_item" | "email_item";
  state: string;
  attempts: number;
  evaluate_after: string;
};

type DurableSignalRow = {
  id: string;
  statement: string;
  subject_relation: AwarenessEvidence["subjectRelation"];
  confidence: number;
  sensitivity: AwarenessEvidence["sensitivity"];
  created_at: string;
};

type ContextEventDependencies = {
  db?: Db;
  environment?: Record<string, string | undefined>;
  now?: () => Date;
  collaborate?: typeof runCollaborationV1;
};

const ASSEMBLER_VERSION = "temporal-context.v1";
const POLICY_VERSION = "ambient-awareness.v1";

async function updateEvent(
  db: Db,
  eventId: string,
  userId: string,
  values: Record<string, unknown>,
) {
  const result = await db.from("context_events").update(values)
    .eq("id", eventId).eq("user_id", userId);
  if (result.error) throw result.error;
}

async function upsertEvaluation(input: {
  db: Db;
  userId: string;
  eventId: string;
  snapshotId: string;
  decision: "record_only" | "defer" | "collaborate" | "hold";
  reason: string;
  runId?: string | null;
  nextEvaluationAt?: Date | null;
  now: Date;
}) {
  const result = await input.db.from("awareness_evaluations").upsert({
    user_id: input.userId,
    trigger_event_id: input.eventId,
    snapshot_id: input.snapshotId,
    decision: input.decision,
    reason_code: input.reason,
    collaboration_run_id: input.runId ?? null,
    next_evaluation_at: input.nextEvaluationAt?.toISOString() ?? null,
    policy_version: POLICY_VERSION,
    created_at: input.now.toISOString(),
  }, { onConflict: "trigger_event_id" }).select("id").single<{ id: string }>();
  if (result.error) throw result.error;
  return result.data.id;
}

async function candidateContextEventIds(db: Db, userId: string, now: Date) {
  const past = new Date(now.getTime() - 48 * 60 * 60 * 1_000).toISOString();
  const future = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1_000).toISOString();
  const [recent, effective] = await Promise.all([
    db.from("context_events").select("id")
      .eq("user_id", userId).neq("state", "superseded")
      .gte("occurred_at", past).lte("occurred_at", now.toISOString())
      .order("occurred_at", { ascending: false }).limit(100),
    db.from("context_events").select("id")
      .eq("user_id", userId).neq("state", "superseded")
      .lte("effective_from", future).gte("effective_to", past)
      .order("effective_from", { ascending: true }).limit(100),
  ]);
  if (recent.error) throw recent.error;
  if (effective.error) throw effective.error;
  return [...new Set([
    ...(recent.data ?? []).map((row) => String(row.id)),
    ...(effective.data ?? []).map((row) => String(row.id)),
  ])].slice(0, 150);
}

async function durableSignals(
  db: Db,
  userId: string,
  query: string,
): Promise<AwarenessEvidence[]> {
  const result = await db.rpc("search_awareness_signals", {
    p_user_id: userId,
    p_query: query.slice(0, 8_000),
    p_limit: 100,
  });
  if (result.error) throw result.error;
  return ((result.data ?? []) as DurableSignalRow[]).map((row) => ({
    evidenceType: "signal" as const,
    id: String(row.id),
    text: String(row.statement).slice(0, 2_000),
    sourceKind: "memory" as const,
    occurredAt: String(row.created_at),
    effectiveFrom: null,
    effectiveTo: null,
    eventKind: null,
    analysisAllowed: true,
    sensitivity: row.sensitivity,
    confidence: Number(row.confidence),
    subjectRelation: row.subject_relation,
  }));
}

export async function runContextEventV1(
  unknownPayload: unknown,
  dependencies: ContextEventDependencies = {},
) {
  const payload = contextEventTaskPayloadSchema.parse(unknownPayload);
  const db = dependencies.db ?? serviceDb();
  const environment = dependencies.environment ?? process.env;
  const now = (dependencies.now ?? (() => new Date()))();
  let eventId = payload.eventId;

  if (payload.messageId) {
    const recorded = await db.rpc("record_message_context_event", {
      p_user_id: payload.userId,
      p_message_id: payload.messageId,
      p_direction: payload.messageDirection,
    });
    if (recorded.error) throw recorded.error;
    eventId = String(recorded.data);
  }
  if (!eventId) throw new Error("context event target was not resolved");

  const loaded = await db.from("context_events")
    .select("id,user_id,resource_type,state,attempts,evaluate_after")
    .eq("id", eventId).eq("user_id", payload.userId)
    .maybeSingle<ContextEventRow>();
  if (loaded.error) throw loaded.error;
  if (!loaded.data) throw new Error("context event unavailable");
  const event = loaded.data;
  if (["evaluated", "ignored", "superseded"].includes(event.state)) {
    return { eventId, state: event.state, deduped: true };
  }
  if (Date.parse(event.evaluate_after) > now.getTime()) {
    if (event.state === "processing") {
      await updateEvent(db, eventId, payload.userId, { state: "deferred", leased_at: null });
    }
    return { eventId, state: "deferred", deduped: false };
  }
  if (!featureFlagsFromEnvironment(environment).ambient_awareness) {
    await updateEvent(db, eventId, payload.userId, {
      state: "queued",
      leased_at: null,
    });
    return { eventId, state: "disabled", deduped: false };
  }
  const attempt = event.state === "processing"
    ? event.attempts
    : Math.min(event.attempts + 1, 10);
  if (event.state !== "processing") {
    await updateEvent(db, eventId, payload.userId, {
      state: "processing",
      leased_at: now.toISOString(),
      attempts: attempt,
    });
  }

  try {
    const triggerResolved = await loadContextEvidence(
      db,
      payload.userId,
      [eventId],
      { allowRestricted: true, skipUnavailable: true },
    );
    if (!triggerResolved[0]) {
      await updateEvent(db, eventId, payload.userId, {
        state: "ignored",
        leased_at: null,
        completed_at: now.toISOString(),
        outcome_reason: event.resource_type === "message" ? "empty_message" : "evidence_invalidated",
      });
      return { eventId, state: "ignored", reason: "evidence_unavailable" };
    }
    const triggerEvidence = triggerResolved[0].awareness;
    const contextIds = await candidateContextEventIds(db, payload.userId, now);
    const [context, signals] = await Promise.all([
      loadContextEvidence(db, payload.userId, contextIds, {
        allowRestricted: false,
        skipUnavailable: true,
      }),
      durableSignals(db, payload.userId, triggerEvidence.text),
    ]);
    const snapshot = assembleTemporalContext({
      trigger: triggerEvidence,
      candidates: [...context.map((item) => item.awareness), ...signals],
      now,
      maxContextEvents: 12,
      maxSignals: 8,
    });
    const windowStart = new Date(now.getTime() - 48 * 60 * 60 * 1_000);
    const windowEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1_000);
    const snapshotResult = await db.from("temporal_context_snapshots").upsert({
      user_id: payload.userId,
      trigger_event_id: eventId,
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      evidence_packet: {
        artifact_ids: [],
        segment_ids: [],
        context_event_ids: snapshot.contextEventIds,
        signal_ids: snapshot.signalIds,
      },
      source_kinds: snapshot.sourceKinds,
      reason_codes: snapshot.reasonCodes,
      context_count: snapshot.contextEventIds.length + snapshot.signalIds.length,
      assembler_version: ASSEMBLER_VERSION,
    }, { onConflict: "trigger_event_id,assembler_version" })
      .select("id").single<{ id: string }>();
    if (snapshotResult.error) throw snapshotResult.error;

    const latest = await db.from("awareness_evaluations").select("created_at")
      .eq("user_id", payload.userId).eq("decision", "collaborate")
      .not("collaboration_run_id", "is", null)
      .order("created_at", { ascending: false }).limit(1)
      .maybeSingle<{ created_at: string }>();
    if (latest.error) throw latest.error;
    const decision = decideAwareness({
      snapshot,
      now,
      lastCollaborationAt: latest.data ? new Date(latest.data.created_at) : null,
    });

    if (decision.decision !== "collaborate") {
      await upsertEvaluation({
        db,
        userId: payload.userId,
        eventId,
        snapshotId: snapshotResult.data.id,
        decision: decision.decision,
        reason: decision.reason,
        nextEvaluationAt: decision.nextEvaluationAt,
        now,
      });
      await updateEvent(db, eventId, payload.userId, {
        state: decision.decision === "defer" ? "deferred"
          : decision.decision === "hold" ? "ignored"
            : "evaluated",
        evaluate_after: decision.nextEvaluationAt?.toISOString() ?? now.toISOString(),
        leased_at: null,
        completed_at: decision.decision === "defer" ? null : now.toISOString(),
        outcome_reason: decision.reason,
      });
      return { eventId, state: decision.decision, reason: decision.reason };
    }

    const provider = awarenessProviderFromEnvironment(environment);
    if (!provider) {
      await upsertEvaluation({
        db,
        userId: payload.userId,
        eventId,
        snapshotId: snapshotResult.data.id,
        decision: "record_only",
        reason: "model_not_configured",
        now,
      });
      await updateEvent(db, eventId, payload.userId, {
        state: "evaluated",
        leased_at: null,
        completed_at: now.toISOString(),
        outcome_reason: "model_not_configured",
      });
      return { eventId, state: "record_only", reason: "model_not_configured" };
    }

    const request = buildAwarenessCollaborationRequest({
      userId: payload.userId,
      triggerEventId: eventId,
      contextEventIds: snapshot.contextEventIds,
      signalIds: snapshot.signalIds,
      provider,
      fastModel: environment.MODEL_FAST!,
      reasoningModel: environment.MODEL_REASONING!,
      evaluatedAt: now.toISOString(),
    });
    const run = await (dependencies.collaborate ?? runCollaborationV1)(request);
    const evaluationId = await upsertEvaluation({
      db,
      userId: payload.userId,
      eventId,
      snapshotId: snapshotResult.data.id,
      decision: "collaborate",
      reason: decision.reason,
      runId: run.runId,
      now,
    });

    let candidate = null;
    if (run.state === "succeeded") {
      const synthesisTask = await db.from("collaboration_tasks").select("id")
        .eq("user_id", payload.userId).eq("run_id", run.runId)
        .eq("agent_id", "synthesis").maybeSingle<{ id: string }>();
      if (synthesisTask.error) throw synthesisTask.error;
      if (synthesisTask.data) {
        const result = await db.from("collaboration_results").select("output")
          .eq("user_id", payload.userId).eq("task_id", synthesisTask.data.id)
          .maybeSingle<{ output: unknown }>();
        if (result.error) throw result.error;
        if (result.data) {
          candidate = candidateFromSynthesis(harnessAgentOutputSchema.parse(result.data.output));
        }
      }
    }

    if (candidate) {
      const inserted = await db.from("awareness_candidates").upsert({
        user_id: payload.userId,
        evaluation_id: evaluationId,
        snapshot_id: snapshotResult.data.id,
        collaboration_run_id: run.runId,
        proposed_copy: candidate.proposedCopy,
        confidence: candidate.confidence,
        citation_ids: candidate.citations,
        sensitivity: "medium",
        status: "review",
        requires_review: true,
        not_before: now.toISOString(),
        expires_at: new Date(now.getTime() + 48 * 60 * 60 * 1_000).toISOString(),
      }, { onConflict: "evaluation_id" });
      if (inserted.error) throw inserted.error;
    }
    const outcome = candidate ? "candidate_created" : "no_supported_finding";
    await updateEvent(db, eventId, payload.userId, {
      state: "evaluated",
      leased_at: null,
      completed_at: now.toISOString(),
      outcome_reason: outcome,
    });
    return { eventId, state: "evaluated", reason: outcome, runId: run.runId };
  } catch (error) {
    const exhausted = attempt >= 10;
    await updateEvent(db, eventId, payload.userId, {
      state: exhausted ? "ignored" : "failed_safe",
      leased_at: null,
      evaluate_after: new Date(now.getTime() + 5 * 60 * 1_000).toISOString(),
      completed_at: exhausted ? now.toISOString() : null,
      outcome_reason: exhausted ? "retry_exhausted" : null,
    });
    return {
      eventId,
      state: exhausted ? "retry_exhausted" as const : "failed_safe" as const,
      errorClass: error instanceof Error ? error.name : "unknown",
    };
  }
}

export const contextEventV1 = task({
  id: "context-event-v1",
  maxDuration: 900,
  run: async (payload: unknown) => runContextEventV1(payload),
});
