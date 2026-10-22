import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCanonicalEventKey, canonicalUrl } from "../src/adapter";
import { resolveFeedUrl } from "../src/podcast";
import { makeXAdapter, FeatureDisabledError } from "../src/x";

test("canonical event key dedupes the same launch across url variants (goal.md §24)", () => {
  const a = buildCanonicalEventKey("Andera", "launch", "Andera Launched!", "2026-06-08T15:00:00Z", "https://www.andera.dev/blog/launch?utm_source=x");
  const b = buildCanonicalEventKey("andera", "launch", "andera launched", "2026-06-08T02:00:00Z", "https://andera.dev/blog/launch/");
  assert.equal(a, b);

  const differentDay = buildCanonicalEventKey("andera", "launch", "andera launched", "2026-06-10T02:00:00Z", "https://andera.dev/blog/launch");
  assert.notEqual(a, differentDay);
});

test("canonicalUrl strips tracking params, hash, www, trailing slash", () => {
  assert.equal(canonicalUrl("https://www.example.com/a/?utm_source=x&b=1#frag"), "example.com/a?b=1");
});

test("itunes lookup resolves feedUrl from search results", async () => {
  const impl = (async () =>
    new Response(JSON.stringify({
      results: [
        { collectionId: 1, collectionName: "No Feed Pod", artistName: "A" },
        { collectionId: 2, collectionName: "Systems Thinkers Radio", artistName: "B", feedUrl: "https://systemsthinkers.example/feed" },
      ],
    }), { status: 200 })) as unknown as typeof fetch;
  assert.equal(await resolveFeedUrl("systems thinkers", impl), "https://systemsthinkers.example/feed");
});

test("x adapter throws FeatureDisabledError without X_API_BEARER", async () => {
  const adapter = makeXAdapter({});
  await assert.rejects(
    () => adapter.poll({ id: "s", adapter_type: "x", source_external_id: "someone" }),
    FeatureDisabledError,
  );
  await assert.rejects(
    () => adapter.discover({ display_name: "Someone", entity_type: "person", identifiers: { x_handle: "@someone" } }),
    FeatureDisabledError,
  );
});
