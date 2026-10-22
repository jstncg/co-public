# Co v0.8 action-proof implementation

## Outcome

v0.8 adds a product-level work order above the existing model-run/tool loop. This is the first path whose default success condition is verified action evidence rather than a completed text response.

```text
CLI / API / foreground chat
          |
 durable work-order admission
          |
 job lease -> model run -> policy -> approval -> tool receipt
          |
 independent evidence gate
          |
 complete | needs_input | failed | cancelled
```

## Operator surface

```bash
co do "prepare the release brief" --success "a local source-backed brief exists"
co do "read the sources and prepare a brief" --min-receipts 2 \
  --require-tool file.read --require-tool artifact.prepare
co do "send the approved note" --evidence external-write
co do "inspect this bounded question" --evidence run --detach
co work-orders
co work-order show work_...
co work-order cancel work_...
co attach work-order work_...
```

The CLI verifies daemon tenant identity before remote admission, waits by default, tolerates bounded transient status-read failures, supports explicit local or detached operation, and cancels the durable work order on Ctrl-C. The HTTP equivalents are `POST /v1/work-orders`, `GET /v1/work-orders`, `GET /v1/work-orders/:id`, and `POST /v1/work-orders/:id/actions`.

Foreground conversations can call `work.submit`. The returned handle is immediate; execution remains off the reply path. Its authority is a subset of the submitting run and excludes recursive `work.submit`. A connector-originated order stores the exact source channel and peer, returns approval requests there, accepts an approval only from that linked conversation, and delivers the final result through the existing idempotent delivery boundary.

## Completion policies

- `run` accepts a completed run when analysis itself is the deliverable.
- `tool` requires a configurable minimum number of successful tool receipts and is the default.
- `external-write` requires a successful external-write receipt.

An order can require up to 12 exact tool names. Those tools must be inside its authority snapshot, are forced into the bounded model tool set, and must each leave a successful receipt; an unrelated successful tool cannot satisfy the contract. If the model stops after advice, a plan, an unsupported success claim, or a request for missing information without producing the required receipt, the work order becomes `needs_input`. Its full result, run, messages, events, and evidence remain available. The default 60,000 cumulative-token ceiling accommodates multi-pass CLI providers and remains explicitly adjustable.

## Durability and non-erasure

Schema v9 adds only the `work_orders` table and indexes. Orders point to existing runs and approvals; receipts remain in the existing receipt ledger. Idempotent admission is transactionally race-safe. A run is bound to its order before provider execution begins, so cancellation can fence an in-flight result. Worker retries reuse the same ingress/run identity, and retry exhaustion records a failed order. Cancellation preserves the order, run, approval decision, receipts, and event history.

No v8 office record, memory, event, message, imported log, artifact, run, or source file is rewritten or deleted.

## Verification

The 101-test v0.8 suite covers local CLI execution, asynchronous API admission, transient daemon-poll recovery, concurrent-safe idempotency behavior, exact-tool receipt gates across every evidence policy, false-completion rejection, foreground handoff, authority narrowing, external-write approval, connector-bound approval, result delivery, in-flight cancellation fencing, and retained evidence. A separate two-process mock smoke admitted through the daemon and completed from the exact artifact receipt. A live Codex CLI run then read `package.json` and `goal.md`, prepared the correct durable release artifact, and completed with two `file.read` receipts plus the required `artifact.prepare` receipt. A live Claude Code run independently called `clock.now`, prepared a durable artifact containing its exact returned timestamp, and completed from those two required receipts. The portable 25-case comparison contract is [action-proof-v0.8.json](../benchmarks/action-proof-v0.8.json).

The local Docker server did not answer a bounded `docker version` probe, so the v0.8 image still needs a CI build or responsive daemon. Sendblue, calendar/MCP, browser, and process-backend smokes remain release gates because their live configuration was unavailable in this shell; deterministic fixtures cannot establish external service readiness or credential validity.
