/**
 * public website monitor: conditional GET + sha256 content hash compare (goal.md §15.4).
 * change event skeleton only — structured event extraction happens downstream via the model
 * gateway. no login bypass, no anti-bot circumvention, user-approved public pages only.
 */
import { createHash } from "node:crypto";
import { buildCanonicalEventKey, type PollResult, type SourceAdapter, type SubscriptionState, type WatchEntityRef } from "./adapter";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** strip volatile markup so trivial rerenders (nonces, timestamps in comments) don't fire changes. */
function stableText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface PollSiteOptions {
  entityName: string;
  fetchImpl?: typeof fetch | undefined;
}

export async function pollSite(sub: SubscriptionState, opts: PollSiteOptions): Promise<PollResult> {
  if (!sub.source_url) throw new Error(`subscription ${sub.id} has no source_url`);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "User-Agent": "co-radar/0.1 (+site monitor)" };
  if (sub.etag) headers["If-None-Match"] = sub.etag;
  if (sub.last_modified) headers["If-Modified-Since"] = sub.last_modified;

  const res = await fetchImpl(sub.source_url, { headers });
  if (res.status === 304) {
    return { events: [], etag: sub.etag, last_modified: sub.last_modified, cursor: sub.cursor, not_modified: true };
  }
  if (!res.ok) throw new Error(`site fetch failed ${res.status}: ${sub.source_url}`);

  const hash = sha256(stableText(await res.text()));
  const base = {
    etag: res.headers.get("etag") ?? undefined,
    last_modified: res.headers.get("last-modified") ?? undefined,
    cursor: hash, // cursor stores the last content hash
    not_modified: false,
  };
  if (sub.cursor === hash) return { ...base, events: [] };
  if (!sub.cursor) return { ...base, events: [] }; // first poll establishes the baseline, no event

  const now = new Date().toISOString();
  return {
    ...base,
    events: [
      {
        canonical_event_key: buildCanonicalEventKey(opts.entityName, "other", `page updated ${hash.slice(0, 12)}`, now, sub.source_url),
        event_type: "other",
        title: `${opts.entityName}: watched page changed`,
        source_url: sub.source_url,
        source_published_at: now,
        content_hash: hash,
        raw_metadata: { previous_hash: sub.cursor },
      },
    ],
  };
}

export function makeSiteMonitorAdapter(opts: { fetchImpl?: typeof fetch } = {}): SourceAdapter {
  return {
    type: "sitemonitor",
    async discover(entity: WatchEntityRef): Promise<SubscriptionState[]> {
      const url = entity.identifiers?.website;
      if (!url) return [];
      return [{ id: `discovered:site:${url}`, adapter_type: "sitemonitor", source_url: url, source_external_id: entity.display_name }];
    },
    poll(sub) {
      return pollSite(sub, { entityName: sub.source_external_id ?? sub.source_url ?? "unknown", fetchImpl: opts.fetchImpl });
    },
    coverage() {
      return "user-approved public pages only; detects that a page changed, not what changed — extraction runs downstream";
    },
  };
}
