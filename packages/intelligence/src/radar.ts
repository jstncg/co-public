import { createHash } from "node:crypto";

export type RadarSignals = {
  personalRelevance: number;
  novelty: number;
  timeliness: number;
  actionability: number;
  sourceTrust: number;
  creepinessRisk: number;
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function radarScore(signals: RadarSignals) {
  return clamp(
    0.30 * clamp(signals.personalRelevance) +
    0.15 * clamp(signals.novelty) +
    0.20 * clamp(signals.timeliness) +
    0.15 * clamp(signals.actionability) +
    0.20 * clamp(signals.sourceTrust) -
    0.25 * clamp(signals.creepinessRisk)
  );
}

export function decideRadarDelivery(input: {
  signals: RadarSignals;
  watchApproved: boolean;
  watchPaused: boolean;
  withinQuietHours: boolean;
  notificationsSentThisWeek: number;
  weeklyCap: number;
}) {
  const score = radarScore(input.signals);
  if (!input.watchApproved || input.watchPaused) return { decision: "discard" as const, score, reason: "watch_not_active" };
  if (score < 0.58) return { decision: "discard" as const, score, reason: "below_precision_threshold" };
  if (score < 0.78 || input.withinQuietHours || input.notificationsSentThisWeek >= input.weeklyCap) {
    return { decision: "inbox_only" as const, score, reason: input.withinQuietHours ? "quiet_hours" : input.notificationsSentThisWeek >= input.weeklyCap ? "weekly_cap" : "notification_threshold" };
  }
  return { decision: "notify" as const, score, reason: "high_value" };
}

export function canonicalEventKey(input: { url: string; eventType: string; publishedAt: string | null }) {
  const url = new URL(input.url);
  url.hash = "";
  ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((key) => url.searchParams.delete(key));
  const day = input.publishedAt?.slice(0, 10) ?? "unknown";
  return createHash("sha256").update(`${input.eventType}|${url.toString()}|${day}`).digest("hex");
}
