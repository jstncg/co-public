# Phase 2 source awareness — 2026-09-05

## Product invariant

A source change may wake Co's backstage work. It does not, by itself, justify a notification. “Always working” means holding legitimate responsibility while the member is absent; it does not mean manufacturing proof of activity.

## Implemented seam

The existing persistent scout is now the single convergence point for polling and event-driven source awareness:

- `poll`, `event`, and `hybrid` wake policies are explicit and immutable under an idempotency key;
- freshness, expiry, last attempt, last successful snapshot, last material change, failure count, provider cursor, and source-ledger watermark are inspectable;
- authenticated event hints retain only an optional payload digest, are persisted before acknowledgment, and are deduplicated by provider-stable external ID;
- reusing an external ID with a different type, cursor, or payload fails closed;
- hints advance a durable generation and make the same authoritative snapshot read due;
- several hints before admission collapse into one read;
- a hint arriving during that read remains unprocessed and causes one catch-up read;
- each run captures its trigger and generation, so an observation acknowledges only what that read could have covered;
- event-only watches take an initial baseline, then remain quiet until woken;
- overdue polling work is recovered by the ordinary worker materialization pass and missed intervals skip forward;
- expiry stops new work without contacting the member and without deleting history.

The source hint is not evidence, and raw optional hint payload is not retained. Only the existing exact successful, outcome-scoped, non-truncated read receipt with snapshotted arguments can satisfy an observation. Only a runtime-computed fingerprint change creates one ambient evaluation; an unchanged read records healthy quietness.

## Quietness and failure behavior

Health is derived locally as `never_synced`, `healthy`, `stale`, `degraded`, `paused`, `repair_required`, `expired`, or `retired`. Looking at health costs no model call. Expiry is silent. Repeated read failure retains the existing fail-safe: after three terminal failures, admission stops and one held operator repair item is created. No wake path has a connector or relationship-delivery capability.

## Evidence

`test/scouts.test.ts` executes the composed behavior against real SQLite, including burst coalescing, stale-event deduplication, an event injected during the actual tool read, captured-generation acknowledgment, one catch-up admission, freshness states, silent expiry, authenticated HTTP wake deduplication, no per-event ambient job, no outbound delivery, and additive migration from schema v54 without losing the prior event or scout.

## Honest limit

This is a harness capability with simulated sources. A production calendar, inbox, call, or location integration still needs its provider-specific authenticated webhook adapter, cursor semantics, consent, account reconnect flow, and live qualification. Provider notifications that expose only “something changed” are intentionally useful: they wake an authoritative bounded read rather than becoming truth themselves.

“Catch-up” here means a subsequent snapshot, not guaranteed replay of every missed provider event. An opaque stored cursor alone does not implement provider history recovery.

## Continuation hardening

The [continuation audit](continuation-audit-2026-09-05.md) adds composed SQLite regressions in `test/source-lifecycle.test.ts`. Restore remaps source watermarks through stable event IDs. Admission rechecks in-flight work under the write lock, and same-millisecond generations receive distinct run identities. A damaged definition is held for repair without discarding it or starving healthy sources.

Watch state is checked at work entry and immediately before tool initiation. Pausing or expiring a watch blocks a queued read, including one proposed by an already-running model call. An already-started remote read cannot be recalled; its receipt is retained, but it cannot produce a new observation after the stop. Expired legacy watches are not reopened as repair requests. Expiry maintenance is bounded and indexed, and scout list surfaces do not load observation history; detail surfaces still expose it.
