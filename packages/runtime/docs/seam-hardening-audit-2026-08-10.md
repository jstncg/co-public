# Runtime seam-hardening audit — 2026-08-10

## Outcome

Co's core is a coherent durable runtime rather than a set of adapters sharing a prompt. This pass converted that claim into adversarial tests at the boundaries where authority or state crosses between models, tools, retained agents, SQLite, workers, connectors, and restarts.

The pass found and fixed five concrete faults:

1. Cancelling a retained agent did not deny its pending approvals, so a later approval response could move the cancelled run back to `running`.
2. Model messages and completion events could be written before a stolen run lease was detected.
3. An approval was located by run and call ID but was not re-bound to the exact tool name, arguments, and current risk at execution time.
4. Repeated recovery of an ambiguous connector send could append duplicate uncertainty events.
5. A model's tool-call message could be committed just before its resumable pending-call queue, leaving a crash gap that could ask the model to issue the call again.

No source event, message history, memory, receipt, run, imported log, or prior migration was deleted or rewritten by these changes.

## Proven seam contracts

| Seam | Enforced contract | Adversarial evidence |
| --- | --- | --- |
| Parent → child | A child can narrow but never widen the parent's tool authority. Unavailable explicit tools fail instead of disappearing silently. | A child requesting a registered but parent-forbidden memory tool is not admitted. |
| Model → tool | A model call is validated against the run's complete persisted authority, not only the schemas currently shown to the model. | A provider invoking a hidden registered tool fails before a receipt or effect exists. |
| Model → durable queue | A response and its complete pending-call queue commit together; a final response and run completion also commit together. | Approval-pause state contains the exact issued call, while lease theft leaves neither model nor completion artifacts. |
| Approval → action | Approval is transactionally bound to a waiting run and to the exact call ID, tool name, canonical arguments, and risk. | Cancelling or replacing a tool implementation cannot reuse an old approval. |
| Config → recovery | An admitted run retains its resolved provider/model route through pause, configuration edits, and resume. | Both sides of an approval pause use the original route after the configured default changes. |
| Lease owner → ledger | Model messages, run state, completion events, evidence, and follow-up jobs commit in the same transaction after the run-lease compare-and-set. | A stolen lease rolls back the late model result and leaves no assistant message or completion event. |
| Cancellation → running model | A cancelled retained-agent run discards a late provider result. | Mid-provider cancellation records cancellation without `run.completed`. |
| Cancellation → running tool | A tool effect that already finished retains its receipt, but cancellation fences its tool-result message and all subsequent model work. | Mid-tool cancellation records the external outcome once and makes no second provider call. |
| Receipt → restart | Completed idempotent work is reused; interrupted non-idempotent work is never repeated automatically. | Recovery reuses completed output and returns an explicit uncertain outcome for a running non-idempotent receipt. |
| Durable bytes → runtime | Invalid run-state JSON or missing structural fields fail before provider or tool execution. | Corrupted `state_json` raises a run-specific diagnostic with zero provider calls. |
| Ingress → run | External message identity maps to one run; reused identity with changed content is rejected; concurrent retries serialize per session. | Existing runtime tests cover exact retry identity, content conflict, and concurrent retry convergence. |
| Run → connector | A completed send is deduplicated. A crash after send-start but before confirmation is marked uncertain and is not automatically repeated. | Repeated success sends once; repeated ambiguous recovery sends zero times and records one uncertainty event. |

## Semantics that are deliberate

- Non-idempotent actions and connector delivery are not advertised as magically exactly-once. When the external outcome cannot be proven, Co fails closed and exposes uncertainty for reconciliation.
- A cancelled in-flight tool may still finish in the external system. Its durable receipt is retained because erasing that outcome would be less safe than pretending cancellation reversed it.
- Durable run state is validated, not silently replaced with an empty object. Recovery therefore stops visibly instead of improvising from incomplete authority or history.
- Model defaults may change for new work, but a previously admitted run does not silently switch models halfway through execution.

## What this does not prove

- No live OpenAI, Anthropic, Sendblue, MCP, calendar, email, or call-provider contract test was run in this seam pass.
- SQLite leases coordinate processes sharing one database volume; they are not a distributed multi-host consensus mechanism.
- Corrupt runs fail closed but do not yet have an operator quarantine/repair command.
- The tests inject boundary faults deterministically. A future release gate should also kill worker processes at randomized persistence points and replay against real connector sandboxes.
- This remains a single-tenant runtime cell, not a hostile multi-tenant SaaS control plane.

## Verification

The latest `npm run check` passes TypeScript validation and all 82 tests, including the nine adversarial cases in `test/seams.test.ts` and the later CLI-ingress regressions. The production dependency audit reports zero vulnerabilities; the dry-run package contains only intended runtime, distribution, skill, deployment, and documentation assets; credential-pattern and personal-path scans are clean.

An image build and unprivileged-user CLI smoke passed before the final model-response atomicity edit. The attempted final rebuild stalled when the local OrbStack daemon stopped returning server state, so the current working tree's image is not recorded as passed. Live-provider and live-connector tests were not attempted.
