# Motive, substitution, and reference-peak scope audit — 2026-09-04

This audit asks whether Co's accountability-oriented interpretation machinery is active by default under the revised product scope. It is a source-and-test finding, not live product validation.

## Decision

Keep the implementation, but keep it outside ordinary Co behavior. No feature flag or destructive migration is warranted because the existing authority boundary is already explicit and narrower than a default-on behavior:

- A conversational `goal.create` requires a verbatim quote from the current owner message. An ordinary intention without a linked standards mandate is retained but excluded from foreground accountability context.
- A standards mandate begins as `proposed`. It grants no behavior or authority until the owner approves its normal external-write approval request; pause, retirement, and goal cancellation stop later use without deleting history.
- Motive synthesis is admitted only for an active goal with its original owner quote and a linked, approved, active standards mandate. The model cannot invoke a motive tool; the state is private and background-only.
- Persistence requires three bounded owner events spanning at least seven days, including the original commitment and current trigger, a real alternative, a falsifier, literal owner decision cues, and a separate adversarial critic. Confidence is capped at 0.65.
- Substitution is optional, needs its own two-event/seven-day evidence, rival, falsifier, and literal cues, and is capped at 0.55. A reference peak must select a runtime-counted historical window, cite owner context inside that exact window, cite the current trigger, and is capped at 0.50.
- None of these private interpretations may surface directly. They can only narrow when an already-authorized deterministic reality check is relevant. The member-facing text contains the dated owner quote and verified arithmetic, not the inferred motive.
- Exact negative feedback on the delivered reality check retires the exact motive that shaped it. Corrections append; they do not erase the prior hypothesis or source evidence.

## Remaining risk

Once a member deliberately activates a standards mandate, each later owner turn can queue a cheap, coalesced private eligibility pass. That is acceptable inside the explicitly requested standards service, but it remains an evaluation target: live pilots must show that the mandate language is understood, revocation is easy, private inference does not distort unrelated conversation, and reality checks are rare and useful. These mechanisms must never become an onboarding default, a general growth frame, or a hidden requirement for Co's perception engine.

## Evidence

The relevant deterministic coverage is in `test/agents-goals.test.ts`, including unmandated intentions, explicit activation, owner-quote binding, private evidence/critic requirements, confidence ceilings, decision relevance, revocation, correction preservation, and negative-outcome retirement. The repository-wide verification result for the implementation pass is recorded alongside the commit that closes this audit item.
