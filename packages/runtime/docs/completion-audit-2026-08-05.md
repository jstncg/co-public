# Phase 1 Completion Audit — 2026-08-05

## Verdict

The hybrid runtime's Phase 1 implementation is complete in source and passes its type, unit, integration, pinned-runtime, dependency, configuration, and live-process checks. It is a production-oriented **single-tenant runtime cell**, not yet a shared-host multi-tenant control plane.

One release check remains environment-blocked: the current v0.4 Docker image has not been rebuilt because the local OrbStack Docker socket accepts connections but does not return a daemon response. The Docker invocation and cleanup contract is integration-tested without the daemon, and CI is configured to perform a real image build. Phase 1 should not be called fully release-verified until either that CI job or a local build passes.

Phases 2–4 in [goal.md](../goal.md) are an explicit future roadmap. Calendar/email/call connectors, an operator UI, OAuth onboarding, Postgres/queue/blob adapters, and shared SaaS operations are not claimed here.

## Requirement evidence

| Boundary | Implementation evidence | Verification | Status |
| --- | --- | --- | --- |
| General product, optional behavior | Neutral distribution is the default; distributions and skills are portable data; profiles contain operational scope rather than embedded identity. | Distribution/profile tests reject implicit Donna fallback, environment scope leakage, and profile overwrite. Repository scan found no operator identity, credential, or local absolute-path dependency in runtime defaults. | Pass |
| Longitudinal, non-erasing memory | Append-only events and imports, provenance-bearing memory claims, confirmation/correction/supersession, temporally diverse retrieval, and schema migrations live in `store.ts`, `memory.ts`, and `importer.ts`. | Tests cover stable evidence despite recency, correction provenance, deduplication without history deletion, tenant safety, append-stable moved logs, untouched source files, and legacy database migration. | Pass |
| Durable action authority | Runs, jobs, leases, fencing, idempotency keys, tool receipts, approvals, and recovery remain the sole action kernel. Skills and model transports cannot grant authority. | Runtime tests cover pause/resume, denial, retry identity, serialized sessions, completed-receipt recovery, schedule deduplication, leases, and stable job idempotency. | Pass |
| Attention and useful media | Attention policy can choose silence; URL/video work is queued off the foreground path; media artifacts are durable and tenant-scoped. | Tests cover weak/repeated-signal suppression, SSRF-sensitive URL rejection, Flash-Lite escalation, captioned/captionless YouTube paths, and media cache scoping. | Pass |
| Provider portability | Foreground, deliberation, background, and critic routes independently select provider, model, output ceiling, and reasoning effort. Direct OpenAI/Anthropic, OpenAI-compatible, Codex CLI, Claude Code CLI, and mock test routes are isolated behind adapters. | Tests round-trip mixed per-role routes, reject embedded API keys and unknown fields, preserve provider reasoning state, and validate production credential requirements. | Pass |
| Reviewable onboarding | `onboard plan` is read-only; `apply` verifies the content-addressed capabilities and creates profiles exclusively; `verify` reports provider, plugin, execution, and production diagnostics. | Tests cover zero-write planning, no stored secrets, path bounds, collision refusal, plan/profile tampering, plugin change between plan/apply, and neutral execution defaults. | Pass |
| Descriptor-first plugins | Bounded `plugin.json` discovery never imports plugin code. Activation is explicit, deterministic, namespaced, path-contained, and duplicate-safe. | Tests cover unselected inert plugins plus missing, duplicate, malformed, unknown-field, changed-after-review, and missing-contribution failures. | Pass |
| Connector seam | Connector registry separates channel direction/readiness from model/runtime logic; Sendblue is an adapter rather than a server/worker special case. | Registry and Sendblue tests cover model independence, directional readiness, group identity, group replies, and durable webhook acknowledgement. | Pass |
| Execution isolation | `none` is the default; local execution is shell-free and rejected in production; Docker uses a digest-pinned image, no network/logging, read-only root, a single bounded workspace mount, dropped capabilities, `no-new-privileges`, resource limits, unprivileged identity, named containers, and verified forced cleanup. | Tests cover disabled registration, allowlist/cwd bounds, production rejection, Docker arguments, timeout cleanup, cleanup confirmation, and fail-closed uncertainty. Real v0.4 image build remains pending. | Partial: daemon check pending |
| Procedural skill learning | Tenant-scoped proposals require evidence and explicit lifecycle transitions. Installation creates versioned files; revision/retirement preserve prior evidence and artifacts, and cannot alter authority. | Tests cover approval-before-install, foreign evidence rejection, collision-safe revisions, transactional status, active-version uniqueness, live registry refresh, and retirement markers. | Pass |
| Observable child agents | Child tasks are bounded durable runs with parent lineage. Monitor output includes status, budgets, active approval/tool state, and bounded redacted previews—not hidden model reasoning. | Tests cover single/batch delegation, lineage, pending approvals, flat response bounds, and redaction of bearer and common provider-secret formats. | Pass |
| Operator surfaces | CLI and authenticated HTTP expose chat, runs/agents, approvals, events, capabilities, plugins, connectors, execution, skills, schedules, health, and metrics. | HTTP tests cover auth, constant-time token comparison path, JSON/body limits, headers, rate limiting, safe production errors, readiness, metrics, and durable webhook ingress. Live daemon readiness/metrics/graceful shutdown smoke passed. | Pass |
| Production boundary | Startup validates explicit profile/tenant/provider, strong auth, credential references, HTTPS dependencies, bounded paths, conservative authority, and selected capabilities. SQLite uses private permissions; logs and monitor output redact secrets. | Explicit production configuration passes; unsafe configurations fail closed; clean production-only dependencies start under Node 22.19. | Pass for isolated cell |

## Acceptance criteria disposition

1. **Pass:** onboarding planning performs no write or remote mutation.
2. **Pass:** apply revalidates the plan, refuses collisions, and stores no secrets.
3. **Pass:** plugin discovery and activation fail closed across all requested invalid states.
4. **Pass:** legacy database/import/profile behavior is retained; source logs are not modified; upgrades add or supersede records.
5. **Pass:** monitor data is bounded and redacted and excludes hidden reasoning/state.
6. **Pass:** learned skills require approval and cannot expand tool authority.
7. **Pass, with image-build caveat:** execution boundaries and cleanup are tested; current real Docker image build is pending.
8. **Pass:** production startup validation rejects implicit or overly broad configuration.
9. **Partial:** type checks, 59 tests on Node 22.19, dependency audit, production configuration, production-only install/start, readiness, authenticated capability/metrics, and graceful shutdown pass. The real v0.4 Docker build is the only outstanding item.

## Verification commands

```sh
npm ci --ignore-scripts
npm run check
npx --yes node@22.19.0 --test test/*.test.ts
npm audit --omit=dev --audit-level=high
npm start -- config check --profile /path/to/profile.json
docker build --tag co:0.4.0 .
```

Observed results:

- TypeScript: pass.
- Development runtime: 59/59 tests pass.
- Node 22.19.0: 59/59 tests pass.
- Production dependencies: zero known vulnerabilities reported by `npm audit`.
- Explicit production configuration: pass.
- Clean `npm ci --omit=dev --ignore-scripts` runtime start: pass.
- Live authenticated readiness, capabilities, Prometheus metrics, and graceful shutdown: pass.
- Docker v0.4 image build: pending a responsive daemon or CI.

## Non-erasure finding

The implementation adds schema objects and superseding records; it does not include an automated reset, source-log rewrite, memory-history deletion, or profile-overwrite path. Imported local logs remain source artifacts and are addressed with stable append-aware identities. Learned-skill retirement leaves a marker and the versioned instructions in place. Any later Postgres or hosted migration must preserve these identities and provenance links as a release gate.

## Release decision

The source is ready for a Phase 1 release candidate as an isolated tenant cell. Release promotion requires one final command on a functioning daemon:

```sh
docker build --tag co:0.4.0 .
```

Do not market this revision as a multi-user SaaS platform or as having the Phase 2–4 integrations. Those require the roadmap work and separate security, restore, load, and connector-contract evidence.
