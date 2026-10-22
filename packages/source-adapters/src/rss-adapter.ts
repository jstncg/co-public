import { XMLParser } from "fast-xml-parser";
import { contentHash, safeConditionalFetch } from "./http";
import type { ConditionalSourceAdapter, WorldSourceItem } from "./types";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });
const list = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string | null => {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) return String((value as { "#text": unknown })["#text"]);
  return null;
};

export class RSSAdapter implements ConditionalSourceAdapter {
  readonly id = "rss_atom";
  readonly version = "rss-atom.v1";

  constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  async poll(input: Parameters<ConditionalSourceAdapter["poll"]>[0]) {
    const fetched = await safeConditionalFetch({ ...input, fetchImplementation: this.fetchImplementation });
    const base = { ...(fetched.etag ? { etag: fetched.etag } : {}), ...(fetched.lastModified ? { lastModified: fetched.lastModified } : {}) };
    if (fetched.notModified) return { status: "unchanged" as const, ...base, items: [] };
    const xml = new TextDecoder().decode(fetched.body);
    const parsed = parser.parse(xml) as Record<string, any>;
    const channel = parsed.rss?.channel;
    const feed = parsed.feed;
    const rawItems = channel ? list(channel.item) : list(feed?.entry);
    const publisher = text(channel?.title ?? feed?.title);
    const retrievedAt = new Date().toISOString();
    const hash = contentHash(fetched.body);
    const items: WorldSourceItem[] = rawItems.slice(0, 100).flatMap((item: any) => {
      const atomLink = list(item.link).find((link: any) => typeof link === "object" && (!link["@_rel"] || link["@_rel"] === "alternate"))?.["@_href"];
      const urlValue = text(atomLink ?? item.link ?? item.guid?.["#text"] ?? item.guid);
      const title = text(item.title);
      if (!urlValue || !title) return [];
      const url = new URL(urlValue, fetched.url).toString();
      const externalId = text(item.guid?.["#text"] ?? item.guid ?? item.id) ?? url;
      return [{
        externalId,
        title,
        summary: text(item.description ?? item.summary ?? item.content),
        url,
        publishedAt: text(item.pubDate ?? item.published ?? item.updated),
        receipt: {
          adapter: this.id,
          adapterVersion: this.version,
          canonicalUrl: url,
          title,
          publisher,
          retrievedAt,
          coverage: "text" as const,
          contentHash: hash,
          metadata: { feedUrl: fetched.url.toString() },
        },
      }];
    });
    return { status: "changed" as const, ...base, items };
  }
}
