import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, pollFeed } from "../src/rss";
import type { SubscriptionState } from "../src/adapter";

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Systems Thinkers Radio</title>
    <link>https://systemsthinkers.example</link>
    <item>
      <title><![CDATA[The Rise of Systems Thinkers]]></title>
      <link>https://systemsthinkers.example/episodes/rise?utm_source=rss</link>
      <guid isPermaLink="false">ep-42</guid>
      <pubDate>Mon, 08 Jun 2026 09:00:00 GMT</pubDate>
      <description>Why generalists &amp; synthesizers win.</description>
    </item>
    <item>
      <title>Feedback Loops 101</title>
      <link>https://systemsthinkers.example/episodes/loops</link>
      <guid isPermaLink="false">ep-41</guid>
      <pubDate>Mon, 01 Jun 2026 09:00:00 GMT</pubDate>
      <description>Stocks, flows, delays.</description>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Andera Blog</title>
  <entry>
    <title>Andera launched</title>
    <link rel="alternate" href="https://andera.dev/blog/launch"/>
    <link rel="self" href="https://andera.dev/blog/launch.atom"/>
    <id>tag:andera.dev,2026:launch</id>
    <published>2026-06-08T15:00:00Z</published>
    <summary>Today we are live.</summary>
  </entry>
  <entry>
    <title>Why we build</title>
    <link href="https://andera.dev/blog/why"/>
    <id>tag:andera.dev,2026:why</id>
    <updated>2026-05-20T10:00:00Z</updated>
    <content>Long version of the pitch.</content>
  </entry>
</feed>`;

function fakeFetch(body: string, opts: { etag?: string; recordHeaders?: Record<string, string>[] } = {}): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const sent = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    opts.recordHeaders?.push(sent);
    if (opts.etag && sent["If-None-Match"] === opts.etag) {
      return new Response(null, { status: 304 });
    }
    return new Response(body, { status: 200, headers: opts.etag ? { etag: opts.etag } : {} });
  }) as typeof fetch;
}

test("parseFeed handles rss2 items: title/link/guid/pubDate/description + cdata + entities", () => {
  const feed = parseFeed(RSS_FIXTURE);
  assert.equal(feed.kind, "rss");
  assert.equal(feed.feed_title, "Systems Thinkers Radio");
  assert.equal(feed.items.length, 2);
  const [ep] = feed.items;
  assert.equal(ep!.title, "The Rise of Systems Thinkers");
  assert.equal(ep!.guid, "ep-42");
  assert.equal(ep!.summary, "Why generalists & synthesizers win.");
  assert.equal(ep!.published_at, "2026-06-08T09:00:00.000Z");
});

test("parseFeed handles atom entries: title/link[rel=alternate]/id/published|updated/summary|content", () => {
  const feed = parseFeed(ATOM_FIXTURE);
  assert.equal(feed.kind, "atom");
  assert.equal(feed.feed_title, "Andera Blog");
  assert.equal(feed.items.length, 2);
  assert.equal(feed.items[0]!.link, "https://andera.dev/blog/launch");
  assert.equal(feed.items[0]!.guid, "tag:andera.dev,2026:launch");
  assert.equal(feed.items[1]!.published_at, "2026-05-20T10:00:00.000Z");
  assert.equal(feed.items[1]!.summary, "Long version of the pitch.");
});

test("pollFeed: first poll emits events + cursor; second poll with same cursor emits none", async () => {
  const sub: SubscriptionState = { id: "s1", adapter_type: "rss", source_url: "https://systemsthinkers.example/feed" };
  const first = await pollFeed(sub, { entityName: "Systems Thinkers Radio", eventType: "new_episode", fetchImpl: fakeFetch(RSS_FIXTURE) });
  assert.equal(first.events.length, 2);
  assert.equal(first.events[0]!.event_type, "new_episode");
  assert.ok(first.events[0]!.canonical_event_key.includes("systems thinkers radio|new_episode|the rise of systems thinkers|2026-06-08"));
  assert.ok(!first.events[0]!.canonical_event_key.includes("utm_source"), "tracking params stripped from canonical key");

  const second = await pollFeed({ ...sub, cursor: first.cursor }, { entityName: "Systems Thinkers Radio", eventType: "new_episode", fetchImpl: fakeFetch(RSS_FIXTURE) });
  assert.equal(second.events.length, 0);
  assert.equal(second.not_modified, false);
});

test("pollFeed: sends If-None-Match / If-Modified-Since and honors 304", async () => {
  const recorded: Record<string, string>[] = [];
  const impl = fakeFetch(RSS_FIXTURE, { etag: '"v1"', recordHeaders: recorded });
  const sub: SubscriptionState = { id: "s2", adapter_type: "rss", source_url: "https://systemsthinkers.example/feed" };

  const first = await pollFeed(sub, { entityName: "x", fetchImpl: impl });
  assert.equal(first.etag, '"v1"');

  const second = await pollFeed(
    { ...sub, etag: first.etag, last_modified: "Mon, 08 Jun 2026 09:00:00 GMT", cursor: first.cursor },
    { entityName: "x", fetchImpl: impl },
  );
  assert.equal(second.not_modified, true);
  assert.equal(second.events.length, 0);
  assert.equal(second.cursor, first.cursor, "cursor preserved across 304");
  assert.equal(recorded[1]!["If-None-Match"], '"v1"');
  assert.equal(recorded[1]!["If-Modified-Since"], "Mon, 08 Jun 2026 09:00:00 GMT");
});
