/**
 * proactive notification sender — the ONLY path to the user's lock screen.
 * enforces the weekly cap (2 default, reminders excluded) + quiet hours 23:00–08:00
 * from devices.notification_settings before anything leaves (goal.md §18).
 */
import { task } from "@trigger.dev/sdk/v3";
import { serviceDb, must } from "../lib/db";
import { canSendProactive, nextQuietEnd, DEFAULT_SETTINGS, type NotificationSettings } from "../lib/caps";

export interface SendNotificationPayload {
  userId: string;
  callbackType: "pattern" | "radar" | "reminder" | "weekly_arc";
  triggerType: string; // one of the §18 allowed triggers
  message: string; // must already be lock-screen-safe: no sensitive detail
  evidenceIds: string[];
  idempotencyKey: string;
  scheduledAt?: string;
  /** TRUE only when the user explicitly asked for this delivery at this time ("remind me at 6am").
   *  the §18 exemption keys off THIS, never off callbackType — a caller must not be able to buy
   *  its way past quiet hours by labelling itself a reminder. absent = system-initiated = fully gated. */
  userRequested?: boolean;
}

/** exported for tests (task() objects don't expose run outside the worker runtime). */
export async function runSendNotification(payload: SendNotificationPayload) {
    const db = serviceDb();

    // idempotent: one callback per idempotency key
    const dup = await db.from("callbacks").select("id").contains("evidence_ids", payload.evidenceIds).eq("user_id", payload.userId).eq("message", payload.message).not("sent_at", "is", null).maybeSingle();
    if (dup.data) return { skipped: "already sent" };

    const user = must(
      await db.from("users").select("id,timezone").eq("id", payload.userId).maybeSingle(),
      "load user",
    ) as { id: string; timezone: string };
    const devices = must(
      await db.from("devices").select("apns_token,notification_settings").eq("user_id", payload.userId),
      "load devices",
    ) as Array<{ apns_token: string | null; notification_settings: NotificationSettings }>;
    const settings = devices[0]?.notification_settings ?? DEFAULT_SETTINGS;

    const now = new Date();
    let sentAt: string | null = null;
    let scheduledAt: string | null = payload.scheduledAt ?? null;

    if (payload.userRequested === true) {
      // the user picked this moment; honouring it is not an interruption (§18). exempt from cap AND
      // quiet hours because both exist to protect against sends the user did not ask for.
      sentAt = now.toISOString();
    } else {
      const recent = must(
        await db
          .from("callbacks")
          .select("sent_at")
          .eq("user_id", payload.userId)
          .neq("callback_type", "reminder")
          .not("sent_at", "is", null)
          .gte("sent_at", new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString()),
        "load recent sends",
      ) as Array<{ sent_at: string }>;

      const verdict = canSendProactive({
        now,
        timezone: user.timezone,
        settings,
        recentProactiveSends: recent.map((r) => new Date(r.sent_at)),
      });
      if (!verdict.allowed && verdict.reason === "weekly_cap") {
        // cap exceeded → radar inbox only, no push, no reschedule (precision over recall)
        must(
          await db.from("callbacks").insert({
            user_id: payload.userId, callback_type: payload.callbackType, trigger_type: payload.triggerType,
            evidence_ids: payload.evidenceIds, message: payload.message, feedback: "suppressed:weekly_cap",
          }).select("id"),
          "record suppressed callback",
        );
        return { suppressed: "weekly_cap" };
      }
      if (!verdict.allowed && verdict.reason === "quiet_hours") {
        scheduledAt = nextQuietEnd(now, user.timezone, settings).toISOString();
      } else {
        sentAt = now.toISOString();
      }
    }

    const callback = must(
      await db.from("callbacks").insert({
        user_id: payload.userId,
        callback_type: payload.callbackType,
        trigger_type: payload.triggerType,
        evidence_ids: payload.evidenceIds,
        message: payload.message,
        scheduled_at: scheduledAt,
        sent_at: sentAt,
      }).select("id").single(),
      "insert callback",
    ) as { id: string };

    if (sentAt) {
      const tokens = devices.map((d) => d.apns_token).filter((t): t is string => !!t);
      // BLOCKED: direct APNs delivery needs an APNs auth key + http/2 client (apple developer account).
      // call point: apns.send(tokens, { title: "co", body: payload.message, thread-id: callback.id })
      if (tokens.length === 0) return { callback: callback.id, delivered: false, note: "no apns token" };
      return { callback: callback.id, delivered: false, note: "apns delivery blocked: needs APNS_KEY (docs/setup.md)" };
    }
    return { callback: callback.id, rescheduled: scheduledAt };
}

export const sendNotification = task({
  id: "send-notification",
  run: runSendNotification,
});
