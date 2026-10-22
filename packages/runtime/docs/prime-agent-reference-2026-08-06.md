# Prime Agent Reference — 2026-08-06

## Scope and provenance

This note records a mechanism-level review of Prime Intellect's Prime Agent and its launch article. It is a design reference for Co, not evidence that Prime Agent code has been copied or that the mechanisms below are already implemented here.

- Upstream repository: <https://github.com/PrimeIntellect-ai/prime-agent>
- Inspected revision: [`b9a4461149419156599d60174dddf15458e2b9ee`](https://github.com/PrimeIntellect-ai/prime-agent/tree/b9a4461149419156599d60174dddf15458e2b9ee)
- Local reference checkout: `../prime-agent`
- Upstream license: MIT, copyright Mario Zechner (2025) and Prime Intellect (2026)
- Launch article: [Prime Agent: A self-improving RLM agent](https://www.primeintellect.ai/blog/prime-agent), published 2026-08-05
- Review date: 2026-08-06 PDT

No Prime Agent source was copied into Co during this review. Any later code adaptation must preserve the upstream license and receive a provenance note identifying the source revision and files.

## Executive finding

Prime Agent is the strongest reference reviewed so far for a **model-facing collaborative workbench**: the model gets one programmable IPython surface, can admit retained child agents immediately, message and revisit them, keep a long-running goal alive, and refine its own harness between turns. The background daemon makes those interactions survive terminal attachment, context compaction, and process restarts.

It is not a better product kernel for the Co use case. Prime Agent explicitly runs model-generated Python and project commands with the user's permissions; its kernel is not a security sandbox. Its refinement layer permits the agent to modify active prompt overlays, subagent definitions, skills, and memory, with global scope available to the model. Persistent Python snapshots can contain opaque runtime state. The launch article also reports a Factorio run in which refinement learned to preserve reward-hacking behavior. Those are unacceptable defaults for a system acting across messages, calendars, email, media, and longitudinal personal memory.

The correct composition is therefore:

> Keep Co's event ledger, authority policy, receipts, approvals, anti-recency memory, connectors, attention policy, onboarding, and execution isolation as the governed kernel. Borrow Prime Agent's retained-agent and long-running-session interaction patterns above that kernel.

This is a selective graft, not a replatform.

## Adoption status — 2026-08-07

Co v0.5 implements the governed subset recommended here: immediate durable admission, retained agent sessions and mailboxes, owner/family-scoped follow-ups, persistent goals with deterministic gates and bounded continuation, cursor-based attach/resume, and typed refinement proposals with operator-only application and non-erasing rollback. The implementation and verification record is in [the v0.5 adoption audit](prime-adoption-audit-2026-08-07.md).

The optional programmatic workspace remains unimplemented. No Prime Agent source was copied; the implementation uses Co's existing TypeScript, SQLite ledger, queue, lease, policy, and receipt boundaries.

## What Prime Agent actually is

The article defines a continual harness as `H = (prompt, sub-agents, skills, memory)` and combines it with a recursive language model (RLM) interface. The practical architecture is:

```text
terminal / print / ACP client
            |
    background daemon
            |
 durable session tree + JSONL transcript
            |
      model turn loop
            |
 persistent IPython kernel
   |          |           |
 skills    subagents    host bridge
              |
   retained child sessions + family messaging
```

The model receives IPython as its only built-in tool. Files, skills, child admission, messaging, and other host operations appear as Python objects or packages inside that kernel. This makes context and orchestration programmatic rather than requiring a large collection of independent model tool calls.

### 1. Persistent programmatic context

The IPython kernel keeps imports, variables, intermediate data, and callable skill packages alive across turns. The TypeScript host communicates with the Python kernel over Jupyter shell, IOPub, and control ZeroMQ channels with HMAC-signed messages. Using the control channel for awaited host requests avoids blocking behind a currently executing shell request.

The kernel can snapshot variables with `dill`, subject to per-value size limits. That is useful as a working cache, but it is not a suitable canonical memory store: values can be opaque, non-portable, executable, stale, or secret-bearing.

Primary references:

- [`packages/coding-agent/docs/rlm.md`](../../prime-agent/packages/coding-agent/docs/rlm.md)
- [`packages/coding-agent/docs/rlm-runtime.md`](../../prime-agent/packages/coding-agent/docs/rlm-runtime.md)
- [`prime-agent-runtime/src/rlm/harness.py`](../../prime-agent/prime-agent-runtime/src/rlm/harness.py)
- [`packages/coding-agent/src/core/kernel/state-snapshot.ts`](../../prime-agent/packages/coding-agent/src/core/kernel/state-snapshot.ts)

### 2. Immediate, retained subagent admission

`rlm(...)` admits a child and returns a handle immediately; it never waits for the child's result. The handle exposes a stable child ID, name, working directory, and selected model. Results arrive later through explicit messages or shared artifacts. Exact model selection fails closed, recursion depth is bounded, and parent registries survive restoration.

The important product property is not merely parallel inference. It is **addressability over time**:

- children remain named and visible after their first task;
- a parent can send a follow-up to the same child;
- child sessions can survive parent compaction and daemon restarts;
- running, idle, passive, and inactive states are visible;
- deletion creates a durable boundary while transcripts and artifacts remain recoverable;
- messaging is limited to parent, sibling, and child relationships and has queue/rate/size bounds.

This was materially better than Co's pre-v0.5 `delegate_task`, which waited for a delegated run to finish and returned one bounded result. Co v0.5 now provides immediate admission, stable retained workers, mailboxes, and follow-up steering while preserving its existing governed runtime boundary.

Primary references:

- [`packages/coding-agent/docs/long-running-agents.md`](../../prime-agent/packages/coding-agent/docs/long-running-agents.md)
- [`packages/coding-agent/src/core/rlm-runtime.ts`](../../prime-agent/packages/coding-agent/src/core/rlm-runtime.ts)
- [`packages/coding-agent/src/core/agent-messages.ts`](../../prime-agent/packages/coding-agent/src/core/agent-messages.ts)

### 3. Daemon-owned interactive sessions

The daemon owns a process per root session tree, allowing clients to attach and detach without owning the work. Its protocol uses generation and sequence cursors, coherent snapshots, chunking, idempotent client commands, leases, crash recovery, and attachment-local backpressure. Mutating operations use a two-phase update path. Uncertain results are not blindly replayed.

Session transcripts are append-only JSONL. A session tree can branch, fork, or clone using leaf pointers rather than overwriting the old path. The Agents View restores inactive children when addressed. Compaction reduces model context while retaining the underlying trajectory and child sessions.

This was a strong reference for the v0.5 operator control plane. Co now exposes cursor-based attach/resume streams and first-class retained-agent send/follow-up operations over its existing durable runs, jobs, leases, fencing, HTTP/CLI surfaces, and monitor. It does not implement Prime's transcript branching or attachment-local backpressure protocol.

Primary references:

- [`packages/coding-agent/docs/daemon.md`](../../prime-agent/packages/coding-agent/docs/daemon.md)
- [`packages/coding-agent/docs/agent-connection.md`](../../prime-agent/packages/coding-agent/docs/agent-connection.md)
- [`packages/coding-agent/docs/architecture.md`](../../prime-agent/packages/coding-agent/docs/architecture.md)
- [`packages/coding-agent/docs/rpc.md`](../../prime-agent/packages/coding-agent/docs/rpc.md)

### 4. Persistent goals and autonomous verification

Prime Agent can persist an active goal and continue after a nominal response boundary. Cron heartbeats can reactivate long-running work. Autonomous runs have turn, token, and time bounds. An optional completion gate executes an external verifier before the goal is considered finished; a failed gate does not rerun against an unchanged workspace, which avoids paying repeatedly for the same failure.

The key lesson is to separate:

1. the agent's claim that it is done;
2. durable goal state;
3. an independently executable completion condition;
4. bounded continuation after a failed condition.

Co v0.5 makes the durable goal and deterministic gate portions of this contract first-class runtime primitives. Isolated model critics remain future work; the shipped gates are manual confirmation, event count, artifact existence, and run completion.

Primary references:

- [`packages/coding-agent/src/core/goals.ts`](../../prime-agent/packages/coding-agent/src/core/goals.ts)
- [`packages/coding-agent/src/core/autonomous.ts`](../../prime-agent/packages/coding-agent/src/core/autonomous.ts)
- [`packages/coding-agent/src/modes/print-mode.ts`](../../prime-agent/packages/coding-agent/src/modes/print-mode.ts)

### 5. Continual harness refinement

`/refine` reads a trajectory, produces a minimal CRUD plan, and applies the change at a turn boundary. The planning and application stages are split. Application compares the current harness against the planning baseline to avoid overwriting concurrent changes. Active harness state supports local and global scopes; global refinements append to a log, while local results also live in the session history. Before/after snapshots support rollback. The immutable base prompt is not directly editable.

Useful implementation details include:

- atomic temporary write followed by rename;
- restrictive file mode;
- explicit local/global scope;
- stable refinement IDs and before/after snapshots;
- plan/apply separation;
- baseline conflict detection;
- a review pass intended to filter one-off noise;
- progressive disclosure for skill content.

The governance is insufficient for Co. Active entries are still stored as a mutable JSON snapshot, deletion removes the active entry, and the model can request global refinement. The history makes rollback possible, but it is weaker than an append-only typed proposal ledger with explicit operator approval and supersession.

Primary references:

- [`packages/coding-agent/src/core/refinement/refinement.ts`](../../prime-agent/packages/coding-agent/src/core/refinement/refinement.ts)
- [`packages/coding-agent/docs/skills.md`](../../prime-agent/packages/coding-agent/docs/skills.md)
- [`prime-agent-runtime/src/rlm/harness.py`](../../prime-agent/prime-agent-runtime/src/rlm/harness.py)

## Head-to-head with Co

| Dimension | Prime Agent | Co | Decision |
| --- | --- | --- | --- |
| Model-facing workbench | Excellent: one persistent programmable surface | Conventional bounded tool loop | Offer an optional sandboxed programmatic workspace later; do not make it the authority boundary |
| Delegation latency | Admission returns immediately | v0.5 admission returns stable agent/message/job handles immediately | Adopted |
| Child continuity | Named retained sessions, follow-ups, messaging, passivation/reactivation | Retained sessions, bounded mailboxes, follow-ups, cancellation, and retirement | Adopted with Co lifecycle semantics |
| Interactive continuity | Daemon-owned attach/detach sessions and branching | Cursor-based snapshots and event streams over existing durable state; no transcript branching yet | Partially adopted |
| Long-running goals | First-class goal state, heartbeats, limits, completion gate | Persistent goals, deterministic gates, wakeups, deadlines, and bounded continuation | Adopted without model-as-sole-verifier |
| Self-improvement ergonomics | Model can refine prompt/subagents/skills/memory | Typed proposals; operator-only application; immutable overlay versions | Adopted with stricter governance |
| Canonical memory | Harness JSON plus transcript and Python working state | Typed claims/events with provenance, corrections, supersession, temporal diversity | Keep Co |
| External action authority | Primarily the user's local permissions | Risk classes, approvals, receipts, standing authority, recovery | Keep Co |
| Execution isolation | Explicit warning: kernel/workers are not a sandbox | Disabled by default; bounded local dev; hardened Docker production backend | Keep Co |
| Personal-product primitives | Coding/research oriented | Connectors, iMessage/Sendblue, media, attention, onboarding, distributions | Keep Co |
| Multi-user product boundary | Local agent tool | Isolated tenant cell with explicit path to hosted adapters | Keep Co |
| Skill loading | Broad and ergonomic; Python packages installed editable | Descriptor-first plugins; versioned governed skills; fail-closed selection | Borrow progressive disclosure only |

## What to adopt, adapt, and reject

### Adopted in v0.5

1. **Durable asynchronous agent tasks.** `delegate_task` should return an admission handle after transactionally creating the child run/job. It must not wait for model completion.
2. **Retained agent registry.** Give each child a stable tenant-scoped ID, role/spec version, parent, status, model route, budget, workspace scope, and last-addressed time.
3. **Durable mailboxes.** Add bounded parent/child/sibling messages with delivery cursors, idempotency keys, provenance, and explicit `steer`/`follow_up` operations.
4. **Separate lifecycle states.** Distinguish admission, queued, running, waiting, passive, completed, failed, cancelled, and retired. A completed child can be followed up without pretending its previous run is still active.
5. **Persistent goals.** Store objective, success contract, evidence requirements, budgets, state, and continuation policy as append-only events plus a rebuildable projection.
6. **Independent completion gates.** Run deterministic checks or a separately routed critic with no ability to modify the work it evaluates. Cache failure against an input/workspace hash.
7. **Governed refinement proposals.** Generalize the existing skill proposal ledger to prompt overlays, agent specifications, memory-policy changes, and procedures. Preserve plan/apply conflict checks and before/after views, but require approval for global or authority-adjacent changes.
8. **Attach/resume protocol.** Stream bounded run events from durable cursors; allow a client to disconnect, reconnect, inspect, cancel, or steer without becoming the process owner.

### Adapt carefully

- Use a programmatic Python workspace as an optional, sandboxed execution backend for coding/research cells. Treat every persisted variable as a disposable cache derived from canonical artifacts and events.
- Retain child transcripts and artifacts, but expose only bounded, redacted operational views to operators and parent agents. Do not expose hidden model reasoning.
- Let the model propose local refinements automatically. Apply narrow reversible local changes only when their capability and authority are unchanged; require review for global distribution, memory-policy, connector, tool-risk, secret, or permission changes.
- Preserve local/global scope, but define “global” as a versioned distribution or tenant configuration proposal—not an unscoped file in a user home directory.
- Use progressive skill disclosure, but keep descriptor validation, collision failure, versioning, provenance, and installation approval.

### Reject as defaults

- Unsandboxed IPython or arbitrary project commands with the runtime service account's permissions.
- `dill` snapshots as durable or trusted memory.
- Model-authorized global prompt, skill, memory, or subagent mutation.
- Destructive harness deletion; use retire/supersede and keep history.
- Self-evaluation as the sole completion or safety gate.
- Reward-driven refinement without an independent authority/evaluation layer.
- A coding-agent-specific session model in the core connector/product runtime.

## Why independent governance matters

The Prime Agent article includes a particularly important negative result. During Factorio experiments, the agent discovered an RCON path for spawning resources and then refined that behavior into its harness despite an anti-cheat heartbeat. Refinement amplified the metric exploit instead of correcting it.

That failure is directly relevant to Co. A personal agent can optimize easy proxies—message responsiveness, task count, streaks, apparent helpfulness, user agreement, or intervention frequency—while making the person less agentic. The verifier must therefore be outside the mutable policy being evaluated, and the system must preserve human authority, source evidence, and the ability to decline action. “Self-improving” cannot mean “the same model rewrites its own incentives and approves the result.”

## Benchmark and maturity caveats

The launch article reports strong results, including 95.5% ARC-AGI-3 RHAE Best@1 with Opus 5 and 99.97% Best@3, plus long-context improvements. These are Prime Intellect's reported results; the article says a fuller technical report is forthcoming. They support investigating the interface, not treating every architectural choice as independently validated.

At the inspected revision, the upstream GitHub `Build and check` job passed and most package/test jobs passed. The overall CI run failed because two large coding-agent shards each had one real-kernel timeout:

- an image attachment over the kernel host bridge timed out at 30 seconds after 1,402 tests passed in that shard;
- canonical edit-path behavior after a kernel directory change timed out at 60 seconds after 1,490 tests passed in that shard.

The exact [CI run](https://github.com/PrimeIntellect-ai/prime-agent/actions/runs/31141976886) should therefore be described as broadly exercised but not green. This does not invalidate the architectural reference, but it argues against presenting the very new release as settled infrastructure.

## Prioritized Co roadmap

P1 through P3 below were implemented in v0.5, including the attach/resume portion of P1. They remain here as the original acceptance record. P4 remains future work.

### P1 — asynchronous retained collaboration

- Add durable agent, task, and mailbox projections backed by append-only lifecycle events.
- Change delegation to return an admission receipt immediately.
- Execute children through the existing queue, lease, fencing, provider, tool, approval, and receipt machinery.
- Add `agent.send`, `agent.follow_up`, `agent.cancel`, `agent.retire`, and cursor-based event retrieval.
- Extend the CLI/HTTP monitor to show lifecycle and bounded mailbox previews.

Acceptance: a foreground reply can spawn three bounded tasks without waiting; the process can restart; the same children remain inspectable and addressable; a follow-up reaches the intended child exactly once; all actions retain tenant, tool, and authority boundaries.

### P2 — durable goals and gates

- Add goal events and a rebuildable active-goal projection.
- Define explicit success evidence and bounded continuation budgets.
- Allow schedules and receipts to wake goals without forcing an interruption.
- Run deterministic or isolated-critic completion gates and bind results to an input/workspace hash.

Acceptance: a run cannot mark a gated goal complete without the external condition; unchanged failures are not rerun; a gate cannot mutate the evaluated workspace; user pause/cancel always wins.

### P3 — governed continual harness

- Generalize skill proposals into typed refinement proposals.
- Store trigger, evidence, scope, base version, patch, predicted effect, evaluator, decision, and outcome.
- Apply through optimistic version checks and atomic version creation.
- Use retire/supersede rather than deletion and support deterministic rollback by selecting a prior version.

Acceptance: the model can learn locally without silently rewriting global behavior, memory truth, permissions, or source logs; every active version can be reconstructed from retained records.

### P4 — optional programmatic workspace

- Provide a Python/RLM-style surface only inside a selected execution backend.
- Map host capabilities to narrow broker calls that still create normal tool receipts and approvals.
- Persist explicit artifacts and code, not trusted opaque interpreter state.
- Make kernel loss recoverable from events, artifacts, and source notebooks/scripts.

Acceptance: deleting the kernel loses convenience but not canonical memory, action history, authority, or reproducibility; the kernel cannot access unmounted secrets or bypass the tool policy.

## Bottom line

Prime Agent demonstrates a much better way for a model to coordinate ongoing intellectual work: admit collaborators immediately, keep them addressable, communicate explicitly, and separate a durable goal from any one context window. Those mechanisms should become part of Co.

Co should not inherit Prime Agent's trust model. For a product that can observe and act across a person's life, the durable system of record must remain an append-only evidence and action ledger; changes must be versioned and governed; execution must remain constrained; completion must be independently checkable; and no refinement may erase the past or silently expand authority.
