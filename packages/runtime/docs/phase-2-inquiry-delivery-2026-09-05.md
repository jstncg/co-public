# Inquiry authority through delivery — 2026-09-05

## Implemented

The runtime now binds each inquiry-derived intervention to its exact durable foreground decision. Perception synthesis supplies that decision ID itself; source text and model output cannot manufacture it. The relationship admission's existing immutable authority reference carries the binding into the durable dispatch job, without changing historical admission digests.

Eligibility is checked at candidate evaluation, held-candidate reactivation, delivery selection, durable retry, and immediately before transport initiation. The final check and the outbound state transition share a SQLite write transaction. The relationship lease and immutable dispatch binding are also checked at this boundary.

A message is withheld when its inquiry deadline has passed, the decision has been withdrawn, the inquiry no longer allows foreground output, its source/relationship binding is wrong, or its natural conversational opening is over thirty minutes old. A message that was appropriate as a reply does not gain permission to interrupt simply because it waited in a queue.

Quiet or suppressed decisions revoke earlier foreground decisions for that inquiry. Revocation timestamps remain inspectable, and later permission does not erase them. Findings and delivery-attempt history are preserved. Old unsent perceptual candidates without exact inquiry authority fail closed; authority is not reconstructed from a matching topic or shared source event. Ordinary operational interventions remain on their existing authority path.

If withdrawal occurs after an outbound claim but before transport initiation, a lease-fenced transition records a failed/withheld transport with `message.delivery_withheld` evidence and no connector call. It cannot relabel an already-started transport as unexecuted. An already-started external send may still complete; provider acceptance and uncertainty retain their existing meanings.

Schema 56 adds nullable decision bindings and revocation timestamps. It does not delete or backfill speculative authority into historical records. Export/restore includes these fields.

## Verification

`npm run check`: TypeScript and 407 tests pass, no failures or skips. Ten added tests in `test/inquiry-delivery.test.ts` use real SQLite and a simulated connector, covering eligible delivery, expiry, held conversational openings, a rate-limited retry after database reopen, withdrawal between claim and initiation, non-resurrection, tenant/source/session isolation, export/restore, additive migration, legacy fail-closed behavior, and the pre-effect fence. Existing perception tests still retain suppressed candidates without failing the completed private investigation.

These are local runtime guarantees, not evidence of real-world relevance, provider reliability, or production readiness. No live source, permission, deployment, push, or private upload was performed.

## Budget review and next boundary

`src/providers.ts` currently enforces configured request-level cost ceilings; work orders also carry per-run token limits. `src/worker.ts` makes additional background calls for extraction, generation, counterevidence planning/verification, criticism, composition, and other evaluations. Those calls do not share a durable cumulative tenant/responsibility reservation ledger. A valid sequence of individually affordable requests can therefore exceed an intended overall allowance.

The next slice should establish explicit ownership and reserve cumulative capacity before each attempt, retain conservative debits for uncertain usage after failure, and reconcile trustworthy usage without double refunds. It must include retries and tool costs, and distinguish token/resource accounting for subscription CLI routes from pinned-price API accounting. Fair queue admission and service for accepted obligations need their own multi-tenant pressure tests; a budget ledger alone does not prove fairness.

The broader Phase 2 responsibility-linking and cumulative-budget checkboxes remain open. This slice connects inquiry decisions to delivery, not every matter, promise, watch, work order, or specialist.
