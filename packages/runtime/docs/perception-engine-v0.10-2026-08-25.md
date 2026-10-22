# Perception engine v0.10

## Outcome

Co now has a durable perception lifecycle separate from both chat context and memory. It can compare a person's own evidence across time, hold a tentative interpretation until it earns confidence, surface it only when it is worth the interruption, and retain explicit correction or rejection. The implementation is identity-neutral and works per tenant; no Donna-specific or operator-specific fact is present in the runtime.

This closes a real product gap. Before v0.10, Co had good local retrieval, memory provenance, and an operational attention gate, but no object representing “something the system may be noticing.” Background content analysis therefore had to jump directly from one source to a notification. That invited recency bias, generic psychologizing, and unsupported claims of insight.

## Lifecycle

`perception_hypotheses` stores the interpretation and calibrated scores. `perception_evidence` links it to immutable source events as `supports`, `contradicts`, or `context`. `perception_feedback` stores only explicit feedback: `resonated`, `corrected`, `rejected`, `annoyed`, or `neutral`.

```text
candidate -> maturing -> ready -> surfaced -> confirmed
                |          |          |
                +----------+----------+-> rejected
```

The lifecycle is deliberately conservative:

- One event cannot mature a personal interpretation.
- Readiness requires at least three supporting events, two owner-trusted events separated by at least seven days, a plausible alternative explanation, and bounded contradiction.
- Confidence, specificity, novelty, and perceptual value must clear deterministic floors; genericity must remain low.
- A generator can propose at most two candidates from one background pass.
- An independently routed critic can reject the candidate or revise its scores and surface wording.
- A ready hypothesis passes through a perceptual attention score that penalizes genericity, sensitivity, and interruption cost. Operational urgency and actionability do not masquerade as insight value.
- Delivery marks a hypothesis `surfaced`. Silence never confirms it. Only explicit response can mark it `confirmed` or `rejected`.
- A correction, rejection, or annoyance stops that turn's background system from immediately generating another interpretation.

## Dataflow and latency

Foreground completion transactionally queues both ordinary memory extraction and `perception.synthesize`. It does not invoke another model before returning the answer. Enriched URLs/videos and normalized ambient events also enqueue perception work after their durable evidence exists.

Queued does not mean “spend two model calls on every message.” A deterministic change gate defers synthesis until at least three owner events span seven days, ignores tiny conversational changes, and coalesces ordinary conversation through a 30-minute per-session cooldown. Artifact and ambient triggers bypass the conversational cooldown because they represent newly available evidence. Perception jobs are lower priority than every ordinary due job, so background reflection does not get ahead of conversation, action, approval, memory, or connector work. Deferred decisions are durable audit events. Explicit feedback classification remains separate so a short correction is not mistaken for an unimportant trigger.

```text
foreground response ───────────────> returned to user
        |
        +-> durable perception job
                |
     temporally diverse evidence bundle
                |
       generator -> critic -> hypothesis
                               |
                    maturity + attention gate
                               |
                  silence / hold / delivery
```

The evidence bundle is bounded. It combines the current trigger, lexical matches, a per-month sample of owner evidence, recent untrusted world evidence, active/rejected hypotheses, and prior explicit feedback. Owner statements may support an interpretation about the person. Prior assistant output cannot. External media and connector content remain untrusted and can describe the world but cannot prove the person's belief.

This uses the existing local SQLite evidence projection. A graph database is not required to establish provenance, temporal breadth, corrections, or lifecycle correctness. A future graph can improve relationship traversal, but it must remain a disposable projection over the event ledger and perception links.

## Non-erasure and portability

Schema v11 adds three perception tables and one nullable `interventions.hypothesis_id` column. It does not rewrite events, messages, memories, artifacts, imports, email identities, work orders, or source files. A rejected hypothesis remains inspectable with its evidence and feedback. Repeated synthesis adds evidence and reassessment events rather than overwriting the underlying history.

The module depends on the runtime store and provider roles, not a particular model, connector, distribution, person, or graph vendor. The `co` and optional `donna` distributions share the same mechanism. Generator, critic, foreground, and background routes remain independently configurable.

## Operator surfaces

CLI:

```bash
npm start -- insights [--status ready]
npm start -- insight show phy_...
npm start -- insight feedback phy_... corrected "What it missed"
```

HTTP:

- `GET /v1/insights?status=ready`
- `GET /v1/insights/:id`
- `POST /v1/insights/:id/feedback` with `{ "kind": "corrected", "note": "..." }`

`GET /v1/capabilities` advertises the perception lifecycle. `co status` reports mature insight count. Hypothesis detail includes linked evidence, explicit feedback, and any intervention decisions.

## Deterministic evidence

The v0.10 suite adds coverage for:

- maturation from three owner events spread across five months;
- refusal to ready a generic three-day reflection story;
- correction changing projection state without deleting source events;
- perceptual attention suppressing generic action-coaching while admitting a specific non-actionable realization;
- behavioral regressions modeled on actual failure classes: fake media coverage, invented people, ignored correction, fabricated duplicate history, forced introspection, recency bias, and turning realization into homework.

The full repository currently passes 114 deterministic tests and TypeScript checking.

## Residual release gates

The mechanism is implemented and locally verified, but semantic quality is model-dependent. Before calling it superior in production, run a permissioned, de-identified replay corpus spanning months and measure precision, useful-surprise rate, correction/rejection rate, repeated-failure rate, interruption acceptance, and time-to-feedback across the intended model routes. Calibrate thresholds from those outcomes without fine-tuning core behavior to one person. Live connector delivery, multi-worker load, and configured-provider cost/latency also remain deployment-specific smokes.

The engine intentionally does not autonomously mine every local file on upgrade. Existing logs remain where they are; use the explicit append-only import and history reindex paths so scope and provenance remain reviewable.
