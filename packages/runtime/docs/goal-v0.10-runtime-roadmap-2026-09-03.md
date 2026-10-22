# Co runtime roadmap (archived 2026-09-03)

> This is the pre-product-contract roadmap, preserved without erasing its implementation history. The controlling goal is now [`../goal.md`](../goal.md).

## Objective

Build a production-oriented, model-agnostic agent harness that can understand an outcome, determine the safest useful next action, and carry it through without making the operator assemble tools manually.

The runtime keeps Co's strongest kernel—durable execution, provenance-aware longitudinal memory, explicit authority, tactful attention, portable behavior distributions, and asynchronous media—while adopting proven mechanisms from OpenClaw and Hermes Agent as modular subsystems.

This is a general product runtime. No person's identity, psychology, credentials, history, preferred model, or private integration may be hardcoded into core code, bundled skills, tests, or deployment defaults.

## Product boundary

The first supported production boundary is one isolated tenant per runtime cell. A cell may contain several agents acting for that tenant, but it is not a security boundary for mutually hostile users. Shared-host, adversarial multi-tenancy requires the later Postgres, queue, blob-store, and workload-isolation adapters.

The runtime is not:

- An accountability or compulsory self-improvement machine.
- A personality whose judgment is inseparable from its infrastructure.
- A thin chat interface that merely presents a menu of tools.
- A system that silently rewrites memories, skills, permissions, or source logs.
- A claim that every OpenClaw or Hermes feature must be rebuilt locally.

## Sources and retained advantages

### Co kernel retained

- Append-only events, immutable source history, rebuildable projections, and migrations that never discard prior records.
- Memory claims with observation time, confidence, provenance, confirmation, correction, and supersession.
- Temporally diverse retrieval that prevents recent episodes from eclipsing stable evidence.
- Durable runs, jobs, leases, fencing, idempotency keys, action receipts, approvals, and recovery.
- An explicit attention policy that prices interruption and permits silence.
- Portable distributions and skills, with a neutral default and no implicit persona fallback.
- Asynchronous URL and video understanding that stays off the foreground response path.

### OpenClaw mechanisms adopted

- Descriptor-first plugin discovery: manifests can be inspected and activation can be planned without executing plugin code.
- Inference-first onboarding: produce a plan, validate the selected model route and capabilities, then apply atomically.
- A connector registry instead of channel-specific branches throughout the runtime.
- Execution isolation as a backend contract, with disabled-by-default local execution and hardened container execution.
- Capability and security diagnostics that explain why a plugin, connector, provider, or backend is unavailable.

### Hermes mechanisms adopted

- Procedural learning as a lifecycle: propose, review, approve, install, evaluate, revise, or retire a skill.
- Every learned skill carries evidence and provenance; the agent cannot silently grant it more authority.
- Execution backends are selected independently from models and tools.
- Child-agent state and bounded output previews are observable while work is running.
- Provider, tool, and backend setup is explicit and testable rather than scattered across environment variables.

### Prime Agent mechanisms adopted with Co governance

- Immediate child-agent admission: delegation returns a durable handle instead of blocking the foreground turn.
- Retained, addressable child sessions with bounded family messaging, follow-ups, passivation, and recovery.
- Persistent goals whose completion is checked by an independent gate and bounded continuation policy.
- Attach/resume interaction with cursor-based event delivery, steering, and process-independent session ownership.
- Plan/apply refinement with baseline conflict detection, versioned local/global scope, and rollback views.
- A programmatic model workspace as an optional sandboxed cache, never canonical memory or an authority bypass.

The first five mechanisms are implemented in v0.5. The programmatic workspace remains an optional future phase. Prime Agent's unsandboxed execution and model-applied global refinement were explicitly not adopted. The pinned source review and comparison are recorded in [the Prime Agent reference](prime-agent-reference-2026-08-06.md); implementation evidence and residual caveats are recorded in [the v0.5 adoption audit](prime-adoption-audit-2026-08-07.md).

The initial implementation borrows architectural mechanisms, not source code. Any future copied or adapted code must retain its upstream license and be recorded in a provenance note.

## Architecture

```text
CLI / HTTP / connectors
          |
guided onboarding + capability diagnostics
          |
connector and plugin registries (descriptor-first, selected explicitly)
          |
runtime kernel
  |       |          |             |             |
models  tools     child agents   perception     office
          |          |             |             |
execution backends  live monitor  attention policy  mandates/matters/prepared work
          |
durable event / run / receipt / memory / skill-proposal store
```

Plugins are trusted operator-installed packages, but discovery must never execute them. Manifest v1 contributes skill roots and MCP descriptors; the typed connector and execution registries are the extension seams for later descriptor versions. Runtime activation is explicit per profile and fail-closed when a selected capability is missing or invalid.

Skills are instructions, not authority. Installing a skill cannot change tool risk, standing approvals, workspace boundaries, secrets, or connector permissions.

## Delivery phases

### Phase 1 — safe composition foundation

- [x] Versioned plugin manifests with deterministic discovery, validation, duplicate detection, explicit profile selection, and activation diagnostics.
- [x] Connector registry with the existing Sendblue integration behind the common interface.
- [x] Guided `onboard plan`, `onboard apply`, and `onboard verify` flow that never stores raw credentials in a profile.
- [x] Portable per-role model routes and selected capabilities in profiles.
- [x] Agent monitor exposing run trees, status, usage, active tool/approval state, and bounded event/output previews over CLI and HTTP.
- [x] Skill proposals with evidence, review state, collision-safe installation, immutable proposal history, and explicit rejection/retirement.
- [x] Execution backend contract with `none`, bounded local process, and hardened Docker implementations. Execution remains unavailable until explicitly selected and approved.
- [x] Production validation, migrations, API bounds, structured logs, metrics, documentation, and tests for every new boundary.

### Phase 2 — useful connector breadth

- [x] Daemon-aware daily-driver CLI with durable progress attachment, in-flight cancellation, stale-run inspection/recovery, and honest terminal rendering.
- [x] Durable operator-approved mandates, evolving matters, prepared service artifacts, held-attention inbox, `today` projection, and provenance explanation.
- [x] Useful interventions that cannot or should not interrupt are held for review when they clear a usefulness floor; weak signals remain silent.
- [x] Asynchronous retained agents: immediate admission handles, durable lifecycle state, bounded mailboxes, follow-up steering, and restart-safe monitoring.
- [x] Persistent goals with explicit evidence contracts, bounded continuation, deterministic completion gates, and unchanged-input gate caching.
- [x] Typed refinement proposals for prompt overlays, agent specifications, procedures, and memory policy, preserving approval, versioning, provenance, and non-erasure.
- [x] Cursor-based attach/resume streams over the existing durable run/event system.
- [x] Evidence-gated durable work orders with asynchronous CLI/API/model admission, authority snapshots, approval handoff, connector-bound delivery, cancellation, and receipt-backed terminal states.
- [x] A vendor-neutral 25-case action benchmark contract covering local work, external effects, recovery, context use, and judgment.
- [x] Provider-neutral transactional email, short-lived control verification, opaque verified identities, revocation, abuse bounds, and receipt-backed delivery without exposing codes to models.
- [x] Asynchronous longitudinal perception with dated provenance, counterevidence, hypothesis maturation, adversarial criticism, explicit feedback, stricter perceptual attention, and inspectable CLI/API state.
- [ ] Generic signed-webhook ingress and HTTPS outbound connector.
- [ ] Calendar, email-inbox, and call-recording plugins using existing APIs or MCP rather than bespoke runtime branches.
- [ ] Telegram and Slack adapters, followed by direct platform adapters only where they materially outperform existing providers.
- [ ] Connector pairing, consent receipts, per-peer policy, delivery idempotency, retry classification, and health diagnostics.

### Phase 3 — product onboarding and operations

- [ ] Conversational/web onboarding built on the same plan/apply API as the CLI.
- [ ] Live inference verification before a model route becomes active.
- [ ] Connector OAuth/secret-store handoff, permission explanations, import previews, and reversible calibration.
- [ ] Operator UI for agent trees, approvals, schedules, memories, learned skills, costs, and connector health.
- [ ] Staging, load, restore, upgrade, fault-injection, and connector-contract suites.

### Phase 4 — scalable cells

- [ ] Transactional Postgres store adapter, durable queue adapter, and object/blob artifact store.
- [ ] Per-cell workload orchestration, encrypted tenant secrets, regional placement, quotas, billing, and audit export.
- [ ] A migration path from single-host SQLite cells that preserves every event, receipt, memory source, and imported-log identity.

## Phase 1 acceptance criteria

1. A new operator can inspect an onboarding plan before any file, credential, or remote system is changed.
2. Applying a plan is atomic, refuses collisions, and creates a neutral isolated profile with no secrets.
3. Unknown, duplicate, malformed, unselected, or unavailable plugin capabilities fail closed with actionable diagnostics.
4. Existing profiles, SQLite records, imported logs, distribution manifests, and source files continue to work unchanged.
5. A child-agent tree can be inspected without exposing hidden reasoning or unbounded/secret-bearing tool output.
6. An agent may propose a reusable skill, but only an explicit approval can install it; installation cannot expand authority.
7. Process execution is disabled by default. When enabled, command, working directory, environment, time, output, network, filesystem, and container-image boundaries are enforced by the selected backend.
8. Production startup rejects implicit identities, implicit providers, weak authentication, unsafe remote URLs, unbounded workspaces, overly broad standing authority, and invalid selected capabilities.
9. Type checks, unit/integration tests, dependency audit, production configuration check, Docker build, health probes, authenticated metrics, and graceful shutdown all pass.

## Non-erasure invariant

All upgrades are additive or superseding:

- Schema migrations retain old tables or copy data forward transactionally.
- Learned-skill revisions create a new version and retain the prior version and evidence.
- Retained-agent cancellation and retirement preserve sessions, mailboxes, runs, results, and artifacts.
- Goal transitions and gate results remain in the event ledger; completion does not delete supporting evidence.
- Mandate transitions, matter evidence, prepared artifacts, attention resolution, and run cancellation retain their source records and append lifecycle events.
- Work-order completion, missing evidence, retry exhaustion, approval, and cancellation retain the objective, result, run, receipts, and complete event stream.
- Email verification and revocation append lifecycle records; schema v10 adds tables without rewriting prior events, memories, imports, sessions, or local source logs.
- Perception hypotheses, evidence links, critic decisions, intervention links, and feedback are additive schema-v11 records. Rejection changes projection state; it never deletes the hypothesis or any source event, message, import, artifact, memory, or local log.
- Refinement supersession, retirement, and rollback retain every proposal and overlay version.
- The Co rename reads old configuration and data locations through compatibility aliases; it does not rewrite or delete stored history.
- Memory corrections supersede claims; they do not delete provenance.
- Imports are append-only and idempotent; original local logs are never modified.
- Profile onboarding never overwrites an existing profile.
- Destructive migration or reset commands are out of scope for automated onboarding.

## Verification record

As of 2026-08-25, Co v0.10 passes 114 tests plus TypeScript checking. Schema v11 migrates additively and the deterministic suite proves multi-date owner-evidence maturation, non-surfacing of generic/recent stories, correction-preserving rejection, stricter perceptual attention, low-priority background scheduling, unchanged raw events, and the existing runtime/authority/recovery contracts. Foreground turns only enqueue `perception.synthesize`; content and ambient inputs join the same background path. The live semantic quality of the configured generator/critic models and calibration against a larger real-conversation replay corpus remain release evaluation gates, not claims established by unit tests. Design, interfaces, thresholds, and residual risks are recorded in [the v0.10 perception note](perception-engine-v0.10-2026-08-25.md).

As of 2026-08-24, Co v0.9 passes 108 tests plus TypeScript checking. The new deterministic coverage proves that one-time codes are not returned, logged, or persisted in plaintext; wrong guesses lock, expired codes fail, uncertain deliveries remain inspectable without blind retry, requests and verified sends are idempotent, agent-initiated sends require external-write approval, authenticated HTTP exposes only masked identities, and schema v10 migrates additively. The Resend adapter contract is tested against a captured HTTPS request; no live Resend credential or authorized sender was available in this shell, so live provider delivery remains an explicit deployment smoke gate. The implementation and residual product boundary are recorded in [the v0.9 email note](email-verification-v0.9-2026-08-24.md).

As of 2026-08-24, Co v0.8 passes 101 tests plus TypeScript checking. The new coverage includes local and daemon-backed `co do`, transient daemon-poll recovery, asynchronous HTTP admission, exact-tool and minimum-receipt completion gates across every evidence policy, false-completion rejection, model handoff, authority narrowing, external-write approval, connector-bound approval and delivery, in-flight cancellation fencing, benchmark validation, and additive schema v9 migration. The production dependency audit reports zero vulnerabilities; package, credential, personal-path, JSON, and whitespace checks are clean. A clean two-process mock smoke admitted a work order through the daemon, prepared a durable artifact, completed from its exact tool receipt, and returned stable work-order/run/evidence handles to the CLI. A live Codex CLI run read `package.json` and `goal.md`, prepared the correct durable release artifact, and completed only after the required `file.read` and `artifact.prepare` receipts existed. A separate live Claude Code run called `clock.now`, prepared an artifact containing the exact returned timestamp, and completed from those two required receipts. The local Docker server still did not answer a bounded `docker version` probe and the call was interrupted, so the v0.8 image must be rebuilt in CI or against a responsive daemon. Sendblue, calendar/MCP, browser, and process-backend smokes remain environment-specific release gates because their live configuration was unavailable in this shell.

As of 2026-08-22, Co v0.7 passes 89 tests on the development runtime. The production dependency audit reports zero vulnerabilities; the dry-run package and credential/personal-path scans are clean. The suite now includes institutional-record provenance, end-to-end office CLI use, non-erasing run cancellation, daemon attach/control, in-flight result fencing, attention holding, and deterministic relevance-aware tool selection in addition to the existing production, authority, memory, collaboration, connector, media, and CLI ingress coverage. The local Docker build was interrupted after the OrbStack socket stopped responding without build output, so the v0.7 image still requires a responsive daemon or GitHub CI. Phase 1 evidence is recorded in [the Phase 1 completion audit](completion-audit-2026-08-05.md); retained collaboration, goals, attach/resume, and governed refinement evidence is recorded in [the v0.5 adoption audit](prime-adoption-audit-2026-08-07.md); naming and backward compatibility are recorded in [the v0.6 naming audit](co-naming-audit-2026-08-09.md); adversarial authority, cancellation, lease, recovery, state-corruption, and connector-delivery evidence is recorded in [the seam-hardening audit](seam-hardening-audit-2026-08-10.md).

The Docker invocation and process boundary are integration-tested with a fake daemon client for digest pinning, no network, disabled daemon logging, a read-only root, a single read-only workspace mount, dropped capabilities, `no-new-privileges`, resource bounds, timeout cleanup, cleanup confirmation, and fail-closed cleanup uncertainty. GitHub Actions run `31429075893` passed the published base's Node 22.19 typecheck/test matrix, production dependency audit, and real image build. A local image build and unprivileged-user CLI smoke also passed before the final crash-atomicity edit in this seam-hardening pass; the attempted final rebuild then stalled when the OrbStack daemon stopped returning server state. The final working tree must be rebuilt locally or in CI before release. Live provider and connector smoke tests remain separate release gates.

## Success measure

The harness succeeds when a person can state an outcome or share context, and the system reliably finds and performs the next authorized useful step—with less setup burden, less unjustified interruption, and better evidence-backed judgment than a generic tool-oriented agent—while remaining portable across models, connectors, execution environments, and optional personalities.
