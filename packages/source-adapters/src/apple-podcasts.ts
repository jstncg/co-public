import { z } from "zod";
import { assertSafePublicURL } from "./safe-url";
import { RSSAdapter } from "./rss-adapter";
import type { WorldSourceItem } from "./types";

const searchResponseSchema = z.object({
  resultCount: z.number().int().nonnegative(),
  results: z.array(z.object({
    collectionId: z.number().int(),
    collectionName: z.string(),
    artistName: z.string(),
    feedUrl: z.url(),
    collectionViewUrl: z.url().optional(),
  }).passthrough()),
}).passthrough();

export class ApplePodcastsAdapter {
  readonly id = "apple_podcasts";
  readonly version = "apple-podcasts.v1";

  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly rss = new RSSAdapter(fetchImplementation),
  ) {}

  async resolveShow(query: string) {
    const trimmed = query.trim();
    if (trimmed.length < 2 || trimmed.length > 120) throw new Error("invalid podcast query");
    const url = new URL("https://itunes.apple.com/search");
    url.searchParams.set("term", trimmed);
    url.searchParams.set("media", "podcast");
    url.searchParams.set("entity", "podcast");
    url.searchParams.set("limit", "10");
    const response = await this.fetchImplementation(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Apple catalog returned HTTP ${response.status}`);
    return searchResponseSchema.parse(await response.json()).results;
  }

  async pollShow(feedURL: URL, conditional: { etag?: string; lastModified?: string } = {}) {
    await assertSafePublicURL(feedURL);
    return this.rss.poll({ url: feedURL, ...conditional });
  }

  async latestEpisodes(query: string): Promise<WorldSourceItem[]> {
    const [show] = await this.resolveShow(query);
    if (!show) return [];
    return (await this.pollShow(new URL(show.feedUrl))).items;
  }
}
