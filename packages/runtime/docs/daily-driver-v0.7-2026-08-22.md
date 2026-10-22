# Co v0.7 daily-driver implementation

## Outcome

Co now has one durable daily-driver path rather than a chat process beside an unrelated worker. A persistent daemon owns model/tool execution and background jobs; the CLI discovers it, submits an idempotent external turn ID, follows the durable run through the HTTP control plane, and renders honest progress. If no daemon is available, local chat remains a compatible fallback.

The same event store now supports an institutional service layer:

- A **mandate** is a proposed or operator-approved standing service contract. A model may propose one but cannot activate it.
- A **matter** is an evolving situation with status, priority, a possible mandate, and linked source-event evidence.
- A **prepared artifact** is a local brief, draft, research note, plan, or other work product. Preparing it never sends or publishes it.
- An **attention item** is useful work or context held for review with a delivery mode and reason.

These are service records, not compulsory goals. Ordinary reflection does not need a matter, and a matter does not impose a completion loop.

## Runtime and control plane

- `co chat` probes the loopback daemon, uses it when ready, and otherwise runs locally. `--daemon-url`, `CO_DAEMON_URL`, and `--local` are explicit controls.
- Every daemon CLI turn has an external ID. `/v1/chat/status` resolves that ID to its ingress receipt, run, cursor, and new events.
- `POST /v1/runs/:id/actions` supports exact cancellation and recovery.
- Cancellation is transactional: pending approval is denied, the run becomes cancelled, its lease is released, and a `run.cancelled` event is appended. Durable state is retained for inspection. Existing model/tool lease fencing prevents a late result from becoming output.
- `co runs --stale`, `co run show`, `co run cancel`, and `co run recover` expose reconciliation without database surgery.

The pre-v0.7 abandoned CLI run from August 13 was reconciled through this path and its nine-day process was terminated. Its input, session, messages, state, and event history remain in the database.

## Attention without notification pressure

The existing attention score still determines whether a signal earns an interruption. v0.7 adds two non-notification outcomes:

- A useful signal that clears an evidence/confidence/usefulness floor but not the interruption threshold is held in the office inbox.
- A signal that earned delivery but has no authorized/configured delivery adapter is held rather than lost.

Very weak signals remain silent. Quiet-hours, budget, and cooldown suppression can become digest items instead of delayed surprise notifications. This makes proactivity accumulative without making the user service an endless inbox.

## Terminal surface

Normal chat remains scrollable. The renderer has no React or full-screen TUI dependency and works on the supported Node 22 runtime. It provides:

- elapsed spinner state on TTYs and stable log lines on pipes;
- run/tool/approval/recovery status derived from durable events;
- lightweight answer formatting;
- `NO_COLOR`, `--plain`, and `--json` behavior;
- immediate size acknowledgement for multiline and large document input;
- Ctrl-C cancellation of the exact attached daemon run.

Product views are `co today`, `co inbox`, `co matters`, `co mandates`, `co artifacts`, and `co why ID`. Raw administrative state remains available through runs, jobs, events, approvals, and attach.

## Storage and non-erasure

Schema version 8 adds `mandates`, `matters`, `matter_evidence`, `prepared_artifacts`, and `attention_items`. The migration only creates tables and indexes; it does not rename, rewrite, or delete prior events, messages, runs, imports, memories, artifacts, or source logs.

Lifecycle transitions append events. Matter evidence points to immutable event IDs. Prepared artifacts retain their source-event ID list. Attention resolution and mandate retirement update lifecycle projections but retain their rows and event history.

## Verification

The v0.7 suite covers:

- end-to-end office provenance and lifecycle state;
- cancellation with pending approval and retained state;
- HTTP daemon attachment and office endpoints;
- useful intervention holding when delivery is unavailable;
- in-flight HTTP cancellation and late-provider fencing;
- deterministic distribution-order tool selection with relevance promotion for office capabilities;
- prior multiline input, lease, recovery, authority, memory, connectors, media, collaboration, and migration behavior.

A clean mock-provider smoke ran one daemon, attached a separate CLI chat to it, received the answer, rendered `today`, and reported no stale runs. The full 89-test/typecheck release check passed, including an end-to-end office CLI lifecycle. The production dependency audit found zero vulnerabilities, the dry-run package contained the intended runtime surface, and credential/personal-path scans were clean. The Docker build could not reach this machine's OrbStack socket and produced no build output; after a bounded wait it was interrupted, so a responsive local daemon or GitHub CI must still verify the v0.7 image.

## Honest remaining boundary

This is a coherent single-host, single-tenant runtime cell, not yet a hosted multi-tenant product. Calendar/email/call breadth still depends on configured connectors or MCP servers. Models can prepare and organize office work, but autonomous service quality still needs live-provider behavior evals and real connector dogfooding. Streaming is event-level progress; provider token streams are not yet normalized across adapters. A full-screen office TUI is intentionally deferred until the scrollable CLI proves what information deserves permanent screen space.
