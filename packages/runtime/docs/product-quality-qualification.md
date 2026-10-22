# Product-quality qualification

`co product-qualify` is Co's fail-closed tenant release gate. It combines canonical operational outcomes with one preregistered independent-quality plan; it does not accept a caller-supplied scorecard, use model self-grading, or infer value from praise, silence, provider acceptance, or artifact creation.

```bash
npm start -- product-qualify --quality-plan quality_plan_... --profile ~/.co/profiles/alex.json
```

The authenticated HTTP equivalent is `GET /v1/product-qualification?qualityPlanId=quality_plan_...`. Omitting the plan is valid for inspecting diagnostics, but the report cannot pass.

## Version 2 release gate

Required stages are:

- enough internally consistent canonical history to evaluate the tenant;
- no due promise silently overdue or merely accepted;
- at least one confirmed consequential effect and no unresolved uncertain consequential effect;
- every exact rolling 24-hour attention-admission window inside the configured intervention budget, with deliveries never exceeding provider acceptances; and
- a qualified preregistered independent-quality plan for the same tenant.

First-wow timing, explicit good/negative feedback, context-advantage reports, and tenure trends remain visible diagnostics. They are useful product signals but are not required stages and cannot make the release pass.

## Independent review contract

`IndependentQualityReviewManager` owns the programmatic review lifecycle. A plan is registered before its future observation window with a rubric, strata, thresholds, sample sizes, and a SHA-256 commitment to an unrevealed sampling seed. After the window closes, seed reveal freezes the complete eligible population and deterministically samples within each requested stratum:

- requested replies/results;
- optional foreground replies;
- proactive deliveries;
- explicit or policy-selected silence/suppression; and
- approvals, accepted-burden repairs, safety, and other consequential communication.

The population uses terminal decision time, not candidate creation time. Unresolved admissions fail freezing. Silent decisions remain in the denominator so a system cannot win by saying nothing. Blind packets remove tenant, provider, model, release, rollout, run, session, peer, and external transport identifiers while retaining the request/response evidence required for judgment.

Only records declared `external_human` are admitted. Every selected unit needs two primary reviews; a third adjudicator is required when they disagree. Corrections append and supersede rather than rewrite. Unknown labels, incomplete reviews, missing strata, insufficient samples, population drift, or a failed digest all fail closed. Qualification uses one-sided 95% Wilson bounds for worthwhile, harmful, unnecessary interruption, missed worthwhile opportunity, unsupported inference, and consequential action usefulness.

Synthetic plans can test the evaluator but can never qualify live product quality. The runtime cannot prove that a declared reviewer is human or independent; reviewer recruitment, identity, rubric training, and calibration remain external governance requirements.

Review plans, frozen packets, and reviews are tenant-scoped and included in verified export/restore. They are immutable during ordinary operation but remain removable through the exact export-confirmed tenant-deletion lifecycle, so evaluation history cannot defeat a member's deletion right.

## Deliberate limits

A passing report establishes only the named tenant and frozen window. It does not establish a real non-founder cohort, causal life improvement, universal product quality, deposit attribution, or mass-market fit. Those require representative live participants, calibrated independent reviewers, repeated cohorts, and member research. Deterministic fixtures prove the evaluator, not the product outcome.
