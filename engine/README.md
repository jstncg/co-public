# co_engine — THE engine

One importable package for every organ in the family. This is the consolidation the
monorepo exists for: frame and kyo ran sibling forks of the same organs (eyes, memory,
restraint, scheduling) for a month; this package is where they become one.

## The law (effective 2026-07-29)

1. **New code imports organs through `co_engine`** (`from co_engine import ontology`),
   never by path-hacking into `frame/claims`.
2. **Organs migrate in file-by-file.** While an organ still lives in `frame/claims`,
   `co_engine` resolves it from there (lazy loader in `__init__.py`) — callers never
   change when a file physically moves. Move the file, delete it from `_FRAME_ORGANS`,
   done.
3. **kyo reaches the same organs through its `engine_bridge` pointed here.** One engine,
   two products, zero forked organs.

## Native modules (migrated, tested)

- **`ontology`** — kyo's best structural work on frame's claim store: personal ontology
  kinds, the signal hierarchy as provenance (stated > behavioral > passive), bi-temporal
  claims (record time vs valid time, `as_of` reads), tensions (contradictions become
  edges, resolved only by the user's word), the forget cascade (supersede chains,
  dependent inferences, embeddings, tombstones — or "deleted" is a lie), and consumption
  events (one row per watched thing, segments in evidence — a podcast must not outweigh
  everything they ever said).
- **`reconciler`** — one spine for everything scheduled: durable desired state
  (`frame/reconciler.json`) + a fired-occurrence ledger + pure due-math. One cron line
  replaces the pile of hardcoded ones. The nightly organs (backup, ingest, weave, scout)
  ride it today; the tick migrates next.

## Migration queue (still in frame/claims, resolved lazily)

find_engine · watch_engine · episode_engine · research_engine · deferred_watch · journal
· anchors · link_read · co_react · daily_text · proactive_tick · forget · export_data ·
shadow_review · weave · session_compact · anthro · tz_dynamic · disposition · llm ·
return_engine

## Tests

    python3 -m pytest engine/tests/ -q     # offline, no keys, fresh sqlite per test
