/**
 * outcome loop (goal.md §17): after a move, one minimal follow-up question; when the user
 * answers, hypotheses get strengthened/weakened/invalidated. asks the minimum, never a survey.
 */
import { task } from "@trigger.dev/sdk/v3";
import { makeProvider } from "@co/model-gateway";
import type { MoveType } from "@co/contracts";
import { serviceDb, must } from "../lib/db";
import { sendNotification } from "./send-notification";

export interface OutcomeFollowupPayload {
  moveId: string;
  idempotencyKey: string;
}

/** §17 question sets by move class — the minimum that resolves the hypothesis. */
export function followupQuestion(moveType: MoveType): { question: string; options: string[] } {
  switch (moveType) {
    case "draft_message":
    case "congratulate":
    case "share_with_person":
    case "invite_friend":
      return { question: "did this create a real conversation?", options: ["yes", "polite reply only", "no response", "didn't send"] };
    case "listen_or_read":
    case "open_source":
      return { question: "did this change anything?", options: ["new idea", "reinforced something", "not useful", "haven't finished"] };
    case "create_calendar_draft":
    case "start_small_experiment":
    case "build_plan":
    case "find_options":
      return { question: "what was actually valuable?", options: ["the activity", "the people", "the repetition", "nothing"] };
    default:
      return { question: "did this happen?", options: ["yes", "not yet", "decided against it"] };
  }
}

export const outcomeFollowup = task({
  id: "outcome-followup",
  run: async (payload: OutcomeFollowupPayload) => {
    const db = serviceDb();
    const move = must(
      await db.from("moves").select("*").eq("id", payload.moveId).maybeSingle(),
      "load move",
    ) as Record<string, unknown>;

    const outcome = (await db.from("outcomes").select("*").eq("move_id", payload.moveId).maybeSingle()).data as Record<string, unknown> | null;

    if (!outcome || !outcome.result) {
      // no outcome yet → ask the single minimal question, in-app inbox first (reminder-class, not proactive-cap spend)
      if (move.status !== "approved" && move.status !== "completed") return { skipped: "move not acted on" };
      const q = followupQuestion(move.move_type as MoveType);
      await sendNotification.trigger(
        {
          userId: move.user_id as string,
          // co is initiating this question, so it is proactive: it spends cap and obeys quiet hours.
          // (was 'reminder', which bought a bypass of both — the §18 hole, see governance-gates.test.ts)
          callbackType: "pattern",
          triggerType: "outcome_followup",
          userRequested: false,
          message: q.question, // content-free of private detail by construction
          evidenceIds: [payload.moveId],
          idempotencyKey: `${payload.idempotencyKey}:ask`,
        },
        { idempotencyKey: `${payload.idempotencyKey}:ask` },
      );
      return { asked: q.question };
    }

    // outcome exists → evaluate and update memory
    const hypotheses = must(
      await db.from("hypotheses").select("id,statement,confidence").eq("user_id", move.user_id as string).in("status", ["review", "sent", "confirmed", "partly"]).limit(5),
      "load hypotheses",
    ) as Array<{ id: string; statement: string; confidence: number }>;

    const provider = makeProvider(process.env);
    const update = await provider.evaluateOutcome({
      move: { move_type: move.move_type as MoveType, title: move.title as string },
      outcome: {
        action_taken: (outcome.action_taken as string | null) ?? undefined,
        result: (outcome.result as string | null) ?? undefined,
        value_rating: (outcome.value_rating as string | null) ?? undefined,
        surprise_rating: (outcome.surprise_rating as string | null) ?? undefined,
        social_response: (outcome.social_response as string | null) ?? undefined,
        would_repeat: (outcome.would_repeat as boolean | null) ?? undefined,
      },
      hypotheses,
    });

    for (const adj of update.hypothesis_adjustments) {
      const h = hypotheses.find((x) => x.id === adj.hypothesis_id);
      if (!h) continue; // model may only touch listed hypotheses
      const confidence = adj.direction === "strengthen" ? Math.min(1, h.confidence + 0.15) : Math.max(0, h.confidence - 0.15);
      await db.from("hypotheses").update({
        confidence,
        status: adj.direction === "invalidate" ? "rejected" : undefined,
        updated_at: new Date().toISOString(),
      }).eq("id", adj.hypothesis_id);
    }
    for (const s of update.standard_adjustments) {
      await db.from("standards").insert({
        user_id: move.user_id, domain: s.domain, statement: s.statement,
        confidence: 0.5, source_type: "inferred", evidence_ids: [payload.moveId],
      });
    }
    return { adjustments: update.hypothesis_adjustments.length, followup: update.followup_question };
  },
});
