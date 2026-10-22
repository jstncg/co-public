/** SourceAdapter interface + canonical event key (goal.md §15.4, §24 dedupe). */
import type { WorldEventType } from "@co/contracts";

export type AdapterType = "rss" | "podcast" | "websearch" | "sitemonitor" | "x";

/** mirrors source_subscriptions row state the poller needs. */
export interface SubscriptionState {
  id: string;
  adapter_type: AdapterType;
  source_url?: string | undefined;
  source_external_id?: string | undefined; // e.g. itunes collection id, x handle
  etag?: string | undefined;
  last_modified?: string | undefined;
  cursor?: string | undefined; // adapter-owned json cursor
}

export interface WatchEntityRef {
  id?: string | undefined;
  display_name: string;
  entity_type: string;
  identifiers?: Record<string, string> | undefined; // rss_url, website, podcast_term, x_handle…
}

/** maps 1:1 onto world_events columns. */
export interface PolledEvent {
  canonical_event_key: string;
  event_type: WorldEventType;
  title: string;
  summary?: string | undefined;
  source_url: string;
  source_title?: string | undefined;
  source_published_at?: string | undefined; // iso8601
  content_hash?: string | undefined;
  raw_metadata: Record<string, unknown>;
}

export interface PollResult {
  events: PolledEvent[];
  etag?: string | undefined;
  last_modified?: string | undefined;
  cursor?: string | undefined;
  not_modified: boolean;
}

export interface SourceAdapter {
  type: AdapterType;
  /** propose subscriptions for an entity. read-only; user approval happens upstream. */
  discover(entity: WatchEntityRef): Promise<SubscriptionState[]>;
  poll(subscription: SubscriptionState): Promise<PollResult>;
  /** honest description of what this adapter can and cannot see — surfaced to prompts as coverage limitation. */
  coverage(): string;
}

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|ref_?$|mc_)/i;

export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
    u.search = "";
    for (const [k, v] of keep.sort(([a], [b]) => a.localeCompare(b))) u.searchParams.append(k, v);
    const path = u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname;
    return `${u.hostname}${path}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** publication time window: same-day bucket avoids resending one launch from five sources. */
export function timeWindowBucket(iso?: string): string {
  if (!iso) return "undated";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "undated" : d.toISOString().slice(0, 10);
}

export function buildCanonicalEventKey(
  entity: string,
  eventType: string,
  title: string,
  publishedAt?: string,
  url?: string,
): string {
  return [
    normalizeTitle(entity),
    eventType,
    normalizeTitle(title),
    timeWindowBucket(publishedAt),
    url ? canonicalUrl(url) : "nourl",
  ].join("|");
}
