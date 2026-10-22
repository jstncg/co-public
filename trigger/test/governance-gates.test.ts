/**
 * governance gates — pins two defects alleged by the codex audit, at the WIRING level
 * (caps.test.ts covers only the pure helpers; these exercise the actual task run paths).
 *
 * defect (a) — goal.md §23 founder review: "all pattern callbacks require founder approval"
 *   radar-rank inserts the candidate with status 'review' and then queues the lock-screen
 *   notification in the same run, before any founder decision. (radar-rank.ts:119-131)
 *
 * defect (b) — goal.md §18 quiet hours: "no proactive notifications 11 p.m.–8 a.m. local"
 *   send-notification skips the quiet-hours check for EVERY reminder-typed payload
 *   (send-notification.ts:43-44), and outcome-followup.ts:52-56 sends a system-initiated
 *   follow-up question as callbackType 'reminder' — so a non-user-requested push can fire
 *   at 03:00 local, also bypassing the weekly cap.
 *
 * regression suite for the two governance defects found in the 2026-07-24 audit. both are
 * FIXED: (a) radar notifies only from approveRadarCandidate(), never from a 'review' row;
 * (b) the quiet-hours/cap exemption keys off payload.userRequested, never off callbackType.
 * the remaining tests document the enforcement boundary (cap suppression, quiet-hours reschedule,
 * and the one case that SHOULD bypass: a delivery the user explicitly asked for).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setDbForTesting, type Db } from "../src/lib/db";
import { runSendNotification, sendNotification } from "../src/tasks/send-notification";
import { runRadarRank } from "../src/tasks/radar-rank";
import { DEFAULT_SETTINGS } from "../src/lib/caps";

// ---------- fake supabase: chainable, thenable query builder ----------

interface Captured {
  table: string;
  ops: string[];
  insert?: Record<string, unknown>;
}
type Resp = { data: unknown; error: { message: string } | null };

function fakeDb(route: (q: Captured) => Resp): { db: Db; log: Captured[] } {
  const log: Captured[] = [];
  const db = {
    from(table: string) {
      const q: Captured = { table, ops: [] };
      log.push(q);
      const proxy: unknown = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === "then") {
              const p = Promise.resolve(route(q));
              return p.then.bind(p);
            }
            return (...args: unknown[]) => {
              q.ops.push(String(prop));
              if (prop === "insert") q.insert = args[0] as Record<string, unknown>;
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  } as unknown as Db;
  return { db, log };
}

// 03:00 America/New_York (EDT) — squarely inside default quiet hours 23:00–08:00
const QUIET_3AM_NY = new Date("2026-06-10T07:00:00Z").getTime();
// 12:00 America/New_York — outside quiet hours
const NOON_NY = new Date("2026-06-10T16:00:00Z").getTime();

const deviceRow = { apns_token: null, notification_settings: DEFAULT_SETTINGS };

function sendNotificationRoutes(overrides: { recentSends?: Array<{ sent_at: string }> } = {}) {
  return (q: Captured): Resp => {
    if (q.table === "callbacks" && q.ops.includes("contains")) return { data: null, error: null }; // dup check
    if (q.table === "callbacks" && q.ops.includes("gte")) return { data: overrides.recentSends ?? [], error: null }; // trailing-7d sends
    if (q.table === "callbacks" && q.ops.includes("insert")) return { data: { id: "cb-1" }, error: null };
    if (q.table === "users") return { data: { id: "u-1", timezone: "America/New_York" }, error: null };
    if (q.table === "devices") return { data: [deviceRow], error: null };
    return { data: null, error: null };
  };
}

// ---------- defect (a): radar candidate in founder review still queues a notification ----------

test("§23: a sendable radar candidate parked in 'review' must not queue a notification before founder approval", async (t) => {
  const savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY; // force MockProvider — deterministic assessment
  const originalTrigger = sendNotification.trigger;
  const notifyCalls: unknown[][] = [];
  (sendNotification as { trigger: unknown }).trigger = async (...args: unknown[]) => {
    notifyCalls.push(args);
    return { id: "run_test" };
  };
  t.after(() => {
    (sendNotification as { trigger: unknown }).trigger = originalTrigger;
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
    setDbForTesting(undefined);
  });

  const watchRow = {
    id: "w-1",
    user_id: "u-1",
    approved_at: "2026-06-01T00:00:00Z",
    paused_at: null,
    display_name: "andera",
    entity_type: "person",
    identifiers_json: { relationship_note: "old cofounder friend, i want to hear when she launches" },
    desired_event_types: ["launch"],
    excluded_event_types: [],
  };
  const eventRow = {
    id: "e-1",
    event_type: "launch",
    title: "andera launches her company",
    summary: "public launch announcement",
    source_url: "https://example.com/launch",
    source_published_at: "2026-06-09T12:00:00Z",
  };

  const { db, log } = fakeDb((q) => {
    if (q.table === "watch_entities") return { data: watchRow, error: null };
    if (q.table === "world_events") return { data: eventRow, error: null };
    if (q.table === "annotations") return { data: [], error: null };
    if (q.table === "radar_candidates" && q.ops.includes("insert")) return { data: { id: "rc-1" }, error: null };
    if (q.table === "radar_candidates" && q.ops.includes("in")) return { data: [], error: null }; // sent history
    if (q.table === "radar_candidates") return { data: null, error: null }; // existing-candidate check
    return { data: null, error: null };
  });
  setDbForTesting(db);

  const result = (await runRadarRank({
    worldEventId: "e-1",
    watchEntityId: "w-1",
    idempotencyKey: "gate-a",
  })) as { status?: string };

  // sanity: the pipeline judged this sendable and parked it in founder review
  assert.equal(result.status, "review", "precondition: candidate should be sendable and enter 'review'");
  const inserted = log.find((q) => q.table === "radar_candidates" && q.insert);
  assert.equal(inserted?.insert?.status, "review");

  // the gate: founder review must complete BEFORE anything is queued to the lock screen (§23)
  assert.equal(
    notifyCalls.length,
    0,
    "radar-rank queued a send-notification while the candidate is still in founder review " +
      "(radar-rank.ts triggers sendNotification in the same run that sets status 'review')",
  );
});

// ---------- defect (b): reminder-typed path bypasses quiet hours ----------

test("§18: a system-initiated follow-up must not push at 03:00 local, whatever it labels itself", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: QUIET_3AM_NY });
  t.after(() => setDbForTesting(undefined));

  const { db, log } = fakeDb(sendNotificationRoutes());
  setDbForTesting(db);

  // the old outcome-followup payload: reminder-typed, but nobody asked for it. the label must not buy a bypass.
  await runSendNotification({
    userId: "u-1",
    callbackType: "reminder",
    triggerType: "outcome_followup",
    message: "did this create a real conversation?",
    evidenceIds: ["m-1"],
    idempotencyKey: "gate-b",
  });

  const inserted = log.find((q) => q.table === "callbacks" && q.insert);
  assert.ok(inserted?.insert, "a callback row should be recorded");
  assert.equal(
    inserted.insert.sent_at,
    null,
    "a system-initiated ask must be deferred to quiet_end, not sent at 03:00, " +
      "regardless of the callbackType the caller chose",
  );
});

// ---------- enforcement that DOES hold on the proactive path (documents the boundary of the defect) ----------

test("§18 quiet hours ARE enforced for proactive callback types: 03:00 radar send is rescheduled to 08:00 local", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: QUIET_3AM_NY });
  t.after(() => setDbForTesting(undefined));

  const { db, log } = fakeDb(sendNotificationRoutes());
  setDbForTesting(db);

  const result = (await runSendNotification({
    userId: "u-1",
    callbackType: "radar",
    triggerType: "watched_entity_event",
    message: 'co found something relevant to "andera".',
    evidenceIds: ["ev-1"],
    idempotencyKey: "gate-c",
  })) as { rescheduled?: string | null };

  assert.equal(result.rescheduled, "2026-06-10T12:00:00.000Z"); // 08:00 America/New_York (EDT)
  const inserted = log.find((q) => q.table === "callbacks" && q.insert);
  assert.equal(inserted?.insert?.sent_at, null);
  assert.equal(inserted?.insert?.scheduled_at, "2026-06-10T12:00:00.000Z");
});

test("§18 weekly cap IS enforced for proactive callback types: third send in 7 days is suppressed to inbox", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOON_NY });
  t.after(() => setDbForTesting(undefined));

  const { db, log } = fakeDb(
    sendNotificationRoutes({
      recentSends: [{ sent_at: "2026-06-07T15:00:00Z" }, { sent_at: "2026-06-09T15:00:00Z" }],
    }),
  );
  setDbForTesting(db);

  const result = (await runSendNotification({
    userId: "u-1",
    callbackType: "pattern",
    triggerType: "pattern_threshold",
    message: "co noticed something about small-group making.",
    evidenceIds: ["ev-2"],
    idempotencyKey: "gate-d",
  })) as { suppressed?: string };

  assert.equal(result.suppressed, "weekly_cap");
  const inserted = log.find((q) => q.table === "callbacks" && q.insert);
  assert.equal(inserted?.insert?.feedback, "suppressed:weekly_cap");
  assert.equal(inserted?.insert?.sent_at, undefined); // never given a sent_at
});

test("§18 the ONE legitimate bypass: a delivery the user explicitly asked for still fires inside quiet hours", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: QUIET_3AM_NY });
  t.after(() => setDbForTesting(undefined));

  const { db, log } = fakeDb(sendNotificationRoutes());
  setDbForTesting(db);

  // "wake me at 3am for the launch" — the user picked the moment, so honouring it is not an interruption.
  await runSendNotification({
    userId: "u-1",
    callbackType: "reminder",
    triggerType: "user_requested_reminder",
    message: "your 3am reminder",
    evidenceIds: ["r-1"],
    idempotencyKey: "gate-e",
    userRequested: true,
  });

  const inserted = log.find((q) => q.table === "callbacks" && q.insert);
  assert.equal(inserted?.insert?.sent_at, "2026-06-10T07:00:00.000Z", "user-requested delivery must fire on time");
  assert.equal(inserted?.insert?.scheduled_at, null);
});
