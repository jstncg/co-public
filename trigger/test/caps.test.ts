import { test } from "node:test";
import assert from "node:assert/strict";
import { canSendProactive, inQuietHours, localMinutes, nextQuietEnd, parseHm, underWeeklyCap, DEFAULT_SETTINGS } from "../src/lib/caps";

// 2026-06-09T12:00:00-04:00 (America/New_York, EDT) = 16:00Z
const NOON_NY = new Date("2026-06-09T16:00:00Z");
const MIDNIGHT_NY = new Date("2026-06-09T04:30:00Z"); // 00:30 local

test("parseHm parses and rejects garbage", () => {
  assert.equal(parseHm("23:00"), 23 * 60);
  assert.equal(parseHm("08:00"), 8 * 60);
  assert.throws(() => parseHm("25:00"));
  assert.throws(() => parseHm("nope"));
});

test("localMinutes respects timezone", () => {
  assert.equal(localMinutes(NOON_NY, "America/New_York"), 12 * 60);
  assert.equal(localMinutes(NOON_NY, "UTC"), 16 * 60);
});

test("quiet hours wrap midnight: 23:00-08:00", () => {
  assert.equal(inQuietHours(NOON_NY, "America/New_York"), false);
  assert.equal(inQuietHours(MIDNIGHT_NY, "America/New_York"), true);
  // boundaries: 22:59 not quiet, 23:00 quiet, 07:59 quiet, 08:00 not quiet (local)
  assert.equal(inQuietHours(new Date("2026-06-10T02:59:00Z"), "America/New_York"), false); // 22:59 local
  assert.equal(inQuietHours(new Date("2026-06-10T03:00:00Z"), "America/New_York"), true); // 23:00 local
  assert.equal(inQuietHours(new Date("2026-06-09T11:59:00Z"), "America/New_York"), true); // 07:59 local
  assert.equal(inQuietHours(new Date("2026-06-09T12:00:00Z"), "America/New_York"), false); // 08:00 local
});

test("non-wrapping quiet window and zero-length window", () => {
  const daytimeQuiet = { proactive_per_week: 2, quiet_start: "09:00", quiet_end: "17:00" };
  assert.equal(inQuietHours(NOON_NY, "America/New_York", daytimeQuiet), true);
  const zero = { proactive_per_week: 2, quiet_start: "09:00", quiet_end: "09:00" };
  assert.equal(inQuietHours(NOON_NY, "America/New_York", zero), false);
});

test("weekly cap: 2 per trailing 7 days", () => {
  const now = NOON_NY;
  const days = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
  assert.equal(underWeeklyCap([], now, 2), true);
  assert.equal(underWeeklyCap([days(1)], now, 2), true);
  assert.equal(underWeeklyCap([days(1), days(2)], now, 2), false);
  assert.equal(underWeeklyCap([days(8), days(9)], now, 2), true, "sends older than 7 days do not count");
  assert.equal(underWeeklyCap([days(1)], now, 0), false, "cap of zero means never push");
});

test("canSendProactive: cap checked before quiet hours; reasons are specific", () => {
  const days = (n: number) => new Date(NOON_NY.getTime() - n * 24 * 60 * 60 * 1000);
  assert.deepEqual(
    canSendProactive({ now: NOON_NY, timezone: "America/New_York", recentProactiveSends: [] }),
    { allowed: true },
  );
  assert.deepEqual(
    canSendProactive({ now: NOON_NY, timezone: "America/New_York", recentProactiveSends: [days(1), days(3)] }),
    { allowed: false, reason: "weekly_cap" },
  );
  assert.deepEqual(
    canSendProactive({ now: MIDNIGHT_NY, timezone: "America/New_York", recentProactiveSends: [] }),
    { allowed: false, reason: "quiet_hours" },
  );
});

test("nextQuietEnd reschedules into the morning", () => {
  const rescheduled = nextQuietEnd(MIDNIGHT_NY, "America/New_York", DEFAULT_SETTINGS);
  assert.equal(localMinutes(rescheduled, "America/New_York"), 8 * 60);
  assert.ok(rescheduled.getTime() > MIDNIGHT_NY.getTime());
});
