# Shared execution responsibility and conservative evidence — 2026-09-05

## What changed

An operator can explicitly create a bounded execution responsibility and attach it to a work order. The responsibility records its tenant, initiating event, owner session, objective, deadline, cumulative token allowance, model-call allowance, and tool-call allowance. It is an execution envelope, not another inferred personal goal, and it grants no tool, source, or messaging permission.

Work orders, their runs, retained specialists, and subsequent specialist turns inherit the same immutable binding. A sibling cannot send work to an unbound agent to escape that envelope. Retried work-order admission cannot add, remove, or replace its original responsibility. Agent monitoring exposes the responsibility ID; the responsibility detail exposes bindings and aggregate usage.

Every provider call inside a bound run crosses the same wrapper, including any in-run secondary model calls. Before calling the provider, a SQLite transaction reserves a conservative input-byte allowance plus framing and maximum output tokens, and consumes one model-call slot. Concurrent workers see the reservation immediately. Valid measured usage replaces the reservation once; a failed or abandoned call retains its reservation. There is no timeout refund. Reported usage beyond the reserved envelope blocks further work. These are token estimates and counts, not vendor invoices or a guaranteed billing cap against a misreporting provider.

Tool initiation consumes a shared tool-call slot and rechecks lifecycle within the existing receipt-initiation transaction. Tool-call counts do not estimate external tool charges. Cancellation stops new model/tool initiation across bound descendants and discards an in-flight model answer after recording its measured usage. Already-started remote effects cannot be recalled. Already-completed findings and parent runs are not rewritten. Expired queued work terminates without creating an orphaned run.

Schema 57 adds responsibilities, immutable execution bindings, and an indexed reservation ledger. Export/restore carries these records and charges. Malformed stored accounting is rejected, not interpreted as zero usage.

## Operator API

Use the existing authenticated daemon API. These endpoints do not activate any source or delivery rail:

- `POST /v1/responsibilities`: supply `sourceEventId`, `ownerSessionId`, `objective`, `deadlineAt`, `idempotencyKey`, `tokenLimit`, `modelCallLimit`, and `toolCallLimit`. All bounds are explicit; the source and session must already belong to the daemon's tenant.
- `POST /v1/work-orders`: include the returned `responsibilityId` alongside the existing work-order contract and allowed tools.
- `GET /v1/responsibilities/:id`: inspect ownership, limits, status, bindings, and charged usage.
- `POST /v1/responsibilities/:id/actions` with `{"action":"cancel"}`: stop future bound execution without deleting history.

Use a configured server token, as required for production. This is an operator surface; conversational responsibility admission and a polished CLI creation flow remain unfinished. Ordinary deposits do not create envelopes, and existing unbound work is not silently reclassified.

## The evidence-default audit

The reported fail-open default was present in builtin registration and also in runtime/store receipt settlement. Missing evaluators now give only request-level evidence. An evaluator omitting its scope cannot gain outcome-level evidence. New receipts start request-scoped; legacy receipts missing a scope migrate conservatively without discarding their original output. Explicit historical classifications are not bulk rewritten by this change.

Seven synchronous operations received explicit narrow evaluators: artifact persistence, memory-record persistence, research-source persistence, research-finding persistence, full file reads, durable file writes, and prepared arithmetic reality checks. Persistence proves that a local record exists, not that its interpretation is true or that it was delivered. A truncated file read remains request-scoped. Other unclassified builtins retain the conservative fallback. Existing explicit consequential-tool evaluators remain intact.

The low-level outcome fixtures in the lease and research tests now explicitly declare the outcome they simulate instead of relying on an optimistic settlement default.

## Verification

`npm run check`: TypeScript and 422 tests pass, no failures or skips. Fifteen new tests cover conservative evidence defaults, exact completion requirements, shared specialist allowances, two-connection admission, failure/reopen, cancellation during inference, queued-child cancellation, deadline expiry, immutable retry ownership, tenant isolation, export/restore, malformed accounting, and authenticated operator HTTP controls. Tests use real SQLite with simulated model/connector behavior.

No deployment, live-source activation, permission grant, private upload, commit, or push was performed. No member history was deleted.

## What this does not claim

- This is an explicitly attached per-responsibility envelope, not a tenant-wide daily spend limit. Unbound work is unchanged.
- Detached scheduling, scouts, research commissioning, consequence promotion, media ingestion, promises, and goal-continuation admission are not yet fully linked. Known builtin admissions into those paths are refused from a bound run. Automatic detached URL/media and memory/perception enrichment is not launched from bound runs. Independent ordinary deposits retain their existing behavior.
- External tool/subprocess charges and provider-internal retries are not individually metered. The tool count bounds runtime initiations only.
- There is no fair multi-tenant scheduler, parked/resumable responsibility state, semantic completion controller, or automatic budget replenishment in this slice. The parent admitting a specialist does not establish that the broader objective is complete.
- The always-on iMessage product still needs live qualification and a useful multi-day loop that carries responsibility through event wakeups, specialists, independent completion evidence, and tactful delivery.

The Phase 2 checkboxes remain open for these reasons. The next implementation should extend this same envelope through existing durable job paths, rather than add a competing controller or more periodic notifications.
