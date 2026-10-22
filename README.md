# co

## Runtime migration (2026-09-05)

The durable TypeScript harness now lives in `packages/runtime` (`@co/runtime`).
This is the destination for ongoing harness development; the original diyagi checkout is
retained as migration provenance, not removed. Run `pnpm check:runtime` to verify it or
`CO_HOME=/absolute/isolated-state pnpm co chat` to start its CLI after configuring an isolated profile.

As of 2026-09-06, the Dennis relationship's live conversational brain is this runtime. The existing
`frame/` router remains the single Linq sender and retains burst, reader, app and voice compatibility;
other tenants use an isolated incumbent fallback during the incremental migration. See
`packages/runtime/MIGRATION.md` for the exact ownership and remaining responsibility-transfer gates.
Never run two send-capable brains for one member.

> send co anything that catches you. it understands why, remembers what keeps returning, and helps the
> right things become part of your life.
>
> **this repo is the only canon.** anything co-related living anywhere else is either an input, a
> mirror, or running infrastructure — all mapped below.

## reading order

1. `goal.md` — the canonical build brief (rev 3). §0 tells any agent what to read next.
2. `AGENTS.md` — multi-agent coordination rules (canon, territory, versioning, the local stack).
3. `tasks.md` — live status of the six-week plan.
4. `docs/` — the evidence and decisions:
   - `interface-first-principles.md` — the correct interface for AI (15-agent adversarial research)
   - `imessage-rail-context.md` — the live predecessor product and its lessons
   - `habit-science.md` — the habit stack and honest reward mechanics
   - `goal-amendments-001.md` — the production-evidence amendments
   - `parallel-track-synthesis.md` — training-stack analogy, talent end-game, positioning bank
   - `ingest-contract.md` — the transport seam contract
   - `adr/` — every consequential decision, numbered
5. `_private/` — gitignored symlinks to the thesis vault (idea ledger, canon armory, mission doc).
   never committed, never pushed.

## production checks

Node 24 and pnpm are pinned by `.node-version` and `packageManager`. One command runs the merge gate:

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs repository-wide correctness lint, stricter type-aware lint on the credential,
action, and Google-awareness boundaries, TypeScript 6 across every workspace (including web), and
all package tests. GitHub runs the same command, the real-browser action canary, and the Gmail pgTAP
suite against a fresh Supabase database on every pull request and push to `main`.

## Gmail awareness (dark by default)

`@co/google-workspace` plus the web and Trigger workers implement authenticated Gmail Pub/Sub
wakeups, a durable coalescing queue, bounded History API reads, cursor-expiry reconciliation,
redaction, source deletion, and automatic watch renewal. Push delivery performs no model call and
stores no OAuth token. Both `FEATURE_AMBIENT_AWARENESS` and `FEATURE_GMAIL_AWARENESS` must be enabled
after the connector, Pub/Sub identity, migration, Trigger deployment, and smoke test are complete.
The deployment contract is in `docs/specs/gmail-awareness.md` (local canon; intentionally ignored).

## the map (everything, one place)

| what | where | state |
|---|---|---|
| canon repo | `projects/co` (this repo, branch `main`) | source of truth |
| codex's live build | `frame/co/` — its own git repo, pushes here as branch `codex/dev` | 24 migrations, 120 node + 98 db tests |
| frozen early snapshot | branch `codex/rev3-continuity` | historical |
| the live imessage rail | `projects/frame` (branch `co-v1-overnight`, tag `co-rail-baseline-2026-07-20`) | production — off-limits except via the ingest contract |
| dual-write receiver | `~/co-ingest` (git worktree of this repo) → `:3010`, cron watchdog `co-ingest-watchdog` (every minute; launchd refused new agents on this box) | LIVE |
| sender archive journal | `~/.donna/co_dualwrite_archive.jsonl` — every envelope ever emitted; replay rebuilds the canonical record after any db reset | LIVE |
| local database | supabase via OrbStack, `127.0.0.1:54321` | LIVE — re-run `scripts/provision-founder.mjs` after any db reset |
| golden regression set | `evals/golden/` (data/ local-only, gitignored) | 279 turns; founder review queue in data/ |
| thesis vault (private) | `frame/_private/00_CORE/` — symlinked in `_private/` | idea ledger, canon, mission |
| original brief | `Secretary-Production/tmp/goal.md` | immutable archive, superseded by rev 3 |

## running services on this machine

- iMessage router (the live co; carrier selected by `CO_RAIL`) — launchd
  `com.dennis.imessage-donna`, webhook `:8099`, dual-writes here
- witness engine — node `:8090`
- ingest receiver — `:3010` (worktree above)
- supabase local stack — OrbStack containers
- proactive tick — cron `*/15 8-22`

## the one rule

work happens in branches of this repo (or gets pushed into it, like `codex/dev`). a document, decision,
or line of code that isn't reachable from this repo does not exist.
