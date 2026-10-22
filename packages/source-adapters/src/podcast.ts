/**
 * podcast discovery via apple itunes search api → resolve rss feed → poll feed for episodes.
 * apple search is catalog lookup only, never the freshness source (goal.md §15.4).
 */
import { pollFeed } from "./rss";
import type { SourceAdapter, SubscriptionState, WatchEntityRef } from "./adapter";

const ITUNES_SEARCH = "https://itunes.apple.com/search";

export interface PodcastCatalogEntry {
  collection_id: number;
  name: string;
  artist: string;
  feed_url?: string | undefined;
  artwork_url?: string | undefined;
}

export async function searchPodcasts(term: string, fetchImpl: typeof fetch = fetch): Promise<PodcastCatalogEntry[]> {
  const url = `${ITUNES_SEARCH}?media=podcast&limit=5&term=${encodeURIComponent(term)}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`itunes search failed ${res.status}`);
  const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
  return (json.results ?? []).map((r) => ({
    collection_id: Number(r.collectionId ?? 0),
    name: String(r.collectionName ?? ""),
    artist: String(r.artistName ?? ""),
    feed_url: typeof r.feedUrl === "string" ? r.feedUrl : undefined,
    artwork_url: typeof r.artworkUrl600 === "string" ? r.artworkUrl600 : undefined,
  }));
}

export async function resolveFeedUrl(term: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const results = await searchPodcasts(term, fetchImpl);
  return results.find((r) => r.feed_url)?.feed_url;
}

export function makePodcastAdapter(opts: { fetchImpl?: typeof fetch } = {}): SourceAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    type: "podcast",
    async discover(entity: WatchEntityRef): Promise<SubscriptionState[]> {
      const explicit = entity.identifiers?.podcast_feed;
      if (explicit) return [{ id: `discovered:podcast:${explicit}`, adapter_type: "podcast", source_url: explicit, source_external_id: entity.display_name }];
      const feed = await resolveFeedUrl(entity.identifiers?.podcast_term ?? entity.display_name, fetchImpl);
      if (!feed) return [];
      return [{ id: `discovered:podcast:${feed}`, adapter_type: "podcast", source_url: feed, source_external_id: entity.display_name }];
    },
    poll(sub) {
      return pollFeed(sub, {
        entityName: sub.source_external_id ?? sub.source_url ?? "unknown",
        eventType: "new_episode",
        fetchImpl,
      });
    },
    coverage() {
      return "public podcast rss feeds resolved via the itunes catalog; episode metadata only, no transcript unless the feed carries one";
    },
  };
}
