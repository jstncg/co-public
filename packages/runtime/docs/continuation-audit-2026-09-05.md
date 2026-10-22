# Continuation audit — 2026-09-05

Scope: current `goal.md`, the source-awareness slice at `8946699`, inquiry expiry, worker/tool entry, portable restore, and relevant Co audit guidance. This is a targeted continuation review, not a new full-harness or production certification.

## Where we are

The implementation has durable deposits, bounded backstage inquiry, a common relationship-delivery arbiter, and event/poll source watches. The remaining Phase 2 work is responsibility linkage and cumulative budgets/fair scheduling. Live rail/source qualification, the two useful end-to-end loops, and non-founder pilot evidence remain open. Passing local tests does not establish judgment, useful discoveries, or production reliability.

The goal remains directionally right: protect effortless deposits, let useful investigation happen privately, and require a separate reason and permission for anything that reaches the member. The next investment should connect lifecycle and authority across existing components before increasing activity.

## Reproduced failures and fixes

- A restored tenant retained database-local source event numbers. New valid wakes were rejected. Restore now resolves each watermark by preserved event identity into the destination sequence; unavailable references fail the restore.
- A paused watch could still execute the read proposed by an in-flight model call. Current watch state is now checked at work entry and tool initiation, and stopped watches cannot record observations. Already-started remote reads are not retroactively cancelled.
- An expired unpinned watch was reopened as `repair_required`. Legacy repair selection now excludes terminal watches.
- Health listing loaded observation history. CLI, HTTP, and tool list surfaces now return summaries; details retain history.
- Resolved inquiries could gain foreground eligibility after their deadline, and pending inquiries had no periodic expiry sweep. Deadline checks now reject new foreground decisions, and bounded worker maintenance quietly expires eligibility without retracting completed findings.

Additional regressions cover two-connection admission races, two wake generations in one millisecond, exact preservation of opaque cursors, and a corrupt source definition that must not starve a healthy watch. Admission rechecks run under the write lock; damaged definitions remain intact with one held repair item. Expiry scans use bounded batches and partial indexes, without parsing historical JSON.

## Verification

`npm run check`: TypeScript succeeds; 397 tests pass, zero failures or skips. Nine new tests use real SQLite. The source fixture uses a scripted provider to exercise execution boundaries, not model quality. Four source regressions and both inquiry expiry regressions were observed failing before their fixes.

No live sources were enabled, no private data was uploaded, no permissions were expanded, and no deployment was performed. No member history was deleted. Source cursors, observations, receipts, and completed inquiry findings remain preserved.

## Next acceptance gates

1. Explicitly link responsibilities and inquiries to downstream watches, work orders, and delivery proposals. Today an intervention's generic delivery lifetime is not its originating inquiry's deadline. An already-queued message must recheck that origin after a hold, retry, or restart. Joining by a shared source event is not sufficient authority.
2. Apply cumulative tenant/responsibility budgets and fair scheduling to the composed workflow, including specialist cancellation. Per-run bounds alone do not prove affordable continuous operation or noisy-neighbor isolation.
3. Implement and qualify real provider cursor/history semantics. A follow-up snapshot is not a guarantee that every transient missed event can be recovered.
4. Demonstrate one intellectual discovery and one practical, authorized outcome through the actual relationship rail, including interruption burden and recovery failures. Keep live and pilot checkboxes open until that evidence exists.
