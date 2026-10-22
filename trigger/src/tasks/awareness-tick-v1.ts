import { contextEventTaskPayloadSchema, featureFlagsFromEnvironment } from "@co/contracts";
import { schedules, tasks } from "@trigger.dev/sdk/v3";
import { serviceDb, type Db } from "../lib/db";

type ClaimedEvent = { event_id: string; user_id: string; attempt: number };

type Dispatch = (payload: {
  userId: string;
  eventId: string;
  resourceVersion: "ambient-context.v1";
}, attempt: number) => Promise<void>;

async function triggerContextEvent(payload: Parameters<Dispatch>[0], attempt: number) {
  await tasks.trigger("context-event-v1", payload, {
    idempotencyKey: `ambient-context:${payload.eventId}:${attempt}`,
  });
}

export async function drainDueContextEvents(
  db: Db,
  dispatch: Dispatch = triggerContextEvent,
) {
  const claimed = await db.rpc("claim_due_context_events", { p_limit: 50 });
  if (claimed.error) throw claimed.error;
  const results: Array<{ eventId: string; status: "dispatched" | "failed_safe" }> = [];
  for (const row of (claimed.data ?? []) as ClaimedEvent[]) {
    const payload = contextEventTaskPayloadSchema.parse({
      userId: row.user_id,
      eventId: row.event_id,
      resourceVersion: "ambient-context.v1",
    });
    try {
      await dispatch(payload as Parameters<Dispatch>[0], row.attempt);
      results.push({ eventId: row.event_id, status: "dispatched" });
    } catch {
      const released = await db.from("context_events").update({
        state: "failed_safe",
        leased_at: null,
        evaluate_after: new Date(Date.now() + 60_000).toISOString(),
      }).eq("id", row.event_id).eq("user_id", row.user_id);
      if (released.error) throw released.error;
      results.push({ eventId: row.event_id, status: "failed_safe" });
    }
  }
  return results;
}

export const awarenessTickV1 = schedules.task({
  id: "awareness-tick-v1",
  cron: "* * * * *",
  run: async () => {
    if (!featureFlagsFromEnvironment(process.env).ambient_awareness) {
      return { status: "disabled" as const };
    }
    const dispatched = await drainDueContextEvents(serviceDb());
    return { status: "processed" as const, dispatched };
  },
});
