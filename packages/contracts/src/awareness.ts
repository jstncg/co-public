import { z } from "zod";

export const contextSourceKinds = ["messaging", "calendar", "email"] as const;
export const contextEventKinds = [
  "message_received",
  "message_sent",
  "calendar_changed",
  "calendar_deleted",
  "calendar_window_opening",
  "email_received",
  "email_deleted",
] as const;
export const contextEventStates = [
  "queued",
  "processing",
  "evaluated",
  "deferred",
  "ignored",
  "failed_safe",
  "superseded",
] as const;
export const calendarAccessModes = ["availability_only", "details"] as const;
export const calendarItemStatuses = ["confirmed", "tentative", "cancelled"] as const;
export const calendarAvailability = ["busy", "free", "tentative", "out_of_office"] as const;
export const awarenessDecisions = ["record_only", "defer", "collaborate", "hold"] as const;

const optionalBoundedText = (maximum: number) =>
  z.string().trim().min(1).max(maximum).nullable().default(null);

export const calendarContextItemSchema = z.object({
  external_id: z.string().trim().min(1).max(512),
  revision: z.string().trim().min(1).max(256),
  starts_at: z.iso.datetime({ offset: true }),
  ends_at: z.iso.datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(120),
  is_all_day: z.boolean().default(false),
  status: z.enum(calendarItemStatuses).default("confirmed"),
  availability: z.enum(calendarAvailability).default("busy"),
  title: optionalBoundedText(1_000),
  location: optionalBoundedText(2_000),
  notes: optionalBoundedText(20_000),
  url: z.url().max(4_096).nullable().default(null),
  analysis_allowed: z.boolean().default(true),
  sensitivity: z.enum(["unknown", "low", "medium", "high"]).default("unknown"),
}).strict().superRefine((item, context) => {
  if (Date.parse(item.ends_at) <= Date.parse(item.starts_at)) {
    context.addIssue({ code: "custom", path: ["ends_at"], message: "must be after starts_at" });
  }
});

export const calendarContextSyncSchema = z.object({
  source_id: z.uuid(),
  source_label: optionalBoundedText(160),
  access_mode: z.enum(calendarAccessModes),
  sync_cursor: optionalBoundedText(2_000),
  full_sync: z.boolean().default(false),
  synced_at: z.iso.datetime({ offset: true }),
  events: z.array(calendarContextItemSchema).max(500),
  deleted_external_ids: z.array(z.string().trim().min(1).max(512)).max(500).default([]),
}).strict().superRefine((sync, context) => {
  const eventIds = new Set<string>();
  for (const [index, event] of sync.events.entries()) {
    if (eventIds.has(event.external_id)) {
      context.addIssue({ code: "custom", path: ["events", index, "external_id"], message: "must be unique" });
    }
    eventIds.add(event.external_id);
    if (
      sync.access_mode === "availability_only" &&
      (event.title !== null || event.location !== null || event.notes !== null || event.url !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["events", index],
        message: "availability-only sync cannot contain event details",
      });
    }
  }
  const deletedIds = new Set(sync.deleted_external_ids);
  if (deletedIds.size !== sync.deleted_external_ids.length) {
    context.addIssue({ code: "custom", path: ["deleted_external_ids"], message: "must be unique" });
  }
  for (const id of deletedIds) {
    if (eventIds.has(id)) {
      context.addIssue({
        code: "custom",
        path: ["deleted_external_ids"],
        message: "an event cannot be upserted and deleted in the same sync",
      });
    }
  }
});

export const calendarContextSyncResponseSchema = z.object({
  source_id: z.uuid(),
  accepted: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  context_event_ids: z.array(z.uuid()),
  next_due_at: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const contextEventTaskPayloadSchema = z.object({
  userId: z.uuid(),
  eventId: z.uuid().optional(),
  messageId: z.uuid().optional(),
  messageDirection: z.enum(["inbound", "outbound"]).optional(),
  resourceVersion: z.literal("ambient-context.v1"),
}).strict().superRefine((payload, context) => {
  const eventTarget = payload.eventId !== undefined;
  const messageTarget = payload.messageId !== undefined;
  if (eventTarget === messageTarget) {
    context.addIssue({ code: "custom", message: "provide exactly one context event or message target" });
  }
  if (messageTarget && payload.messageDirection === undefined) {
    context.addIssue({ code: "custom", path: ["messageDirection"], message: "required for a message target" });
  }
  if (eventTarget && payload.messageDirection !== undefined) {
    context.addIssue({ code: "custom", path: ["messageDirection"], message: "only valid for a message target" });
  }
});

export type ContextSourceKind = (typeof contextSourceKinds)[number];
export type ContextEventKind = (typeof contextEventKinds)[number];
export type ContextEventState = (typeof contextEventStates)[number];
export type CalendarAccessMode = (typeof calendarAccessModes)[number];
export type CalendarContextItem = z.infer<typeof calendarContextItemSchema>;
export type CalendarContextSync = z.infer<typeof calendarContextSyncSchema>;
export type CalendarContextSyncResponse = z.infer<typeof calendarContextSyncResponseSchema>;
export type ContextEventTaskPayload = z.infer<typeof contextEventTaskPayloadSchema>;
