/**
 * radar polling (goal.md §24): due subscriptions → adapter poll → world_events upsert
 * (globally deduped on canonical_event_key) → per-user ranking fan-out.
 */
import { task } from "@trigger.dev/sdk/v3";
import {
  makeRssAdapter,
  makePodcastAdapter,
  makeSiteMonitorAdapter,
  makeXAdapter,
  FeatureDisabledError,
  type SourceAdapter,
  type SubscriptionState,
} from "@co/source-adapters";
import { serviceDb, must } from "../lib/db";
import { radarRank } from "./radar-rank";

export interface RadarPollPayload {
  subscriptionId: string;
  idempotencyKey: string;
}

function adapterFor(type: string): SourceAdapter {
  switch (type) {
    case "rss": return makeRssAdapter();
    case "podcast": return makePodcastAdapter();
    case "sitemonitor": return makeSiteMonitorAdapter();
    case "x": return makeXAdapter(process.env); // flagged: throws FeatureDisabledError without X_API_BEARER
    default: throw new Error(`no poll adapter for type: ${type}`); // websearch runs via its own scheduled task
  }
}

export const radarPoll = task({
  id: "radar-poll",
  run: async (payload: RadarPollPayload) => {
    const db = serviceDb();
    const sub = must(
      await db
        .from("source_subscriptions")
        .select("*,watch_entities(id,user_id,display_name,approved_at,paused_at)")
        .eq("id", payload.subscriptionId)
        .maybeSingle(),
      "load subscription",
    ) as Record<string, unknown>;

    const watch = sub.watch_entities as { id: string; user_id: string; display_name: string; approved_at: string | null; paused_at: string | null };
    if (!watch.approved_at || watch.paused_at) return { skipped: "watch not approved or paused" }; // monitoring requires explicit approval
    if (sub.status !== "active") return { skipped: "subscription inactive" };

    const state: SubscriptionState = {
      id: sub.id as string,
      adapter_type: sub.adapter_type as SubscriptionState["adapter_type"],
      source_url: (sub.source_url as string | null) ?? undefined,
      source_external_id: (sub.source_external_id as string | null) ?? watch.display_name,
      etag: (sub.etag as string | null) ?? undefined,
      last_modified: (sub.last_modified as string | null) ?? undefined,
      cursor: (sub.cursor as string | null) ?? undefined,
    };

    let result;
    try {
      result = await adapterFor(state.adapter_type).poll(state);
    } catch (err) {
      if (err instanceof FeatureDisabledError) return { skipped: err.message };
      await db.from("source_subscriptions").update({ failure_count: ((sub.failure_count as number) ?? 0) + 1 }).eq("id", state.id);
      throw err;
    }

    await db.from("source_subscriptions").update({
      etag: result.etag ?? null,
      last_modified: result.last_modified ?? null,
      cursor: result.cursor ?? null,
      last_success_at: new Date().toISOString(),
      failure_count: 0,
    }).eq("id", state.id);

    await db.from("watch_entities").update({ last_checked_at: new Date().toISOString() }).eq("id", watch.id);

    if (result.events.length === 0) return { events: 0, not_modified: result.not_modified };

    // global dedupe before personal ranking: canonical_event_key is unique, duplicates ignored.
    must(
      await db.from("world_events").upsert(
        result.events.map((e) => ({
          canonical_event_key: e.canonical_event_key,
          event_type: e.event_type,
          title: e.title,
          summary: e.summary ?? null,
          entity_ids: [watch.id],
          source_url: e.source_url,
          source_title: e.source_title ?? null,
          source_published_at: e.source_published_at ?? null,
          content_hash: e.content_hash ?? null,
          raw_metadata_json: e.raw_metadata,
        })),
        { onConflict: "canonical_event_key", ignoreDuplicates: true },
      ).select("id"),
      "upsert world events",
    );

    const rows = must(
      await db.from("world_events").select("id,canonical_event_key").in("canonical_event_key", result.events.map((e) => e.canonical_event_key)),
      "load world event ids",
    ) as Array<{ id: string; canonical_event_key: string }>;

    for (const row of rows) {
      await radarRank.trigger(
        { worldEventId: row.id, watchEntityId: watch.id, idempotencyKey: `rank:${watch.id}:${row.id}` },
        { idempotencyKey: `rank:${watch.id}:${row.id}` },
      );
    }
    return { events: rows.length };
  },
});
