# Prime Agent Adoption Audit — 2026-08-07

## Verdict

Co v0.5 selectively adopts Prime Agent's strongest continuity mechanisms without adopting its trust model. Retained collaboration, persistent goals, cursor-based reattachment, and governed harness refinement are implemented on Co's existing SQLite ledger, durable queue, leases, provider adapters, action policy, approvals, receipts, tenant scope, and execution isolation.

This is a mechanism-level implementation. No Prime Agent source was copied. The reference revision and upstream license are recorded in [the source review](prime-agent-reference-2026-08-06.md).

## What shipped

| Mechanism | Co implementation | Verified behavior |
| --- | --- | --- |
| Immediate durable admission | `RetainedAgentManager.admit`, `delegate_task`, and `agent.turn` jobs | A delegation batch is admitted transactionally and returns stable agent/message/job handles without waiting for inference. Child concurrency limits running jobs rather than truncating the batch. |
| Retained agents and mailboxes | `retained_agents`, `agent_messages`, `RetainedAgentManager` | Stable sessions survive runtime restart. Objective, message, follow-up, result, and system records remain cursor-addressable. Owner/family boundaries and idempotency-key reuse are enforced. |
| Lifecycle and steering | Agent CLI, HTTP actions, model tools, and monitor projections | Queued, running, waiting-approval, idle, failed, cancelled, and retired states are inspectable. Follow-ups reuse the same session. Cancellation and retirement retain history. |
| Persistent goals | `goals`, `goal_gate_results`, `GoalManager`, and `goal.check` jobs | Goals retain an objective, success contract, assigned agent, deadline, token budget, and bounded continuation count outside any single model turn. |
| Independent deterministic gates | Manual, event, artifact, and run gates | Completion is decided from durable evidence rather than the assigned agent's claim. Failed checks are cached by evidence hash, and matching events can enqueue a new check. |
| Attach/resume | CLI `attach`, HTTP `/v1/attach`, filtered event queries, and SSE cursors | Runtime, retained-agent, run, and goal views return a bounded snapshot plus events after a sequence cursor. SSE accepts `Last-Event-ID`. Client disconnect does not own or cancel work. |
| Governed refinement | `RefinementManager`, `refinement_proposals`, and `harness_overlays` | The model can propose typed changes but cannot approve or apply them. Application checks the planning baseline, creates a version, and retains superseded or retired history. Rollback creates another version. |
| Reviewed prompt overlays | Runtime prompt assembly | Only approved and applied prompt overlays affect model prompts. Distribution, tenant, and retained-agent-local scopes are explicit. Overlay text is marked as behavior guidance that cannot expand authority. |
| Operator surfaces | CLI and authenticated HTTP endpoints | Agents, goals, refinements, overlays, and attach views are inspectable and controllable without exposing hidden model reasoning or unbounded tool payloads. |

Primary implementation files are [`src/agents.ts`](../src/agents.ts), [`src/goals.ts`](../src/goals.ts), [`src/refinements.ts`](../src/refinements.ts), [`src/runtime.ts`](../src/runtime.ts), [`src/worker.ts`](../src/worker.ts), [`src/server.ts`](../src/server.ts), and [`src/store.ts`](../src/store.ts).

## Governance and non-erasure

- Agent cancellation or retirement stops queued/future turns while retaining the agent row, mailbox, runs, events, results, and artifacts.
- Goal transitions and every unique gate result remain in durable state. Completion, pause, failure, or cancellation does not remove supporting evidence.
- Refinement proposals retain source and evidence event IDs, the planning baseline, decision metadata, and lifecycle timestamps.
- Applying a replacement marks the prior overlay superseded. Retirement marks it retired. Rollback copies previously reviewed content into a newly proposed, approved, and applied version; it never rewrites the old version.
- Refinement patch validation rejects authority, tool-policy, approval, secret, credential, connector-permission, and workspace-scope fields.
- Existing messages, runs, events, memories, imports, learned skills, and local source logs are unchanged. Schema migration is additive.

## Deliberately not adopted

- Unsandboxed IPython or arbitrary project commands running with the service account's permissions.
- `dill` or another opaque interpreter snapshot as canonical memory.
- Model-authorized application of local, tenant, distribution, global, or authority-adjacent refinements.
- Destructive deletion of agents, goals, messages, proposals, or overlay history.
- Self-evaluation as the sole completion or safety gate.
- A model-editable reward or authority policy.
- Prime Agent's code-specific transcript branching model in the connector/product kernel.

## Verification

The following checks completed on 2026-08-07:

```text
npm run check
  TypeScript: pass
  Tests: 66 passed, 0 failed

npx --yes node@22.19.0 --test test/*.test.ts
  Tests: 66 passed, 0 failed

npm audit --omit=dev --audit-level=high
  Production vulnerabilities: 0
```

New coverage includes restart persistence, same-session follow-ups, mailbox non-erasure, delegation batches larger than the execution-concurrency limit, transactional job admission limits, goal failure caching, bounded continuation, automatic event wakeups, stale refinement conflicts, forbidden authority fields, non-erasing rollback, authenticated HTTP control surfaces, attach/resume cursors, monitoring, metrics, and schema migration.

The Docker invocation and containment contract remains integration-tested with a fake daemon client. A fresh v0.5 image build could not be completed locally because the Docker daemon did not return a response. That is an environment-blocked acceptance item, not a passing result.

## Known limits

- This remains an isolated single-tenant cell, not a shared hostile-multi-tenant control plane.
- Cancellation cannot terminate an already in-flight provider or tool transport. It does fence the durable run before a late model result can become output or authorize another tool call; an external effect already in flight remains represented by its receipt.
- Gates are deterministic store-backed checks. An isolated critic and arbitrary command/workspace verifier are not implemented.
- `agent_spec`, `procedure`, and `memory_policy` refinements can be proposed and governed but remain inert until a separately governed consumer is added. Only `prompt_overlay` affects runtime behavior today.
- Attach/resume provides coherent bounded snapshots and durable cursor replay; it does not implement Prime Agent's transcript branching, kernel attachment, or attachment-local backpressure protocol.
- The optional sandboxed programmatic workspace described in the source review remains future work.

## Product conclusion

The adoption makes Co better at ongoing work without turning it into an ungoverned self-modifying coding agent. Work can continue beyond a reply boundary, collaborators remain addressable, completion is represented separately from confidence, clients can reconnect without owning execution, and useful behavioral refinements can accumulate without erasing the past or silently expanding authority.
