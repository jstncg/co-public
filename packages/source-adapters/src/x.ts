/**
 * x adapter — feature-flagged (goal.md §15.4, §27.4). explicit public handles only,
 * official api endpoints only, respects rate limits and deletion.
 * BLOCKED: requires paid X API credentials (X_API_BEARER). without them every call throws.
 */
import { buildCanonicalEventKey, type PollResult, type SourceAdapter, type SubscriptionState, type WatchEntityRef } from "./adapter";

export class FeatureDisabledError extends Error {
  constructor(feature: string) {
    super(`feature disabled: ${feature}`);
    this.name = "FeatureDisabledError";
  }
}

const X_API = "https://api.x.com/2";

export function makeXAdapter(env: { X_API_BEARER?: string }, fetchImpl: typeof fetch = fetch): SourceAdapter {
  const requireBearer = (): string => {
    if (!env.X_API_BEARER) throw new FeatureDisabledError("x_adapter (set X_API_BEARER and enable the x_adapter flag)");
    return env.X_API_BEARER;
  };
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const res = await fetchImpl(`${X_API}${path}`, { headers: { Authorization: `Bearer ${requireBearer()}` } });
    if (!res.ok) throw new Error(`x api ${res.status}: ${path}`);
    return (await res.json()) as Record<string, unknown>;
  };

  return {
    type: "x",
    async discover(entity: WatchEntityRef): Promise<SubscriptionState[]> {
      const handle = entity.identifiers?.x_handle?.replace(/^@/, "");
      if (!handle) return [];
      requireBearer(); // fail fast when flagged off — no silent surveillance setup
      return [{ id: `discovered:x:${handle}`, adapter_type: "x", source_external_id: handle }];
    },
    async poll(sub: SubscriptionState): Promise<PollResult> {
      const handle = sub.source_external_id?.replace(/^@/, "");
      if (!handle) throw new Error(`x subscription ${sub.id} has no handle`);
      // BLOCKED: live path untested without paid credentials. official endpoints only.
      const user = await get(`/users/by/username/${encodeURIComponent(handle)}`);
      const userId = (user.data as { id?: string } | undefined)?.id;
      if (!userId) return { events: [], cursor: sub.cursor, not_modified: false };
      const since = sub.cursor ? `&since_id=${encodeURIComponent(sub.cursor)}` : "";
      const timeline = await get(`/users/${userId}/tweets?max_results=10&tweet.fields=created_at&exclude=replies,retweets${since}`);
      const tweets = ((timeline.data ?? []) as Array<{ id: string; text: string; created_at?: string }>);
      return {
        events: tweets.map((t) => ({
          canonical_event_key: buildCanonicalEventKey(handle, "new_post", t.text.slice(0, 80), t.created_at, `https://x.com/${handle}/status/${t.id}`),
          event_type: "new_post" as const,
          title: t.text.slice(0, 120),
          source_url: `https://x.com/${handle}/status/${t.id}`,
          source_published_at: t.created_at,
          raw_metadata: { tweet_id: t.id },
        })),
        cursor: tweets[0]?.id ?? sub.cursor,
        not_modified: tweets.length === 0,
      };
    },
    coverage() {
      return "explicit public x handles via the official api only; nothing without credentials and the x_adapter flag";
    },
  };
}
