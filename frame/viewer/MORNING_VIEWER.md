# Viewer — the memory page (overnight build)

Mobile-first webpage where a user reads everything Co holds about them AND corrects it:
the feed (what they sent + Co's reactions inline), what Co knows (the claims, grouped
and human, each with quiet "not right" / "edit" actions), and threads (open topics +
commitments). One page per tenant, behind an unguessable token URL. No accounts, zero
dependencies (stdlib only).

## Open it on your phone

The server is already running on port 8811 (started overnight). Your page:

```
./viewer/run.sh --print        # prints every tenant URL (localhost / LAN / tailscale)
```

Use the tailscale URL (100.107.37.101) from your phone, or the LAN one on home wifi.
Dennis's page is the `dennis` tenant. Tokens live in `viewer/tokens.json` (gitignored,
chmod 600, stable across restarts).

If the server isn't up: `./viewer/run.sh` (foreground) or add `&`.

## What renders (verified against live data)

- dennis: 4 sends with reactions (2 one-liners in the accent red, 2 glances), 9,514
  claims grouped into who you are / patterns / people / commitments, the 4 contradiction
  edges as "held in tension", shipping-avoidance as an open topic.
- demo3: link card with yt-dlp enrichment title + grayscale YouTube thumbnail.
- p15559990000: 2 sends, one "co stayed quiet", empty knows (no claims db) degrades to
  "co is still listening".
- jae / fresh tenants: fully empty states, still reads like a page and not an error.

## Editable memory (the one write)

Every claim in "what co knows" has two quiet text-link actions, mobile tap targets, no
modals: "not right" (one tap → strike + "noted"; tap undo to take it back) and "edit"
(inline box → your text shows as pending, original struck above it). Verified end to end
on `smoketest_eval`: POSTs land, overlay renders on reload, undo deletes the pending row.

The contract (agreed with the engine agent): rows insert into `user_corrections` in the
SAME per-tenant claims db. The engine processes a row, then flips `processed=1`; the
viewer only overlays `processed=0` rows.

```sql
CREATE TABLE IF NOT EXISTS user_corrections (
  id INTEGER PRIMARY KEY, claim_id INTEGER, action TEXT,   -- 'wrong' | 'edit'
  text TEXT, created_at TEXT, processed INTEGER DEFAULT 0)
```

Endpoint (guarded by the per-tenant token; the claim must exist in that tenant's own db,
so cross-tenant writes are structurally impossible):

```
POST /v/<token>/correct
{"claim_id": 7, "action": "wrong" | "edit" | "undo", "text": "only for edit, <=500 chars"}
→ {"ok": true, "id": 12}     (400 bad action or empty edit, 404 unknown claim or token)
```

One pending correction per claim: a new mark supersedes the old unprocessed one; "undo"
deletes the unprocessed row and never touches processed history.

## Where the data comes from (read-only, except user_corrections)

- `claims/claims[_<tenant>].db` — the model-of-them (claims + confidence + salience + evidence)
- `claims/<db>.co_memory.db` — send history, tiers, reactions, themes
- `~/.co/journal/<tenant>.json` — the Saga (captures, daily-question answers, link reads)
- `~/.co_<tenant>_sendblue_transcript.json` — engine-mode conversation, if any

New tenants appear without a restart (discovery runs per request). Unknown claim types
(the onboarding extractor mints `work`, `passion`, ...) fold into "who you are".

## Known gaps

- Thumbnails only for YouTube (derived from the video id); TikTok/IG enrichment is
  title-only because link_read stores text, not images.
- No screenshots-they-sent rendering: the pipeline doesn't store inbound MMS media yet.
- Claims display dedups near-duplicate statements per group (word-overlap 0.5); the
  underlying store still has heavy email-derived redundancy, viewer hides the worst.
- Transcript conversations render undated (the sendblue transcript stores no timestamps).
- Token URL is the only auth; server binds 0.0.0.0. Fine on tailscale/LAN, do not port
  forward it raw.
