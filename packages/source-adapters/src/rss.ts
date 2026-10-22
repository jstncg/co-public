/** rss/atom poller with conditional GET (etag / last-modified) — goal.md §15.4. no heavy deps. */
import type { WorldEventType } from "@co/contracts";
import {
  buildCanonicalEventKey,
  type PollResult,
  type PolledEvent,
  type SourceAdapter,
  type SubscriptionState,
  type WatchEntityRef,
} from "./adapter";

export interface FeedItem {
  title: string;
  link?: string | undefined;
  guid?: string | undefined;
  published_at?: string | undefined;
  summary?: string | undefined;
}

export interface ParsedFeed {
  kind: "rss" | "atom";
  feed_title?: string | undefined;
  items: FeedItem[];
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}

function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]!);
  return out;
}

function tagText(block: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
    if (m?.[1] !== undefined) {
      const v = decode(m[1]);
      if (v) return v;
    }
  }
  return undefined;
}

function atomLink(block: string): string | undefined {
  const links = block.match(/<link\s[^>]*?\/?>(?:<\/link>)?/g) ?? [];
  let fallback: string | undefined;
  for (const l of links) {
    const href = l.match(/href="([^"]*)"/)?.[1];
    if (!href) continue;
    const rel = l.match(/rel="([^"]*)"/)?.[1];
    if (!rel || rel === "alternate") return decode(href);
    fallback ??= decode(href);
  }
  return fallback;
}

function toIso(s?: string): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function parseFeed(xml: string): ParsedFeed {
  const isAtom = /<feed[\s>]/.test(xml) && !/<rss[\s>]/.test(xml);
  if (isAtom) {
    const items: FeedItem[] = blocks(xml, "entry").map((b) => ({
      title: tagText(b, "title") ?? "(untitled)",
      link: atomLink(b),
      guid: tagText(b, "id"),
      published_at: toIso(tagText(b, "published", "updated")),
      summary: tagText(b, "summary", "content"),
    }));
    // feed title = first <title> outside entries; cheap approach: title before first <entry>
    const head = xml.split(/<entry[\s>]/)[0]!;
    return { kind: "atom", feed_title: tagText(head, "title"), items };
  }
  const items: FeedItem[] = blocks(xml, "item").map((b) => ({
    title: tagText(b, "title") ?? "(untitled)",
    link: tagText(b, "link") ?? tagText(b, "guid"),
    guid: tagText(b, "guid") ?? tagText(b, "link"),
    published_at: toIso(tagText(b, "pubDate")),
    summary: tagText(b, "description"),
  }));
  const head = xml.split(/<item[\s>]/)[0]!;
  return { kind: "rss", feed_title: tagText(head, "title"), items };
}

interface FeedCursor {
  seen: string[]; // last N guids/links — dedupe for feeds without reliable dates
}

function readCursor(raw?: string): FeedCursor {
  if (!raw) return { seen: [] };
  try {
    const parsed = JSON.parse(raw) as FeedCursor;
    return { seen: Array.isArray(parsed.seen) ? parsed.seen : [] };
  } catch {
    return { seen: [] };
  }
}

export interface PollFeedOptions {
  entityName: string;
  eventType?: WorldEventType | undefined; // "new_post" for blogs, "new_episode" for podcasts
  fetchImpl?: typeof fetch | undefined;
  maxSeen?: number | undefined;
}

export async function pollFeed(sub: SubscriptionState, opts: PollFeedOptions): Promise<PollResult> {
  if (!sub.source_url) throw new Error(`subscription ${sub.id} has no source_url`);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "User-Agent": "co-radar/0.1 (+rss poller)" };
  if (sub.etag) headers["If-None-Match"] = sub.etag;
  if (sub.last_modified) headers["If-Modified-Since"] = sub.last_modified;

  const res = await fetchImpl(sub.source_url, { headers });
  if (res.status === 304) {
    return { events: [], etag: sub.etag, last_modified: sub.last_modified, cursor: sub.cursor, not_modified: true };
  }
  if (!res.ok) throw new Error(`feed fetch failed ${res.status}: ${sub.source_url}`);

  const feed = parseFeed(await res.text());
  const cursor = readCursor(sub.cursor);
  const seen = new Set(cursor.seen);
  const eventType = opts.eventType ?? "new_post";

  const events: PolledEvent[] = [];
  for (const item of feed.items) {
    const dedupeId = item.guid ?? item.link ?? `${item.title}|${item.published_at ?? ""}`;
    if (seen.has(dedupeId)) continue;
    seen.add(dedupeId);
    events.push({
      canonical_event_key: buildCanonicalEventKey(opts.entityName, eventType, item.title, item.published_at, item.link),
      event_type: eventType,
      title: item.title,
      summary: item.summary?.slice(0, 500),
      source_url: item.link ?? sub.source_url,
      source_title: feed.feed_title,
      source_published_at: item.published_at,
      raw_metadata: { guid: item.guid, feed_kind: feed.kind },
    });
  }

  const maxSeen = opts.maxSeen ?? 500;
  return {
    events,
    etag: res.headers.get("etag") ?? undefined,
    last_modified: res.headers.get("last-modified") ?? undefined,
    cursor: JSON.stringify({ seen: [...seen].slice(-maxSeen) } satisfies FeedCursor),
    not_modified: false,
  };
}

export function makeRssAdapter(opts: { fetchImpl?: typeof fetch } = {}): SourceAdapter {
  return {
    type: "rss",
    async discover(entity: WatchEntityRef): Promise<SubscriptionState[]> {
      const url = entity.identifiers?.rss_url;
      if (!url) return [];
      return [{ id: `discovered:rss:${url}`, adapter_type: "rss", source_url: url }];
    },
    poll(sub) {
      return pollFeed(sub, { entityName: sub.source_external_id ?? sub.source_url ?? "unknown", fetchImpl: opts.fetchImpl });
    },
    coverage() {
      return "public rss/atom feeds only; sees exactly what the publisher includes in the feed, nothing behind logins";
    },
  };
}
