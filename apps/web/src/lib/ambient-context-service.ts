import {
  calendarContextSyncResponseSchema,
  calendarContextSyncSchema,
  featureFlagsFromEnvironment,
} from "@co/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

type AmbientContextDependencies = {
  environment?: Record<string, string | undefined>;
  dispatch?: (input: { userId: string; eventId: string; idempotencyKey: string }) => Promise<void>;
};

function requireAmbientAwareness(environment: Record<string, string | undefined>) {
  if (!featureFlagsFromEnvironment(environment).ambient_awareness) {
    throw new Response("ambient awareness unavailable", { status: 503 });
  }
}

export async function syncCalendarContext(
  admin: SupabaseClient,
  userId: string,
  unknownInput: unknown,
  dependencies: AmbientContextDependencies = {},
) {
  const environment = dependencies.environment ?? process.env;
  requireAmbientAwareness(environment);
  const sync = calendarContextSyncSchema.parse(unknownInput);
  const result = await admin.rpc("sync_calendar_context", {
    p_user_id: userId,
    p_external_source_id: sync.source_id,
    p_source_label: sync.source_label,
    p_access_mode: sync.access_mode,
    p_sync_cursor: sync.sync_cursor,
    p_full_sync: sync.full_sync,
    p_synced_at: sync.synced_at,
    p_events: sync.events,
    p_deleted_external_ids: sync.deleted_external_ids,
  });
  if (result.error) throw result.error;
  const response = calendarContextSyncResponseSchema.parse(result.data);
  // The database rows are the durable outbox. Production deliberately does
  // not wait on a Trigger API call; the minute scheduler claims them. Tests
  // and operator tools may inject an eager dispatch without changing storage.
  if (dependencies.dispatch) {
    for (const eventId of response.context_event_ids) {
      await dependencies.dispatch({
        userId,
        eventId,
        idempotencyKey: `ambient-context:${eventId}`,
      });
    }
  }
  return response;
}

export async function deleteCalendarContext(
  admin: SupabaseClient,
  userId: string,
  unknownInput: unknown,
  environment: Record<string, string | undefined> = process.env,
) {
  requireAmbientAwareness(environment);
  const input = z.object({ source_id: z.uuid() }).strict().parse(unknownInput);
  const result = await admin.rpc("delete_calendar_context_source", {
    p_user_id: userId,
    p_external_source_id: input.source_id,
  });
  if (result.error) throw result.error;
  if (result.data !== true) throw new Response("calendar context source not found", { status: 404 });
  return { deleted: true as const, source_id: input.source_id };
}

export async function inspectAmbientContext(
  admin: SupabaseClient,
  userId: string,
  environment: Record<string, string | undefined> = process.env,
) {
  requireAmbientAwareness(environment);
  const now = new Date();
  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const windowEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1_000).toISOString();
  const [sources, calendar, email, events, candidates] = await Promise.all([
    admin.from("context_sources")
      .select("id,source_kind,external_source_id,source_label,access_mode,status,last_synced_at,updated_at")
      .eq("user_id", userId).order("updated_at", { ascending: false }),
    admin.from("calendar_context_items")
      .select("id,source_id,starts_at,ends_at,timezone,is_all_day,status,availability,title,location,analysis_allowed,sensitivity")
      .eq("user_id", userId).is("superseded_at", null).eq("tombstone", false)
      .gte("ends_at", windowStart).lte("starts_at", windowEnd).order("starts_at").limit(200),
    admin.from("email_context_items")
      .select("id,source_id,internal_date,sender,recipients,subject,sent_date,snippet,label_ids,analysis_allowed,sensitivity")
      .eq("user_id", userId).eq("tombstone", false)
      .gte("internal_date", windowStart).order("internal_date", { ascending: false }).limit(200),
    admin.from("context_events")
      .select("id,source_kind,event_kind,occurred_at,effective_from,effective_to,evaluate_after,state,outcome_reason,created_at")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
    admin.from("awareness_candidates")
      .select("id,evaluation_id,proposed_copy,confidence,citation_ids,sensitivity,status,not_before,expires_at,created_at")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(100),
  ]);
  for (const result of [sources, calendar, email, events, candidates]) if (result.error) throw result.error;
  return {
    generated_at: now.toISOString(),
    window: { starts_at: windowStart, ends_at: windowEnd },
    sources: sources.data ?? [],
    calendar: calendar.data ?? [],
    email: email.data ?? [],
    events: events.data ?? [],
    candidates: candidates.data ?? [],
  };
}
