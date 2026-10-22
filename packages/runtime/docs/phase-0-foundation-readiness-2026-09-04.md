# Phase 0 foundation and readiness record — 2026-09-04

This is an evidence record for the focused deposit-agent goal. It declares what the current cell supports and where ownership sits; it is not a production certification.

## Preserved baseline

- Baseline commit: `b8ef2671c0914cf5e3db56930f83e7fc65265573` (`feat: establish Co v0.10 agent foundation`), committed 2026-09-04 21:38:34 PDT.
- Verification command before capture: `npm run check`.
- Result: TypeScript passed; 331 tests passed with zero failures, cancellations, skips, or todos against real SQLite fixtures.
- Environment observed in this follow-up: Node `v26.7.0`, npm `11.19.0`. The package contract remains Node `>=22.19.0`; this run does not prove every supported Node version.
- Preservation: the prior goal is byte-preserved at `docs/goal-pre-deposit-agent-2026-09-04.md`; the earlier roadmap remains at `docs/goal-v0.10-runtime-roadmap-2026-09-03.md`. The baseline commit contains the previously uncommitted v0.10 tree rather than discarding or rewriting it.
- Limits: no private founder corpus was uploaded; no real non-founder product trial ran; no live signed iMessage round trip, live email send, browser login, sensor, or hostile multi-host exercise ran. The baseline proves a local implementation state, not deployed reliability or product value.

Changes after that commit must cite a later commit and fresh verification. A clean baseline result cannot be inherited by a dirty working tree.

## Authoritative path and ownership

```text
authenticated transport / CLI / HTTP / schedule / consented sensor
  -> connector or source adapter (normalize only)
  -> append-only event ledger + transactional job admission
  -> RuntimeWorker (recovery, due materialization, fair job claim)
  -> CoRuntime (release-pinned context, model turn, policy)
  -> tool/effect boundary (approval or mandate, lease, semantic receipt)
  -> RuntimeWorker relationship admission (class, authority, canonical route, lease)
  -> RuntimeWorker transport boundary (exact intent, idempotency, reconciliation)
  -> connector adapter
```

The ledger and SQLite projections are authoritative for this topology. Personal-model, perception, research, consequence, full-text, and attention records are derived or lifecycle projections; none may replace original events. `CoRuntime` owns the reasoning turn and tool policy. `RuntimeWorker` is the sole product delivery caller and the sole due-work composition loop. `Scheduler`, goal deadlines, and persistent scouts materialize jobs only when invoked by that worker; they are not independent daemons.

Connector adapters authenticate/translate and return provider receipts. They do not own identity, memory, scheduling, or permission. Ordinary and optional replies, approvals, repairs, scheduled results, proactive interventions, native reactions, recovered results, and operator smoke first converge on the durable relationship arbiter, then its private transport executor. The latter owns the exact outbound claim and reconciliation state. Verified email remains a separate explicit tool effect, but it crosses the same run policy and semantic tool-receipt boundary.

The model/provider registry owns bounded invocation, not canonical state or authority. Distributions are versioned behavior data. `co` is the default; the legacy `donna` distribution remains opt-in compatibility data and is not a founder fallback. A selected production profile binds tenant, member identities, timezone, workspaces, plugins, models, and execution policy without inheriting another profile's environment scope.

## Cross-layer findings

1. The modular-monolith boundary is coherent enough to extend: one ledger, one job queue, one worker composition path, one effect policy, and one relationship delivery function.
2. The runtime is a tenant-scoped cell, not a shared multi-tenant control plane. Tables and APIs are tenant-keyed and have isolation tests, but each running `CoRuntime` and worker is configured for one tenant.
3. SQLite transaction and fencing semantics are part of correctness. Replacing storage with generic CRUD or mounting one database across independent hosts would invalidate those guarantees.
4. Development mode intentionally permits `default`, current-directory workspaces, and environment configuration. Production validation requires an explicit profile, bounded roots, API-backed providers, strong distinct secrets, safe execution, and canonical member phone principals.
5. Operator-installed plugins are trusted code/configuration. Their returned content is untrusted evidence, but this is not a hostile-plugin sandbox.
6. Source polling, provider delivery, and remote effects are distinct failure boundaries. Current outbound iMessage state has an outbox-like claim/reconciliation projection; not every internal state transition has yet been converted to a general transactional outbox contract.
7. Delayed jobs pin a behavior release, but payload/schema compatibility across rolling binary versions remains a release gate. There is no supported zero-downtime mixed-version cluster.
8. Final composition and delivery use bounded current relationship state. One durable admission arbiter now owns every current relationship-send callsite, re-resolves the canonical rail, preserves explicit class/authority/content binding, and settles only from the exact transport outcome. Exhausted pre-transport wakeups become one owned repair item instead of stranded work.

No direct relationship-send bypass was found outside `RuntimeWorker` in the reviewed source. The explicit email provider calls are tool effects rather than relationship delivery. This is a source audit finding, not proof against future dynamic plugin behavior.

## Small supported deployment envelope

The currently supportable pilot topology is deliberately narrow:

| Dimension | Declared envelope |
|---|---|
| Tenant topology | One explicitly profiled tenant per runtime cell. Multiple isolated cells may use separate local databases and credentials. |
| Host/storage | One host and one local writable SQLite database per cell. Online backup/restore exists; no shared-filesystem or multi-writer deployment is supported. |
| Worker | One active worker loop per cell for the pilot. Lease fencing is tested, but multi-worker throughput and fairness are not qualified. |
| HTTP | One authenticated daemon; request body defaults to 2 MB and configured connection ceiling defaults to 1,000. These are configuration caps, not measured throughput claims. |
| Media | A fetched resource is capped at 15 MB by default; large enrichment is background work. Provider-specific upload and source limits still apply. |
| Agent fan-out | Defaults: depth 2, 3 concurrent children, 12 children per run, 24 queued children. Cumulative tenant cost/fairness under load is not yet qualified. |
| Attention | Default maximum 3 proactive interventions per rolling 24 hours, 180-minute topic cooldown, and 22:00–08:00 profile-time quiet hours. Requested, optional, accepted-burden, operator, and safety traffic are explicitly classed in relationship admission and representative review; only proactive intervention reservations currently consume this configured cap. |
| Availability | Single-cell availability only. No HA, measured RPO/RTO, SLO, autoscaling, or rolling mixed-version promise. |
| Integrations | Deterministic adapters and selected synthetic authenticated-session runs are evidence. Each live connector/provider/source needs its own retained smoke/qualification artifact. |

This envelope is suitable for local development and a carefully operated one-person pilot after its live integration gates pass. It is not yet suitable for a five-person unattended pilot, a hosted production claim, or arbitrary business operation.

## Readiness decision

The foundation should be strengthened in place, not rewritten and not split into services. Phase 0's deterministic honesty gates are now implemented. Promotion remains blocked on actual independently reviewed live quality, live integration evidence, and the later phase exits—not on missing relationship-arbitration or measurement machinery. Fresh counterevidence retrieval and consequence-to-work-order bridging have deterministic regression evidence, but not live qualification.

## Shared relationship admission and independent quality

Commit `422d1dc97361c68b55e583bb3b1b8095101b0650` routes every current relationship send through one durable admission owner before the exact transport claim. Admission binds tenant, canonical session and current rail, source, run, delivery class, content digest, authority reference, and transport intent. Competing messages serialize by explicit precedence; delayed dispatch revalidates route and authority; stale owners are fenced; transport acceptance, failure, and uncertainty settle from exact receipts. A release-pinned wakeup survives process loss, and terminal pre-transport exhaustion creates one idempotent office repair item.

The same commit adds schema v52's tenant-scoped independent-quality lifecycle: future-only preregistration, commit/reveal deterministic stratified sampling, a frozen all-decision population including legitimate silence, blind packet export, append-only declared external-human reviews and corrections, disagreement adjudication, and one-sided Wilson bounds. Optional deposit replies are distinct from requested replies, and population time is terminal decision time. Synthetic plans exercise statistics but cannot qualify live product quality. `MemberProductQualifier` version 2 makes conversational praise/complaint, first-wow, context-advantage, and tenure signals diagnostic only; passing requires a qualified same-tenant live review plan plus operational promise, action, evidence, and interruption stages.

Frozen review evidence is part of verified tenant export/restore. Ordinary SQL deletion remains blocked, while the exact export-confirmed tenant deletion path uses a transaction-scoped permit so the member's deletion right is not defeated by evaluation immutability.

Final verification command: `npm run check`.

Final Phase 0 result on 2026-09-04: TypeScript passed; 372 tests passed with zero failures, cancellations, skips, or todos. Targeted coverage includes all transport crash points, competing relationship admission, route changes, retry exhaustion ownership, optional/requested/scheduled classification, additive v51-to-v52 migration, quality population timing, complete-live and synthetic-live separation, and review-state export/restore/deletion.

Limitations: the runtime cannot prove that a declared reviewer is a human independent of the team. Reviewer recruitment, identity controls, calibration, real participant traffic, and demonstrated benefit remain live external gates. The full suite is deterministic local evidence, not deployment certification.

## Selective semantic knownness

Commit `54b5ee9` extracts one citation-bound semantic verifier and applies it after the cheap local gate to otherwise-eligible optional foreground observations, mature perceptions, operational media/ambient candidates, and reactivated holds. Restatements and contradictions require an exact allowed evidence event; malformed output, forbidden tool calls, invalid citations, and provider failure remain uncertain and fail closed at optional delivery surfaces. Explicit requests, tool-bearing runs, silence, tapbacks, local-known candidates, and weak operational candidates avoid the extra call.

The full verification run after integration passed TypeScript and 358 tests with zero failures, cancellations, skips, or todos. Two initially failing integration tests exposed overbroad verification of short acknowledgments and tool-bearing runs; the committed boundary excludes both rather than weakening their existing behavior.

Limitation: recall is tenant- and checkpoint-scoped but still bounded to exact source records, current relationship context, recent evidence, full-text retrieval, and delivered interventions. This is enough to close current delivery-surface paraphrase behavior, not to guarantee arbitrary semantic recall across an entire long history. A rebuildable semantic retrieval projection remains Phase 2 work.

## Focused-pilot synthetic fixtures

The shared fixture at `test/fixtures/focused-pilot-synthetic.jsonl` contains two multi-event scenarios rather than isolated prompt examples:

1. An intellectual path joins three dated thoughts, asks for the underlying project, and requires a relevant outside framework plus a falsifiable design question.
2. A practical path combines a stated email return deadline and drop-off, an explicit private-preparation authority boundary, and permitted calendar/location context. Passing requires a usable private artifact and a confirmed semantic outcome receipt from `artifact.prepare`; advice or completion prose alone fails.

`test/replay-evals.test.ts` executes the full-context and history-ablation candidates through the same `CoRuntime`, release, provider, tool registry, and receipt path. The test also preserves the ablation's ability to execute `artifact.prepare`, so a quality difference cannot be attributed merely to tool availability. A pinned external response without a bound confirmed receipt cannot pass the action case.

Verification command: `node --test test/replay-evals.test.ts`.

Focused replay result on 2026-09-04: 8 tests passed with zero failures, cancellations, skips, or todos.

Full verification command: `npm run check`.

Full result on 2026-09-04: TypeScript passed; 343 tests passed with zero failures, cancellations, skips, or todos.

Limitations: the content and providers are deterministic synthetic fixtures. They establish evaluation plumbing and regression contracts, not the Phase 3 claims of actual source inspection, live connector access, calibrated model judgment, external-harness superiority, or member value.
