import { z } from "zod";
import { sourceTypes } from "./artifact";
import { moveTypes } from "./model";

export const productEventNames = [
  "onboarding_started", "first_capture_started", "first_capture_completed", "first_response_ready",
  "why_prompt_shown", "why_submitted", "quiet_save_selected", "account_created",
  "notifications_prompted", "notifications_granted", "capture_created", "capture_failed",
  "capture_retried", "thread_created", "pattern_candidate_created", "pattern_reviewed",
  "pattern_sent", "pattern_feedback", "watch_entity_added", "watch_entity_suggested",
  "watch_entity_approved", "radar_candidate_created", "radar_sent", "radar_feedback",
  "move_prepared", "move_approved", "move_completed", "outcome_submitted", "artifact_deleted",
  "export_requested", "account_deleted", "invite_sent",
] as const;

const safeReasonCode = z.string().regex(/^[a-z0-9_]{1,40}$/);

export const productEventPropertiesSchema = z.object({
  sourceType: z.enum(sourceTypes).optional(),
  sourceCoverage: z.enum(["full_media", "image", "text", "url_only", "unavailable"]).optional(),
  mode: z.enum(["understand", "react", "remember", "move", "quiet"]).optional(),
  surface: z.enum(["app", "share_extension", "notification", "founder_console", "api", "worker"]).optional(),
  result: z.enum(["success", "failed_safe", "dismissed", "expired", "denied"]).optional(),
  reasonCode: safeReasonCode.optional(),
  moveType: z.enum(moveTypes).optional(),
  feedback: z.enum(["got_why", "useful_now", "wrong", "too_much", "creepy", "acted", "changed_something", "mute"]).optional(),
  permissionState: z.enum(["not_determined", "denied", "authorized", "provisional", "ephemeral"]).optional(),
  retryBucket: z.enum(["0", "1", "2_3", "4_plus"]).optional(),
  durationBucket: z.enum(["under_1m", "1_5m", "5_30m", "30m_plus"]).optional(),
  latencyBucket: z.enum(["under_1s", "1_3s", "3_10s", "10s_plus"]).optional(),
  modelTier: z.enum(["fast", "reasoning", "vision", "search", "transcription", "moderation"]).optional(),
  count: z.number().int().min(0).max(10_000).optional(),
  dayIndex: z.number().int().min(0).max(365).optional(),
  success: z.boolean().optional(),
  appVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/).optional(),
  osMajor: z.number().int().min(18).max(99).optional(),
}).strict();

export const productEventSchema = z.object({
  name: z.enum(productEventNames),
  occurredAt: z.iso.datetime({ offset: true }),
  properties: productEventPropertiesSchema.default({}),
}).strict();

export type ProductEvent = z.infer<typeof productEventSchema>;
