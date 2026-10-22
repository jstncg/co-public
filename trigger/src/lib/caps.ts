/**
 * notification caps + quiet hours — pure functions (goal.md §18).
 * defaults: max 2 unsolicited/week (user-requested reminders don't count), quiet 23:00–08:00 local.
 */

export interface NotificationSettings {
  proactive_per_week: number;
  quiet_start: string; // "HH:MM" local
  quiet_end: string; // "HH:MM" local
}

export const DEFAULT_SETTINGS: NotificationSettings = { proactive_per_week: 2, quiet_start: "23:00", quiet_end: "08:00" };

export function parseHm(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`bad HH:MM time: ${s}`);
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (minutes < 0 || minutes >= 24 * 60) throw new Error(`out-of-range time: ${s}`);
  return minutes;
}

/** minutes since local midnight in the user's timezone. */
export function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export function inQuietHours(now: Date, timezone: string, settings: NotificationSettings = DEFAULT_SETTINGS): boolean {
  const start = parseHm(settings.quiet_start);
  const end = parseHm(settings.quiet_end);
  if (start === end) return false; // zero-length window
  const m = localMinutes(now, timezone);
  return start < end ? m >= start && m < end : m >= start || m < end; // wraps midnight
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** trailing-7-day count; only proactive sends belong in sentAt (reminders excluded by the caller). */
export function underWeeklyCap(sentAt: Date[], now: Date, maxPerWeek: number): boolean {
  if (maxPerWeek <= 0) return false; // user chose zero → inbox only, never push
  const cutoff = now.getTime() - WEEK_MS;
  const recent = sentAt.filter((d) => d.getTime() > cutoff && d.getTime() <= now.getTime()).length;
  return recent < maxPerWeek;
}

export type SendBlockReason = "quiet_hours" | "weekly_cap";

export function canSendProactive(opts: {
  now: Date;
  timezone: string;
  settings?: NotificationSettings;
  recentProactiveSends: Date[];
}): { allowed: boolean; reason?: SendBlockReason } {
  const settings = opts.settings ?? DEFAULT_SETTINGS;
  if (!underWeeklyCap(opts.recentProactiveSends, opts.now, settings.proactive_per_week)) {
    return { allowed: false, reason: "weekly_cap" };
  }
  if (inQuietHours(opts.now, opts.timezone, settings)) {
    return { allowed: false, reason: "quiet_hours" };
  }
  return { allowed: true };
}

/** next quiet_end in the user's timezone — where a quiet-hours-blocked send gets rescheduled. */
export function nextQuietEnd(now: Date, timezone: string, settings: NotificationSettings = DEFAULT_SETTINGS): Date {
  const end = parseHm(settings.quiet_end);
  const m = localMinutes(now, timezone);
  let deltaMinutes = end - m;
  if (deltaMinutes <= 0) deltaMinutes += 24 * 60;
  return new Date(now.getTime() + deltaMinutes * 60 * 1000);
}
