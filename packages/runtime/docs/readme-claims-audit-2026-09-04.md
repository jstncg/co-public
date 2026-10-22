# README and qualification claims audit — 2026-09-04

This review checks whether public repository language distinguishes implemented code, deterministic evidence, deployed integration evidence, and product evidence.

## Result

The README is aligned for the current candidate. Its status section calls the repository a tested single-tenant runtime candidate, explicitly says it is not a completed hosted product, names simulated dependencies, and keeps live providers, browsers, sensors, non-founder onboarding, multi-host operation, hostile-environment security, and longitudinal judgment as open release gates.

Capability bullets are acceptable only under that status boundary. They describe code paths exercised by deterministic tests, not production certification. Specific connector, browser, research, qualification, and deployment sections repeat their live limitations near the relevant claim. The version-2 product qualifier returns a tenant release-readiness scope, treats conversational feedback and tenure as diagnostics, and cannot pass without a preregistered same-tenant live independent-review plan. It still cannot self-attest reviewer independence, real participant identity, cohort results, deposit attribution, or causality.

This pass additionally corrected two stale implication risks:

- History ablation now runs both variants through the same Co runtime, tools, and semantic receipt contract. The README no longer permits a tool-less baseline to masquerade as evidence about context.
- The daily intervention claim is now evaluated from exact attention-reservation times across every rolling 24-hour window. Qualification no longer treats a monthly total as proof of a daily limit, and it fails closed when accepted legacy interventions lack reservation evidence. Reports publish only aggregate counts and the rolling maximum, not exact relationship activity times.
- Praise-dependent release qualification was removed. A frozen representative population now includes requested, optional, proactive, consequential, and silent decisions; two declared external-human reviews plus adjudication and one-sided Wilson bounds determine quality. Synthetic plans cannot qualify live value.

## Evidence levels retained

| Level | What may be claimed |
|---|---|
| Implemented | A source path and public contract exist. |
| Deterministically exercised | The composed local path passed a named test with real SQLite and simulated external dependencies. |
| Live qualified | A retained artifact proves the deployed provider/browser/sensor path. None was produced in this pass. |
| Product validated | Multiple real members demonstrate useful judgment and dependable outcomes under the goal's pilot contract. This remains open. |

The final Phase 0 `npm run check` passed 372 tests with zero failures, skips, cancellations, or todos for the implementation candidate. That result is local deterministic evidence only; it does not close reviewer-governance, live-integration, or product-value gates.
