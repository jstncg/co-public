import { describe, expect, test, vi } from "vitest";
import { ApplePodcastsAdapter, HTTPChangeAdapter, RSSAdapter, UnsafeSourceURLError, XSourceAdapter, assertSafePublicURL, compileSanitizedSearchQuery, extractArticleHTML, fetchPublicArticle, safeConditionalFetch } from "../src/index";

const publicDNS = async () => [{ address: "93.184.216.34", family: 4 }];

describe("safe public fetch", () => {
  test("rejects private and rebinding-style DNS answers", async () => {
    await expect(assertSafePublicURL(new URL("https://feed.example"), async () => [{ address: "127.0.0.1", family: 4 }])).rejects.toBeInstanceOf(UnsafeSourceURLError);
  });

  test("revalidates every redirect target", async () => {
    const mockFetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }));
    await expect(safeConditionalFetch({ url: new URL("https://feed.example"), lookup: publicDNS, fetchImplementation: mockFetch as typeof fetch })).rejects.toBeInstanceOf(UnsafeSourceURLError);
  });

  test("enforces response size after download when length is absent", async () => {
    const mockFetch = vi.fn(async () => new Response("x".repeat(11)));
    await expect(safeConditionalFetch({ url: new URL("https://feed.example"), lookup: publicDNS, fetchImplementation: mockFetch as typeof fetch, maxBytes: 10 })).rejects.toThrow("content limit");
  });
});

test("RSS emits receipt-backed items and honors conditional 304", async () => {
  const xml = `<?xml version="1.0"?><rss><channel><title>Official Room</title><item><guid>a-1</guid><title>Applications open</title><link>https://example.com/a</link><description>Until Friday</description></item></channel></rss>`;
  const changed = new RSSAdapter(vi.fn(async () => new Response(xml, { headers: { "content-type": "application/rss+xml", etag: '"v1"' } })) as typeof fetch);
  const result = await changed.poll({ url: new URL("https://93.184.216.34/feed") });
  expect(result.items[0]?.receipt.adapterVersion).toBe("rss-atom.v1");
  expect(result.items[0]?.url).toBe("https://example.com/a");

  const unchanged = new RSSAdapter(vi.fn(async () => new Response(null, { status: 304 })) as typeof fetch);
  expect((await unchanged.poll({ url: new URL("https://93.184.216.34/feed"), etag: '"v1"' })).status).toBe("unchanged");
});

test("search receives a short compilation, not raw history", () => {
  const query = compileSanitizedSearchQuery([{ kind: "topic", value: "systems thinking" }, { kind: "place", value: "Los Angeles" }]);
  expect(query).toBe('"systems thinking" "Los Angeles"');
  expect(query.length).toBeLessThanOrEqual(320);
});

test("X cannot make a live call while disabled", async () => {
  await expect(new XSourceAdapter(false).poll()).rejects.toThrow("disabled");
});

test("Apple Podcasts resolves only documented catalog feed URLs", async () => {
  const catalogFetch = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({ resultCount: 1, results: [{ collectionId: 42, collectionName: "Builders", artistName: "A Person", feedUrl: "https://feeds.example.com/show.xml" }] }), { headers: { "content-type": "application/json" } }));
  const adapter = new ApplePodcastsAdapter(catalogFetch as typeof fetch);
  const shows = await adapter.resolveShow("builders");
  expect(new URL(catalogFetch.mock.calls[0]?.[0] as URL).searchParams.get("entity")).toBe("podcast");
  expect(shows[0]?.feedUrl).toBe("https://feeds.example.com/show.xml");
});

test("public-page adapter emits only a new hash", async () => {
  const mockFetch = vi.fn(async () => new Response("applications open", { headers: { "content-type": "text/plain" } }));
  const adapter = new HTTPChangeAdapter(mockFetch as typeof fetch);
  const changed = await adapter.poll({ url: new URL("https://93.184.216.34/opportunities") });
  const unchanged = await adapter.poll({ url: new URL("https://93.184.216.34/opportunities"), previousContentHash: changed.items[0]!.receipt.contentHash! });
  expect(changed.status).toBe("changed");
  expect(unchanged.status).toBe("unchanged");
});

test("article extraction keeps visible text and receipt metadata without scripts", async () => {
  const html = `<!doctype html><html><head><title>A &amp; B</title><meta property="og:site_name" content="Example Journal"><meta name="author" content="A Person"><meta property="article:published_time" content="2026-07-19T12:00:00Z"><link rel="canonical" href="/essays/one"></head><body><article><h1>A &amp; B</h1><p>The visible argument.</p><script>stealPrivateHistory()</script></article></body></html>`;
  const article = extractArticleHTML(html, new URL("https://example.com/tracking?id=1"), new Date("2026-07-20T00:00:00Z"));
  expect(article).toMatchObject({ title: "A & B", publisher: "Example Journal", author: "A Person", canonicalUrl: "https://example.com/essays/one", publishedAt: "2026-07-19T12:00:00Z" });
  expect(article.text).toContain("The visible argument.");
  expect(article.text).not.toContain("stealPrivateHistory");
});

test("article fetch preserves the SSRF-safe fetch boundary and hashes the receipt", async () => {
  const mockFetch = vi.fn(async () => new Response("<html><body><p>Public text.</p></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } }));
  const article = await fetchPublicArticle({ url: new URL("https://93.184.216.34/article"), fetchImplementation: mockFetch as typeof fetch });
  expect(article.receipt.coverage).toBe("text");
  expect(article.receipt.contentHash).toMatch(/^[a-f0-9]{64}$/);
});
