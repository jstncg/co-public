/**
 * per-user radar ranking (goal.md §15.6): compiled evidence → model assessment →
 * hard-requirement gates → radar_candidates. precision over recall; creepy loses to quiet.
 */
import { task } from "@trigger.dev/sdk/v3";
import { makeProvider, type EvidenceItem } from "@co/model-gateway";
import { radarTotal, type RadarAssessment, type WorldEventType } from "@co/contracts";
import { serviceDb, must } from "../lib/db";
import { sendNotification } from "./send-notification";

export interface RadarRankPayload {
  worldEventId: string;
  watchEntityId: string;
  idempotencyKey: string;
}

const SEND_THRESHOLD = Number(process.env.RADAR_SEND_THRESHOLD ?? 0.55);
const CREEPINESS_MAX = Number(process.env.RADAR_CREEPINESS_MAX ?? 0.3);
/** founder approval gates every proactive send for the first 100 users (§23/§31).
 *  opt-out is explicit and env-scoped; the default is always "a human said yes first". */
const FOUNDER_REVIEW = process.env.RADAR_FOUNDER_REVIEW !== "off";

/** the ONLY place a radar candidate becomes a push. reachable from rank (auto-approve mode)
 *  and from the founder-approval action — never from an unapproved candidate. */
async function queueRadarNotification(candidateId: string, userId: string, displayName: string, evidenceIds: string[]) {
  // lock-screen copy is non-sensitive by construction (§18): entity name only, detail in-app.
  await sendNotification.trigger(
    {
      userId,
      callbackType: "radar",
      triggerType: "watched_entity_event",
      message: `co found something relevant to "${displayName}".`,
      evidenceIds,
      idempotencyKey: `notify:${candidateId}`,
    },
    { idempotencyKey: `notify:${candidateId}` },
  );
}

/** founder review decision → the state transition that authorizes the send (§23).
 *  approving is the act of sending; there is no other path from 'review' to the lock screen. */
export async function approveRadarCandidate(candidateId: string) {
  const db = serviceDb();
  const candidate = must(
    await db.from("radar_candidates").select("id,user_id,status,why_user_json,watch_display_name").eq("id", candidateId).maybeSingle(),
    "load radar candidate",
  ) as { id: string; user_id: string; status: string; why_user_json: { evidence_ids?: string[] }; watch_display_name?: string } | null;
  if (!candidate) return { skipped: "no such candidate" };
  if (candidate.status !== "review") return { skipped: `not in review (${candidate.status})` };

  must(
    await db.from("radar_candidates").update({ status: "approved", approved_at: new Date().toISOString() }).eq("id", candidateId).select("id"),
    "approve radar candidate",
  );
  await queueRadarNotification(
    candidate.id,
    candidate.user_id,
    candidate.watch_display_name ?? "your watch",
    candidate.why_user_json?.evidence_ids ?? [],
  );
  return { approved: candidateId };
}

/** exported for tests (task() objects don't expose run outside the worker runtime). */
export async function runRadarRank(payload: RadarRankPayload) {
    const db = serviceDb();
    const watch = must(
      await db.from("watch_entities").select("*").eq("id", payload.watchEntityId).maybeSingle(),
      "load watch entity",
    ) as Record<string, unknown>;
    const event = must(
      await db.from("world_events").select("*").eq("id", payload.worldEventId).maybeSingle(),
      "load world event",
    ) as Record<string, unknown>;

    if (!watch.approved_at || watch.paused_at) return { skipped: "watch not approved or paused" };

    // idempotent + not-previously-sent gate: one candidate per (user, event)
    const existing = await db
      .from("radar_candidates")
      .select("id")
      .eq("user_id", watch.user_id as string)
      .eq("world_event_id", payload.worldEventId)
      .maybeSingle();
    if (existing.data) return { skipped: "already ranked" };

    // explicit user evidence only (§15.2): the watch approval note + watch_request annotations
    const evidence: EvidenceItem[] = [];
    const identifiers = (watch.identifiers_json ?? {}) as Record<string, string>;
    if (identifiers.relationship_note) {
      evidence.push({ id: watch.id as string, kind: "annotation", statement: identifiers.relationship_note });
    }
    const watchAnnotations = must(
      await db.from("annotations").select("id,free_text,value").eq("user_id", watch.user_id as string).eq("annotation_type", "watch_request").limit(5),
      "load watch annotations",
    ) as Array<{ id: string; free_text: string | null; value: string | null }>;
    for (const a of watchAnnotations) {
      const statement = a.free_text ?? a.value;
      if (statement) evidence.push({ id: a.id, kind: "annotation", statement });
    }

    const sentBefore = must(
      await db
        .from("radar_candidates")
        .select("world_events(title)")
        .eq("user_id", watch.user_id as string)
        .in("status", ["sent", "inbox_only"])
        .limit(20),
      "load sent history",
    ) as unknown as Array<{ world_events: { title: string } | null }>;

    const provider = makeProvider(process.env);
    const assessment: RadarAssessment = await provider.rankRadar({
      watch: {
        display_name: watch.display_name as string,
        entity_type: watch.entity_type as string,
        relationship_note: identifiers.relationship_note,
        desired_event_types: (watch.desired_event_types ?? []) as WorldEventType[],
        excluded_event_types: (watch.excluded_event_types ?? []) as WorldEventType[],
      },
      event: {
        event_type: event.event_type as WorldEventType,
        title: event.title as string,
        summary: (event.summary as string | null) ?? undefined,
        source_url: event.source_url as string,
        source_published_at: (event.source_published_at as string | null) ?? undefined,
      },
      user_evidence: evidence,
      previously_sent_summaries: sentBefore.map((s) => s.world_events?.title).filter((t): t is string => !!t),
    });

    const total = radarTotal(assessment);
    // hard requirements before any proactive send (§15.6)
    const sendable =
      assessment.send_recommendation === "send" &&
      !!event.source_url &&
      evidence.length > 0 &&
      assessment.why_user.length > 0 &&
      assessment.creepiness_risk <= CREEPINESS_MAX &&
      total >= SEND_THRESHOLD;

    // 'review' parks the candidate for founder approval; approveRadarCandidate() is what sends it (§23/§31).
    const status = sendable
      ? (FOUNDER_REVIEW ? "review" : "approved")
      : assessment.send_recommendation === "discard" ? "discarded" : "inbox_only";

    const candidate = must(
      await db.from("radar_candidates").insert({
        user_id: watch.user_id,
        world_event_id: payload.worldEventId,
        personal_fit: assessment.personal_relevance,
        novelty: assessment.novelty,
        timeliness: assessment.timeliness,
        actionability: assessment.actionability,
        source_trust: assessment.source_trust,
        creepiness_risk: assessment.creepiness_risk,
        total_score: total,
        why_user_json: { text: assessment.why_user, evidence_ids: evidence.map((e) => e.id) },
        status,
      }).select("id").single(),
      "insert radar candidate",
    ) as { id: string };

    // NEVER notify from 'review' — a human approving is what authorizes the push.
    if (status === "approved") {
      await queueRadarNotification(
        candidate.id,
        watch.user_id as string,
        watch.display_name as string,
        evidence.map((e) => e.id),
      );
    }
    return { status, total };
}

export const radarRank = task({
  id: "radar-rank",
  run: runRadarRank,
});
