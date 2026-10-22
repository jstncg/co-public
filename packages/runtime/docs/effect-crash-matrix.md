# Effect crash matrix

This is the release contract for any consequential operation. A process may die
at every boundary below. Recovery is allowed to repeat an operation only while
durable state proves the effect never began. Provider idempotency and explicit
reconciliation remain necessary because a local database cannot prove what a
remote system did after dispatch.

## Connector delivery and native reactions

The composed matrix executes the real `RuntimeWorker` delivery path for both
text and native tapbacks, closes the SQLite runtime, opens a new runtime against
the same database, and retries the same operator instruction. The adapter
records actual calls and idempotency keys. No test manufactures the post-crash
delivery state. Reactions remain typed throughout; recovery may never degrade a
tapback into an empty text bubble.

| Injected process-death point | Durable state after death | Recovery contract |
| --- | --- | --- |
| Before intent persistence | No delivery row | Safe to admit the intent and dispatch once |
| After intent persistence | `not_started` | Reclaim after lease expiry; dispatch once |
| After the append-only intent event | `not_started` plus exact request digest | Reclaim after lease expiry; dispatch once |
| After effect begin, before provider call | `running` | Become `uncertain`; never dispatch automatically |
| After provider response, before acceptance evidence | `running` | Become `uncertain`; never dispatch again without reconciliation |
| After acceptance evidence | `running` plus bound acceptance event | Repair the delivery projection; do not call the provider again |
| After acceptance projection | `accepted` | Repair downstream projections; do not call the provider again |
| After early status reconciliation | `accepted` with any authenticated status applied | Preserve status and repair the member projection once |
| After member conversation projection | `accepted` plus deterministic relationship message | Retry is a no-op for both provider and conversation history |

Each accepted scenario produces one provider call, one acceptance event, and
one member-relationship projection—either a text message or a typed reaction.
Each ambiguous scenario produces one durable reconciliation item and zero
automatic repeats. Operator-proven acceptance projects an uncertain reaction
exactly once. These assertions live in `test/delivery-crash-matrix.test.ts` and
`test/runtime.test.ts`.

## Generic tool effects

Tool execution uses the same three-state safety rule:

| Receipt state | What recovery knows | Allowed behavior |
| --- | --- | --- |
| `running/not_started` | Intent exists; effect did not begin | A current replacement run lease may reclaim it |
| `running/accepted` | Effect initiation crossed the durable boundary | Mark uncertain on recovery; do not repeat a non-idempotent call |
| Terminal with outcome scope | The tool evaluator and receipt commit confirm the outcome | Reuse the receipt; do not execute again |
| Terminal with request scope | A downstream system accepted work, but completion is not proven | Reconcile or await downstream outcome; cannot complete an outcome-gated work order |

Lease-theft, pre-effect reclaim, ambiguous non-idempotent recovery, late-result
fencing, and receipt reuse are executed in `test/reliability.test.ts` and
`test/seams.test.ts`. Durable local file replacement separately injects failure
before rename and after rename but before directory `fsync`; the latter is
reported as non-retryable uncertainty because replacement may already be
visible.

## Adding an effect

A new effect is not release-ready until it:

1. persists an exact, tenant-bound intent and argument digest before initiation;
2. atomically crosses from `not_started` to an effect-started state under the
   current lease and current authority;
3. passes the stable idempotency key to the provider when supported;
4. records semantic acceptance separately from confirmed outcome;
5. turns any unprovable post-initiation result into visible uncertainty;
6. has a restart test at each newly introduced persistence boundary; and
7. projects the confirmed result idempotently into the member relationship.

The fault injector used by the matrix is constructor-only, absent by default,
and cannot be enabled through runtime configuration or model tools.
