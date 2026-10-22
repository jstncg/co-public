# Co

Our own narrow agent harness, built around a different product premise: a person should be able to hand it something or state an outcome, and the system should work out what it can safely do next. It adopts proven mechanisms from OpenClaw and Hermes while keeping any person's identity, memory, and authority out of the runtime core.

The default `co` distribution is identity-neutral. Donna remains an optional bundled distribution, represented by a portable JSON manifest; it is not a runtime fallback. Unknown distribution IDs fail closed. Profiles select an isolated tenant, distribution, context roots, and local settings without embedding secrets or personal assumptions in code.

## Status

The canonical implementation now lives in Co at `projects/co/packages/runtime`. It has **not replaced
the live Co/iMessage system**. See [migration status and limits](MIGRATION.md), including the failed
automatic-restart qualification and the distinction between native-image/semantic-retrieval code and
an activated, evaluated production integration.

This repository is a tested single-tenant runtime candidate, not a completed hosted product. The local CLI, HTTP daemon, durable worker, provider adapters, Sendblue and Linq adapters, retained agents, goals, memory, approvals, monitoring, bounded private inquiries, WorldScout research contracts, reversible consequence planning, persistent read-only scouts, typed opportunity scanning, progressive sensor consent, tenant export/restore/deletion, and an origin-bound browser credential broker are implemented and exercised with simulated dependencies. Live-provider, live-browser, and live-sensor smoke tests, a real non-founder onboarding/outcome trial, multi-host storage, hostile-environment isolation, and longitudinal product-quality evaluation remain release gates. The open work is tracked explicitly in [goal.md](./goal.md); passing deterministic tests and the CI image build are not proof that external integrations are deployed or that Co's judgment is good enough.

## What is working in v0.10

- A real CLI and HTTP daemon.
- `co do` admits durable work orders through the local runtime or persistent daemon. Each order snapshots its tool authority, token budget, model role, success contract, and completion-evidence policy.
- Work orders run asynchronously, survive process restarts through the job/run lease system, pause for ordinary risk approvals, and return results to their originating connector conversation. Foreground chat can hand work off with `work.submit` without blocking its reply.
- Future promises are durable obligations, not prose: `promise.accept` atomically records the burden and its due job before acknowledgment, linked work settles it from receipt-backed completion, and an overdue promise creates a repair item plus an honest relationship message. Unscheduled model promises are blocked from canonical history.
- Completion is independently fenced by strict, versioned evidence requirements. Tool and external-write work orders require successful outcome-scoped receipts from named tools; reads, prepared work, accepted delegation, failed processes, and arbitrary non-throwing JSON cannot stand in for the promised result. Text-only confidence becomes `needs_input`, not completion.
- Prepared consequences can be promoted only from a current owner-authored verbatim request into that same work-order engine. Their lifecycle then follows exact receipt-backed outcomes instead of stopping at a suggestion artifact; consequential effects still cross approval or a narrow active mandate.
- Daemon-aware chat: the CLI automatically uses the persistent loopback daemon when it is available, attaches to durable run progress, and falls back to a local runtime when it is not. `--local` and `--daemon-url` make either mode explicit.
- A dependency-free terminal renderer with truthful elapsed work state, tool/approval transitions, color/TTY detection, `NO_COLOR`, plain output, and JSON output.
- Durable standing mandates, evolving matters, prepared service artifacts, and a held-attention inbox with source-event provenance. Proposals do not grant authority; only an operator can activate a mandate. Versioned action rules can waive a per-call approval only for an exact tool plus a non-empty argument constraint, within a per-rule use cap and optional expiry; every use is claimed atomically and pause or retirement revokes future use.
- A bounded follow-through planner can discard weak implications, hold useful context, create a watching matter, or prepare a private brief/draft/option. It has no direct external-action vocabulary and gains no new authority from an insight.
- Persistent scouts snapshot one selected read-only MCP/sensor call and their creation-time behavior release. Poll, event, or hybrid wake policies converge on the same receipt-bound snapshot read; durable watermarks, generation coalescing, in-flight catch-up, freshness health, and optional expiry prevent webhook floods and missed-change fiction. Only runtime-computed snapshot changes become ambient evidence. Three consecutive failed observations stop future reads and create one held operator repair item; only an explicit operator resume clears that fail-safe. Preserved legacy scouts without a release are held until an operator explicitly binds an assigned release. A wake never sends directly or acquires write tools.
- Ambient unknown-unknown scanning classifies expiring windows, unusual coincidences, relevant people/events, cross-domain patterns, and business opportunities. Each accepted class has a deterministic evidence shape; unsupported deadlines and single-source multi-domain claims die before attention policy.
- `co today`, `co inbox`, `co matters`, `co mandates`, `co artifacts`, and `co why` give a daily-driver view over institutional work without replacing raw event/run administration.
- Direct run cancellation, stale-run inspection, recovery, and HTTP control. Cancellation denies pending approval and fences late model/tool commits while retaining state and history for inspection.
- OpenAI Responses, Anthropic Messages, OpenAI-compatible, and deterministic mock providers behind one interface.
- Optional Codex CLI and Claude Code CLI providers that reuse existing local login sessions without copying credential files.
- Durable SQLite sessions, messages, runs, events, jobs, approvals, tool receipts, artifacts, and memory.
- Versioned in-place schema migrations, consistent online backups, integrity diagnostics, and retained legacy-table recovery copies.
- Atomic inbound acceptance, per-session serialization, renewable run/job leases, lease-bound atomic effect claims, and an explicit `not_started → accepted → confirmed|failed|uncertain` lifecycle. A replacement lease may reclaim only a provably unstarted effect; accepted unknown outcomes require reconciliation. Durable member, scheduled, work-order, and retained-agent inputs carry distinct principal and instruction provenance, and malformed or forged scheduled jobs fail before a provider call.
- Connector delivery and native tapbacks are restart-tested at every persistence boundary from pre-intent through member-conversation projection; later authenticated delivery/read/failure callbacks reconcile current truth without rewriting the immutable acceptance history. The executable contract and expected recovery state are recorded in [the effect crash matrix](./docs/effect-crash-matrix.md).
- A bounded tool loop with risk-based approvals and resumable runs.
- Immediate child-agent admission with depth, concurrency, token, and iteration limits; delegation returns durable handles instead of waiting for every result.
- Retained, tenant-scoped agents with stable sessions, bounded mailboxes, follow-up steering, cancellation/retirement, and restart-safe lifecycle state.
- Persistent goals with explicit success contracts, deterministic completion gates, unchanged-input failure caching, deadlines, and bounded continuation budgets. A model-created goal is accepted only when it carries a runtime-verified verbatim quote from the current owner message; the owner can pause, resume, or permanently cancel it through the same conversation, with both the original commitment and revocation retained. Under a separately approved standards mandate, a release-pinned background generator and critic may maintain one private, falsifiable, low-confidence motive hypothesis from longitudinal owner evidence. It may include one separately falsifiable, lower-confidence substitution candidate when multi-week owner evidence supports the competing activity. An event goal can explicitly define `referenceWindowDays`; for a conversation-created goal, that duration must also be explicit in the quoted commitment. Co then computes prior above-target windows itself and may attach one only when dated owner context supports that it served the same tentative motive. The surfaced check contains only the member's own count and dates, never the private interpretation. Literal evidence cues may narrow when the quoted goal becomes relevant, and exact negative outcome feedback retires the whole hypothesis without erasing it. Separately, Co's own accepted promises have deadline-backed repair and operator-controlled completion/release.
- Cursor-based attach/resume snapshots and event streams for runtimes, retained agents, runs, and goals.
- Typed refinement proposals for prompt overlays, agent specifications, procedures, and memory policy. Models may propose; only operators may approve and apply.
- A redacted CLI/HTTP agent monitor with parent-child trees, model routes, token use, active tools, pending approvals, and bounded output/event previews. Hidden run state and tool payloads are not exposed.
- Descriptor-first plugins with deterministic discovery, explicit profile selection, namespaced MCP contributions, consent-bound sensor declarations, duplicate detection, path containment, and no code execution during inspection.
- A connector registry that keeps transport parsing, authentication, ingress normalization, delivery, and readiness out of the reasoning kernel. Sendblue and Linq are built-in rails; direct conversations on the same phone share one canonical iMessage session while the active delivery route remains replaceable.
- Reviewable onboarding with separate `plan`, `apply`, and `verify` phases. Profiles can carry portable model routes, plugin selections, and execution policy without credentials.
- Conversation-first member onboarding avoids intake questionnaires, learns only from tenant evidence, and requests a sensor only at the point of concrete value. The exact sensor descriptor then crosses the normal approval path; ordinary conversation grants nothing.
- Evidence-backed skill learning with proposed, approved, rejected, installed, revised, and retired states. Installation is explicit, tenant-scoped, versioned, and never expands authority.
- A process-execution contract with `none`, bounded shell-free local development, and hardened Docker backends. It is disabled by default and every enabled invocation is still destructive-risk approval work.
- Dynamic MCP discovery over stdio or Streamable HTTP, with local allowlists, timeouts, and risk classification. Remote safety hints are never trusted as authority.
- Recursive runtime validation of tool and MCP arguments, including nested requirements, enums, bounds, and collection limits.
- CLI, HTTP chat/event APIs, and bidirectional Sendblue and Linq adapters.
- Provider-neutral transactional email delivery with a Resend adapter, short-lived one-time verification, opaque verified-recipient identities, revocation, bounded abuse controls, idempotency, and external-write approval for agent-initiated sends.
- An AES-256-GCM browser credential broker whose opaque handles are bound cryptographically to tenant, workspace, credential ID, and exact origin. Values enter only through masked CLI prompts, piped JSON, or the authenticated HTTP operator API; the model sees field names and handles, and CDP filling rechecks origin, masks filled fields from screenshots, never submits, and crosses the ordinary external-write approval gate.
- Sendblue direct/group iMessage conversations, Linq private conversations, inline replies, location evidence, signed call-log ingestion, raw-body Linq signature/replay validation, and atomic webhook deduplication.
- Asynchronous memory extraction and URL/video enrichment so the foreground reply never waits for a long watch.
- Provider-neutral media analysis with a Gemini implementation: exact `yt-dlp` captions, native video watching, captionless transcription, document/image/audio analysis, bounded resource fetching, durable retries, and tenant-scoped artifact reuse. Articles are retained as bounded visible full text; GitHub repository overviews mean metadata plus README, never an uninspected source tree.
- DNS-pinned HTTP fetching with redirect revalidation and bounded content; external content and connector data are explicitly fenced as untrusted evidence.
- Anti-recency context assembly: stable identity is carried, dated excerpts are retrieved with temporal diversity, recent history remains episodic, and corrections supersede rather than erase.
- Rebuildable SQLite FTS history over conversations, imported logs, and ingested sources. Retrieval is local and adds no model round trip; untrusted sources are excluded from automatic context.
- Evidence-backed personal-model projections for thoughts, concepts, sources/source affinity, and latent theses. Sources aggregate by known author or publication domain while retaining artifact URL aliases. Sharing is neutral attention rather than endorsement; explicit revisits, endorsements, dismissals, rejections, and actions form a correctable source prior. `co personal-model rebuild` recreates these disposable views from retained evidence and lifecycle events without rewriting the ledger.
- Durable provider-neutral WorldScout commissions. A finding must bind every source claim to the exact successful external read receipt; strong coverage and source class must match a versioned adapter-emitted metadata envelope and SHA-256 content digest rather than model self-attestation. Findings use independently published fully inspected sources rather than snippets, meet a primary-source minimum, state their personal mapping, limits, counterevidence, and changed implication, and include evidence outside a learned positive source-affinity set. No web/search vendor is hardcoded; a selected MCP tool or explicitly tagged `world-research` read tool supplies retrieval.
- Durable bounded inquiries separate a source-triggered uncertainty from any member-facing decision. Each inquiry records its concrete benefit, competing hypotheses, falsifiers, answerability, retrieval plan, step bound, stop condition, expiry, finding, counterevidence, and remaining uncertainty. New inquiries are backstage by default and the inquiry manager has no connector dependency. A separate append-only foreground ledger rejects low-delta questions, requires private investigation first, requires a real conversational opening for opportunistic asks, and reserves interruption for material time loss; even an eligible ledger decision still cannot bypass relationship arbitration.
- An asynchronous perception engine that compares owner evidence across dates and separates hypothesis generation, counterevidence search, adversarial criticism, and relationship composition. Tentative hypotheses remain distinct from memory and only mature, specific insights can reach attention policy.
- Explicit insight feedback (`resonated`, `corrected`, `rejected`, `annoyed`, or `neutral`) over CLI and HTTP. Silence never counts as agreement, and rejected interpretations remain visible so they are not repeated.
- Frictionless product-outcome evidence from ordinary conversation. `outcome.feedback.record` binds explicit feedback to the preceding Co message and preserves later corrections. These metrics remain directional diagnostics: praise, first-wow timing, context ratings, and tenure trends cannot make `co product-qualify` pass. Release qualification additionally requires a preregistered representative live sample with two independent-human reviews per selected decision, adjudication of disagreements, and one-sided Wilson bounds. Silence and optional replies stay in the population; synthetic samples can test the evaluator but never qualify the product.
- A conservative `OutcomeLearner` derives current attention guidance from that append-only feedback and exact delivery provenance. For proactive interventions, an `obvious` or `annoying` outcome suppresses only the same tenant/topic—including work admitted or held before the feedback—while a later correction reverses the projection without erasure. For an explicitly mandated reality check, the same verified negative outcome retires only the exact private motive hypothesis that shaped its timing; it does not diagnose why the check failed or alter the member's stated goal. Positive outcomes are observable but cannot raise scores, confidence, authority, interruption budgets, or publish skills. Exceptionally urgent, evidenced operational changes retain a narrow recorded override.
- A proactive attention gate with an owner-evidence knownness veto, verified outcome guidance, novelty, evidence, urgency, usefulness, interruption cost, cooldown, quiet hours, and daily budgets. Cheap local checks run first. Only otherwise-eligible optional foreground observations, mature perceptions, operational media/ambient candidates, and reactivated holds that remain uncertain receive one bounded, no-tools semantic comparison against exact allowed evidence; explicit requests, tool-bearing runs, short acknowledgments, tapbacks, silence, local-known output, and weak operational candidates do not pay for it.
- Proactive delivery distinguishes definite rejection from ambiguous outcome: definite failures persist exponential backoff and stop after eight attempts as held work; ambiguous sends are never retried automatically.
- Every relationship send—requested reply, optional reply, approval, scheduled/accepted-burden repair, proactive intervention, native reaction, recovery result, and operator smoke—crosses one durable relationship admission boundary immediately before the existing exact-digest transport claim. It re-resolves the current canonical rail, serializes competing messages by explicit class, revalidates authority on delayed dispatch, preserves crash deduplication, and turns exhausted pre-transport wakeups into one owned repair item.
- Durable ambient-event evaluation jobs that remain off the reply path and only deliver when a caller supplies an authorized channel/peer target.
- An append-only import path for local JSONL/Markdown/text history. Source files are never changed.
- Behavior evals for sycophancy, confident guessing, memory provenance, intervention restraint, and action authority.
- Fail-closed production validation: explicit profile, strong service authentication, direct API providers, mounted credentials, TLS-only remote dependencies, bounded workspaces, and conservative standing authority.
- A hardened HTTP boundary with constant-time bearer verification, typed/size-bounded JSON, safe production errors, security headers, per-cell rate limiting, readiness/liveness probes, authenticated Prometheus metrics, request IDs, and structured secret-redacting logs.
- Production SQLite settings with transactional migrations, `FULL` synchronous durability, private database permissions, WAL checkpointing, online backup, immutable behavior-release canaries/rollback, and explicit single-host deployment limits.
- Integrity-checked portable tenant export and audit cover every tenant-scoped table dynamically plus the exact referenced behavior-release dependency closure. A v3 bundle restores transactionally only into an empty tenant, retaining source IDs and ordering while remapping SQLite-local event sequence numbers. Browser credential ciphertext is deliberately excluded and must be re-entered at the destination. Tenant deletion is local-operator-only, requires a current export plus exact confirmation, rejects intervening writes, leaves an anonymous lifecycle receipt, and never touches imported source files.
- A non-root, read-only Docker deployment with pinned/verified yt-dlp, persistent data, read-only secrets, graceful shutdown, health checks, least privileges, and CI verification.

## Quick start

The installed command is `co`. Inside this source checkout, `npm start -- <command>` invokes that same entry point without a global install.

```bash
npm install --ignore-scripts
npm run check

# Works without an API key through the deterministic mock provider
npm start -- chat

# Real model
export CO_PROVIDER=openai
export OPENAI_API_KEY=...
export CO_MODEL=gpt-5.6-terra
npm start -- chat

# Or Claude
export CO_PROVIDER=anthropic
export ANTHROPIC_API_KEY=...
export CO_MODEL=claude-sonnet-5
npm start -- chat
```

For normal daily use, keep one persistent process running and let every CLI chat attach to it:

```bash
# Terminal 1: gateway + background worker
npm start -- daemon

# Terminal 2: automatically attaches to http://127.0.0.1:8787
npm start -- chat

# See what Co has held, prepared, or kept in motion
npm start -- today
npm start -- inbox

# Hand off an outcome; waits by default and attaches to the daemon when available
npm start -- do "Prepare a release brief from the current repository" \
  --success "A source-backed local brief exists"

# External outcomes can require an external-write receipt
npm start -- do "Prepare the release brief" --require-tool artifact.prepare
```

Set `CO_DAEMON_URL` or pass `--daemon-url` for another loopback port. Pass `--local` for an intentionally process-local turn. While attached, Ctrl-C cancels the exact durable run rather than abandoning it. Inspect or reconcile work explicitly with `co runs --stale`, `co run show ID`, `co run cancel ID`, and `co run recover ID`.

`co do` is the action-oriented path. It waits for a terminal outcome by default; `--detach` returns the durable handle immediately. Use `co work-orders`, `co work-order show ID`, `co work-order cancel ID`, or `co attach work-order ID` to inspect and control it. Repeated `--tool NAME` flags narrow authority for that order; omitting them snapshots every currently registered tool except recursive `work.submit`. `--evidence tool` is the default and requires at least one `--require-tool NAME`; an answer without those exact successful outcome receipts is held as `needs_input`. Use repeated required tools and `--min-receipts N` when success depends on several actions. Required tools must already be inside the order's authority. Use `--evidence run` explicitly for bounded analysis where a completed model run is itself the deliverable. Work orders default to a 60,000 cumulative-token ceiling so multi-pass CLI providers can execute tools and acknowledge their results; `--tokens N` keeps the ceiling operator-controlled.

The office records are deliberately not another goal tracker. A mandate is an operator-approved standing service contract; a matter is a situation Co is helping with; a prepared artifact is work completed before it needs to interrupt; and the inbox holds useful context that did not justify a notification. `co why ID` traces any of those records back to its event evidence.

Interactive chat coalesces a multi-line terminal paste into one turn and immediately reports the received size before model work begins. For predictable document input, use `.paste` and finish with `.end`, or bypass terminal paste handling entirely:

```bash
# Best for a local text document
npm start -- chat --file ./document.txt "Summarize this and identify the decisions it changes"

# Best for clipboard or another command
pbpaste | npm start -- chat --stdin "Find the useful implications"
```

CLI and HTTP input share `CO_HTTP_BODY_LIMIT_BYTES` (2 MB by default). Oversized input is rejected before it creates a run; Co never silently truncates it. Large-document ingestion is still a bounded single model turn, not a substitute for a future chunked document workspace.

### Onboard another person

Create one profile per person. The profile is operational configuration—not a psychological portrait—and its tenant ID scopes every conversation, event, artifact, memory, job, and approval:

```bash
# Inspect every intended change; this does not create a profile or workspace.
npm start -- onboard plan alex \
  --member-peer +15551234567 \
  --timezone America/New_York \
  --workspace /path/to/alex/workspace \
  --provider openai \
  --out /tmp/alex-onboarding.json

# Apply exactly the reviewed profile, then verify resolution and deployment checks.
npm start -- onboard apply /tmp/alex-onboarding.json
npm start -- onboard verify --profile ~/.co/profiles/alex.json
npm start -- chat --profile ~/.co/profiles/alex.json

# Existing users can keep their current tenant and distribution explicitly:
npm start -- onboard existing --tenant default --distribution donna
```

Profiles never overwrite an existing profile. They contain no API keys; provider and connector secrets remain in environment variables or a deployment secret store. The operator-supplied `memberPeerIds` list is operational authority, not inferred identity: it is the set of canonical direct phone numbers allowed to act as the member through an iMessage connector. When a profile is selected, its member peers, tenant, distribution, timezone, location, workspace roots, distribution config, skill/plugin roots, plugin selection, and optional model/execution routes take precedence over ambient personal scoping defaults. A profile that omits member peers authorizes none; it never inherits `CO_MEMBER_PEERS` from another deployment. A profile that does not explicitly enable execution receives `none`, even if the host environment enables a backend. If no workspace is supplied, onboarding creates an empty profile-specific workspace rather than exposing the operator's current directory; the neutral timezone fallback is UTC and location remains unknown. An explicit CLI `--tenant` remains the administrative override. One runtime process serves exactly one selected tenant, and request bodies cannot switch it. For mutually untrusted hosted users, run separate gateway/container cells in addition to tenant-scoped storage.

This separation does not rename, migrate, or delete existing SQLite rows or local logs. An existing installation can keep using tenant `default` and select `donna`; a new profile can point at that tenant without copying its history. Imports remain explicit and append-only.

### Name migration

`Co`, the `co` CLI, `CO_*` configuration, `~/.co`, and the `co` distribution ID became canonical in v0.6 and remain so. Existing installations are preserved: the former environment prefix is accepted as a fallback, the former neutral distribution ID resolves to `co`, and Co automatically uses the former home when it contains the existing database and no `CO_HOME` is set. A `CO_*` value always wins when both names are present. Co does not rename, copy, delete, or reset the old database; operators may keep it in place or move it explicitly and set `CO_HOME`.

The neutral behavior contract and reusable procedures live in `distributions/co.json` and `skills/common/`. A persona is optional. To add one without changing runtime code, provide a distribution JSON and select it during onboarding:

```json
{
  "id": "editor",
  "displayName": "Editor",
  "systemPromptPrefix": "You are an exacting editor. Do not assume who the user is.",
  "foregroundToolNames": ["clock.now", "history.search", "memory.recall"],
  "backgroundToolNames": ["clock.now", "history.search", "memory.recall"]
}
```

```bash
npm start -- onboard writer --distribution editor --distribution-config ./editor.json
npm start -- chat --profile ~/.co/profiles/writer.json
```

`systemPromptPrefix` inherits the runtime's neutral judgment, tact, authority, and provenance contract. Use `systemPrompt` instead when a distribution needs a complete replacement. Profile-specific procedures can be listed as `skillRoots`; default skill discovery only visits `common` and the selected distribution, so one persona's skills cannot leak into another merely because they share a parent directory.

Each workload can be routed independently with `CO_FOREGROUND_*`, `CO_DELIBERATION_*`, `CO_BACKGROUND_*`, and `CO_CRITIC_*` variables, including `PROVIDER`, `MODEL`, `MAX_OUTPUT_TOKENS`, and `REASONING`. API routes may also set the complete trio `INPUT_USD_PER_MILLION_TOKENS`, `OUTPUT_USD_PER_MILLION_TOKENS`, and `MAX_REQUEST_USD`. Co never guesses changing vendor prices: all three are operator-supplied and release-pinned. Before every foreground or background provider call, the registry computes a conservative upper bound from the complete serialized request, a provider-framing allowance, and the configured maximum output; an over-budget request is rejected before the adapter runs. Missing or envelope-breaking usage rejects the response afterward. The reported dollar value is an estimate, not an invoice. Subscription-backed Codex and Claude Code CLI routes keep their token budgets and reject dollar ceilings they cannot honestly enforce. Current defaults are GPT-5.6 Terra/Sol/Luna or Claude Sonnet 5/Opus 5/Haiku 4.5; pin or override them based on your own behavior, latency, and cost evals.

### Reuse Codex or Claude Code login

For local personal use, select either authenticated CLI explicitly:

```bash
codex login status
export CO_PROVIDER=codex-cli
export CO_MODEL=default
npm start -- chat

# Or:
claude auth status
export CO_PROVIDER=claude-code-cli
export CO_MODEL=sonnet
npm start -- chat
```

Roles can be mixed—for example, `CO_FOREGROUND_PROVIDER=claude-code-cli` and `CO_DELIBERATION_PROVIDER=codex-cli`. Each call is ephemeral. The runtime gives the subprocess a secret-minimized environment, disables native shell/web/MCP/skill tools, and requires structured tool requests so actions still pass through Co approvals and receipts. It invokes the CLIs normally; it never parses `~/.codex/auth.json`, the Claude credential store, or browser cookies.

CLI-backed providers are slower and carry the CLIs' own system-prompt overhead. `MAX_OUTPUT_TOKENS` is a requested ceiling rather than a hard CLI control. Use direct API providers for hosted or multi-tenant production, and do not expose a personal authenticated CLI through a public daemon.

Start the complete local daemon (gateway, worker, schedules, interventions, and delivery):

```bash
npm start -- daemon --port 8787
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/v1/chat \
  -H 'content-type: application/json' \
  -d '{"message":"Look at what I am trying to do and take the next useful step."}'
```

For a multi-process deployment, run the gateway and worker separately:

```bash
npm start -- serve
npm start -- worker
```

## Composition and operations

Inspect the cell without exposing stored prompts or tool payloads:

```bash
npm start -- status --profile ~/.co/profiles/alex.json
npm start -- plugins --profile ~/.co/profiles/alex.json
npm start -- agents --profile ~/.co/profiles/alex.json
npm start -- skills proposals --profile ~/.co/profiles/alex.json
```

Authenticated HTTP equivalents include `GET /v1/capabilities`, `/v1/plugins`, `/v1/connectors`, `/v1/execution`, `/v1/agents`, `/v1/personal-model`, `/v1/source-affinity`, and `/v1/skill-proposals`. `POST /v1/skill-proposals/:id` accepts an explicit `approve`, `reject`, `install`, or `retire` action.

### Plugins

An operator installs a plugin directory beneath `~/.co/plugins` (or another explicit `--plugin-root`) and selects it in onboarding with `--plugin <id>`. Discovery reads only `plugin.json`; it does not import or execute plugin code. The v1 manifest can contribute contained skill roots and MCP descriptors:

```json
{
  "schemaVersion": 1,
  "id": "calendar",
  "version": "1.0.0",
  "displayName": "Calendar",
  "contributes": {
    "skillRoots": ["skills"],
    "mcpServers": [
      {
        "name": "calendar",
        "transport": "stdio",
        "command": "calendar-mcp",
        "allowedTools": ["events.list", "events.create"],
        "toolRisks": { "events.list": "read", "events.create": "external-write" }
      }
    ],
    "sensors": [
      {
        "id": "upcoming-events",
        "displayName": "Upcoming calendar events",
        "kind": "calendar",
        "purpose": "Notice schedule changes and time-sensitive windows.",
        "dataClasses": ["calendar.events", "calendar.attendees"],
        "retentionDays": 30,
        "server": "calendar",
        "tool": "events.list"
      }
    ]
  }
}
```

Plugin IDs and MCP names are namespaced, contribution paths must remain inside the package, and a missing, malformed, or duplicate selected plugin fails closed. A sensor may be `calendar`, `email`, `call`, `file`, `browser`, or `location`; it must map to an explicitly allowlisted MCP tool whose risk is locally pinned to `read`, and it must declare its purpose, data classes, and retention window. Plugin packages are still trusted operator-installed content; manifests make inspection and selection explicit, not hostile code safe.

Sensor tools are wrapped below the model and cannot execute before descriptor-bound consent. Review and control them with `co senses`, `co sense show ID`, `co sense grant ID`, and `co sense revoke ID`, or authenticated `GET /v1/sensors`, `GET /v1/sensors/:id`, and `POST /v1/sensors/:id/actions`. A conversational grant uses `sensor.list` followed by `sensor.consent.grant`; because permission changes are external-write risk, the exact sensor ID and descriptor hash appear in the normal approval round trip before access changes. If a plugin changes its purpose, data classes, retention, server, or tool, the old grant becomes `stale` and reads stop until it is reviewed again. Consent enables only that read tool—it does not create a scout or grant any write authority. Raw sensor arguments, results, and provider error bodies live only in the receipt until the disclosed retention window expires; tool ledger events contain digests, and the hourly retention sweep replaces expired successful or failed receipt data with its digest-bearing tombstone. A member-visible response or deliberately recorded finding derived from a sensor remains part of the relationship record and is governed by tenant export/deletion, not silently erased with the raw connector response.

### Governed skill learning

The agent may call `skill.propose` only to record a candidate procedure and its source/evidence event IDs. It cannot approve or install that proposal. An operator performs the lifecycle explicitly:

```bash
npm start -- skills proposals --profile ~/.co/profiles/alex.json
npm start -- skills approve skp_... --profile ~/.co/profiles/alex.json
npm start -- skills install skp_... --profile ~/.co/profiles/alex.json
npm start -- skills retire skp_... --profile ~/.co/profiles/alex.json
```

Each revision is a new immutable version under the tenant/profile learned-skill root. The old file, proposal, evidence, and ledger events remain. Skills are instructions only: tool risk, standing approvals, secrets, connector permissions, and workspace scope remain controlled by the runtime.

### Retained collaboration and long-running goals

Delegation is asynchronous. A model call to `delegate_task` transactionally creates retained agents, objective messages, and queued jobs, then returns stable agent/message/job handles immediately. The configured child concurrency limit controls execution admission; it does not silently discard the rest of a requested batch.

Retained agents keep the same session across follow-ups and remain inspectable after completion, failure, cancellation, or retirement:

```bash
npm start -- agents
npm start -- agent show agt_...
npm start -- agent messages agt_... --after 0
npm start -- agent follow-up agt_... "Verify the remaining uncertainty"
npm start -- attach agent agt_... --after 0
```

Goals separate an agent's completion claim from a durable success contract. Gates can require explicit operator confirmation, a matching event count, a durable artifact, or a completed run. Failed checks against unchanged evidence are cached; changed evidence may queue a bounded follow-up to the assigned retained agent.

```bash
npm start -- goals
npm start -- goal show goal_...
npm start -- goal check goal_...
npm start -- goal confirm goal_... "Acceptance criteria verified"
npm start -- attach goal goal_... --after 0
```

HTTP clients have corresponding `/v1/agents`, `/v1/goals`, `/v1/refinements`, and `/v1/attach` control-plane surfaces. SSE clients can resume from `Last-Event-ID`; CLI attach returns the same bounded snapshot plus durable events after the supplied cursor.

### Governed harness refinement

The model may propose a typed refinement with source evidence, rationale, expected effect, scope, and baseline version. It cannot approve or apply one. Operators use an explicit lifecycle:

```bash
npm start -- refinements proposals
npm start -- refinements approve rfp_...
npm start -- refinements apply rfp_...
npm start -- refinements overlays
npm start -- refinements rollback rfp_...
```

Applying a stale proposal fails on a version conflict. Applying a prompt overlay creates a new immutable version; supersession, retirement, and rollback retain all earlier proposals and overlays. Refinement patches cannot carry tool authority, standing approvals, secrets, connector permissions, or workspace scope. Other proposal kinds remain inert until a separately governed consumer exists.

### Execution backends

Execution is absent from the model's tool set until selected. For local development, onboard a shell-free command allowlist:

```bash
npm start -- onboard plan builder \
  --provider openai \
  --execution-backend local \
  --allow-command node \
  --allow-command npm \
  --execution-workspace-mode read-write \
  --out /tmp/builder.json
```

Production rejects `local`; use `docker` with a digest-pinned image. The backend applies no network, a read-only container root, dropped capabilities, `no-new-privileges`, PID/CPU/memory/output/time limits, an unprivileged UID/GID, disabled daemon logging, and a mount of only the workspace selected for that call. `read-only` is the default workspace mode. Each container is named and labeled; timeout or output overflow triggers forced removal and verified cleanup. If cleanup cannot be confirmed, the non-idempotent tool receipt fails explicitly rather than claiming containment succeeded. The host must provide a trusted Docker CLI/daemon boundary; the bundled Compose cell intentionally does not mount a privileged Docker socket. For deployments without such a boundary, keep execution at `none` and use approved MCP services for remote work.

## Shared media and source understanding

Install the caption/metadata extractor:

```bash
brew install yt-dlp
```

Caption extraction and ordinary article/text ingestion work without another media API. To enable native video, document, image, and audio understanding, configure Gemini:

```bash
export GEMINI_API_KEY=...
export CO_MEDIA_ANALYZER=auto       # default: use Gemini when a key exists
export CO_FOREGROUND_MEDIA=gemini # default: images/audio read before first reply
export CO_GEMINI_MODEL=gemini-3.5-flash-lite
```

Flash-Lite is the default perception model. Background analysis can escalate to Gemini 3.6 Flash, then the compatibility fallback. Foreground image/audio analysis stays on the explicitly selected model, with no silent model fallback. Final judgment and phrasing still use the independently configured conversational routes.

Image and audio attachments use Gemini before the first reply, retaining originals and model/version-bound evidence across restarts. The conversational provider receives attributed, untrusted notes/transcripts, not native media or new owner authority. Missing credentials, unsupported content and failed analysis are explicit. This currently supports PNG/JPEG/WebP and recognized audio containers, with four attachments per context, 3 MB per image and 10 MB per audio file. Fetching and analysis are deadline-bound; notes are bounded and may be incomplete. HEIC/HEIF and real-channel codec qualification remain open. Set `CO_FOREGROUND_MEDIA=native` to keep the prior API-native image route; that mode does not transcribe audio. Dollar-capped or responsibility-budgeted Gemini perception fails closed until media-cost reservation is qualified. This is implemented and fixture-tested, not activated on the live rail.

Live, unbudgeted foreground turns also enqueue idempotent `content.enrich` jobs for shared public HTTP(S) URLs; shadow mode does not. Native Sendblue and Linq attachments are normalized into a bounded typed manifest and bound to the signed-ingress authorization. The exact transport URL is retained below the conversational model for fetch and provenance; signed query credentials do not enter its prompt. Attached images/audio wait for bounded foreground perception; URL enrichment remains asynchronous. Short YouTube videos retain the exact transcript and add a native multimodal watch. Videos over `CO_YOUTUBE_DEFER_SECONDS` (12 minutes by default) prefer the complete caption transcript; captionless videos are transcribed in bounded 15-minute windows. Oversized native watches progressively reduce frame sampling, then use bounded 20-minute windows. `CO_YOUTUBE_MAX_WINDOWS` limits worst-case model work.

The resource path distinguishes visible article full text, bounded text/conversation transcripts, direct audio, images, documents, repositories, unsupported binary metadata, and YouTube. Coverage is stored explicitly as `metadata`, `watch-page-text`, `fulltext`, `transcript`, `multimodal`, `transcript+multimodal`, `document`, or `repository-overview`. `watch-page-text` means that only the visible YouTube page was read—the video was neither watched nor transcribed. `repository-overview` currently means GitHub metadata plus README; it does not claim source-tree inspection. Binary downloads are DNS-pinned, redirect-revalidated, and bounded by `CO_MEDIA_MAX_RESOURCE_BYTES` (15 MB by default). Unsupported or unanalyzable binaries remain metadata-only instead of being decoded into garbage or described as understood.

Completed artifacts are cached by tenant and source URL in SQLite. Re-sharing reuses expensive analysis while still reevaluating usefulness against the new message. A materially changed reprocessing result receives a new immutable artifact-version row and enrichment event while the artifact row remains the latest projection; migration preserves the exact pre-versioning projection as its first historical version. The model can request `content.ingest_url` with `refresh: true` when the source genuinely needs reprocessing. Raw source text and analyzer notes are stored as untrusted, source-linked evidence and are never executed as instructions.

The local reference store preserves exact submitted text, the raw authenticated connector payload, typed attachment manifest, source URL, and the first successfully fetched bounded attachment body. Attachment bodies are SHA-256 content-addressed and deduplicated while retaining distinct source-event/attachment provenance. They participate in the same tenant export, restore, confirmed deletion, and SQLite backup boundary as the ledger. `GET /v1/originals` returns authenticated metadata with capability query strings removed; `GET /v1/originals/:id/content` returns the exact authenticated bytes. A URL that expires before the asynchronous first fetch is still an honest inaccessible-source failure, not a fabricated backup. The future multi-host topology needs an object-store adapter rather than carrying base64 bodies in transactional SQL. The exercised modality and provider-coverage matrix is recorded in [the Phase 1 deposit foundation note](./docs/phase-1-deposit-foundation-2026-09-05.md).

Import old logs without modifying them:

```bash
npm start -- import /path/to/local/logs --profile ~/.co/profiles/alex.json
npm start -- history reindex --profile ~/.co/profiles/alex.json
npm start -- history search "action bias" --limit 12 --profile ~/.co/profiles/alex.json
```

New turns and imports are indexed transactionally. `history reindex` is the one-time upgrade/backfill for events and artifacts already in the database; it retains every provenance-bearing evidence row and rebuilds only the disposable full-text index, adding missing baseline evidence without replacing richer research, scout, perception, or correction records. Original messages, events, artifacts, import receipts, and source files are untouched. When JSONL contains a valid `timestamp`, `created_at`, `createdAt`, or `date`, that original observation time is retained instead of the import time.

Inspect the perception projection and give direct feedback without touching its source history:

```bash
npm start -- insights --profile ~/.co/profiles/alex.json
npm start -- insight show phy_... --profile ~/.co/profiles/alex.json
npm start -- insight feedback phy_... corrected "The collaborators were the actual difference" --profile ~/.co/profiles/alex.json
npm start -- product-metrics --profile ~/.co/profiles/alex.json
npm start -- product-qualify --quality-plan quality_plan_... --profile ~/.co/profiles/alex.json
npm start -- personal-model show --profile ~/.co/profiles/alex.json
npm start -- personal-model rebuild --profile ~/.co/profiles/alex.json
```

HTTP clients use `GET /v1/insights`, `GET /v1/insights/:id`, `POST /v1/insights/:id/feedback`, `GET /v1/product-metrics`, and `GET /v1/product-qualification?qualityPlanId=...`. The qualification endpoint recomputes canonical operational consistency and exact rolling-24-hour attention limits, but fails unless the supplied same-tenant independent-review plan has qualified. Conversational outcome ratios remain diagnostics rather than release proof. See [the product-quality qualification contract](./docs/product-quality-qualification.md). Perception synthesis is a durable background job queued after a foreground turn or enriched content/ambient event; foreground chat does not wait for it. Personal-model rebuild deletes and recreates only its tenant-scoped derived node, edge, alias, and affinity tables inside one transaction; malformed canonical input rolls the transaction back. See [the v0.10 perception note](./docs/perception-engine-v0.10-2026-08-25.md).

Inspect outside research and its complete provenance with:

```bash
npm start -- research list --profile ~/.co/profiles/alex.json
npm start -- research show rco_... --profile ~/.co/profiles/alex.json
```

HTTP equivalents are `GET /v1/research` and `GET /v1/research/:id`. `research.commission` only admits work when its current authority includes a read-only external web/search/browser tool. Each commission snapshots those tools, runs off the foreground path, and cannot complete until `research.source.record` and `research.finding.record` satisfy its evidence contract. A retrieval integration that wants to support `fulltext`, `multimodal`, `repository`, or `document` evidence must return `_coResearchEvidence` version 1 beside the exact `content`, including canonical URL, title, publisher, source class, coverage, `complete: true`, and `contentSha256`; the runtime verifies every field and digest. Snippet/metadata sources can be retained for discovery but cannot prove a finding. The local suite proves the orchestration and rejection paths with a simulated conforming external reader; a real selected MCP research tool and live model remain deployment smoke gates.

Inspect private inquiry work without turning it into a notification surface:

```bash
npm start -- inquiries --status investigating --profile ~/.co/profiles/alex.json
npm start -- inquiry show inq_... --profile ~/.co/profiles/alex.json
```

HTTP equivalents are `GET /v1/inquiries` and `GET /v1/inquiries/:id`. The detail response includes the separate foreground-decision ledger. These are authenticated operator/accountability surfaces; they do not send, approve, or promote an inquiry.

Inspect the backstage follow-through and persistent watches with:

```bash
npm start -- consequences list --profile ~/.co/profiles/alex.json
npm start -- consequences show csp_... --profile ~/.co/profiles/alex.json
npm start -- scouts list --profile ~/.co/profiles/alex.json
npm start -- scouts show sct_... --profile ~/.co/profiles/alex.json
npm start -- scouts pause sct_... --profile ~/.co/profiles/alex.json
npm start -- scouts resume sct_... --profile ~/.co/profiles/alex.json
npm start -- scouts retire sct_... --profile ~/.co/profiles/alex.json
```

HTTP equivalents are `GET /v1/consequences`, `GET /v1/consequences/:id`, `GET /v1/scouts`, `GET /v1/scouts/:id`, `POST /v1/scouts/:id/actions`, and authenticated `POST /v1/scouts/:id/wakes`. A source wake requires a provider-stable `externalId`, optional opaque cursor, event type, and optional payload. Only the payload digest is retained. Reuse with changed content fails closed. It records and coalesces a hint; it does not run inference or treat webhook payload as an observation. The worker subsequently performs the scout's authoritative receipt-bound read, including one catch-up read if another event landed in flight.

The model-facing `scout.create` tool accepts only a currently authorized read-risk MCP tool or an operator-tagged `scout-source`; exact validated arguments, wake/freshness/expiry policy, and the creating run's immutable behavior release are snapshotted. A scout work order can execute only that read plus `scout.observation.record`. Unchanged reads stay silent, and a truncated or widened read cannot become an observation. Expiry silently stops admission while preserving history. Three consecutive `failed` or `needs_input` runs atomically move the scout to `repair_required`, append a failure event, and create exactly one held operator repair item; no more ticks are admitted. Resume through the authenticated operator API or CLI acknowledges the repair, resolves that held item, resets the bounded failure window, and preserves every prior run and event. The model tool cannot bypass that acknowledgment. These paths are proven with simulated sensors; calendar/email/browser MCP deployments still need selection, consent, provider webhook adapters, and live smoke tests.

An operator can encode narrow standing action authority in a mandate without globally auto-approving a risk class. Legacy descriptive authority objects remain inert. The executable form is:

```json
{
  "version": 1,
  "rules": [
    {
      "toolName": "email.send_verified",
      "argumentEquals": { "identityId": "vid_..." },
      "maxUses": 5,
      "expiresAt": "2026-10-01T00:00:00.000Z"
    }
  ]
}
```

Rules require an exact tool, at least one recursively matched argument, and a bounded use count. Arrays match exactly. Unknown fields, unsafe object keys, overly deep or large constraints, invalid expiry, and broad risk labels fail closed. A matching call writes a tenant/run/call-bound use record containing an arguments hash—not the arguments—then proceeds through the normal semantic receipt boundary. Exhaustion, mismatch, expiry, pause, retirement, tenant mismatch, or malformed stored policy restores per-call approval.

Browser credentials are provisioned by the operator and are never accepted as model tool arguments:

```bash
export CO_BROWSER_CREDENTIAL_KEY_FILE=/run/secrets/co_browser_credential_key
export CO_BROWSER_WORKSPACE_ID=member-cell
export CO_BROWSER_CDP_URL=http://127.0.0.1:9222

# Interactive values are masked. Repeat --field for every value.
npm start -- credential add --origin https://accounts.example.com \
  --label "Accounts login" --field username --field password
npm start -- credentials
npm start -- credential retire cred_...

# Automation may pipe a bounded JSON object; secrets never belong in argv.
secret-command | npm start -- credential add --origin https://accounts.example.com \
  --label "Accounts login" --stdin
```

The authenticated operator API exposes `POST /v1/credentials`, `GET /v1/credentials`, `GET /v1/credentials/:id`, and `POST /v1/credentials/:id/actions` (`{"action":"retire"}`). It never exposes ciphertext or values. `browser.credential.fill` takes only a handle, an existing page target ID, and selectors for known field names. It checks the page's exact origin twice, injects values below the model over CDP, installs screenshot masking, and returns only a receipt. It deliberately does not click submit. The page necessarily receives the values in order to authenticate; the security claim is that they do not pass through model context, tool receipts, screenshots, events, or management responses. A live CDP smoke test remains a deployment gate.

Check and back up the durable state without connecting model or MCP providers:

```bash
npm start -- doctor
npm start -- backup
# Or choose an explicit destination:
npm start -- backup ./backups/runtime.sqlite
```

## Verified email

Co can collect a contact address, prove that the person controls it, and later email only that verified identity. The delivery interface is provider-neutral; v0.9 ships a Resend adapter. Configure it with a provider key, a sender on a verified domain, and a separate random OTP secret:

```bash
export CO_EMAIL_PROVIDER=resend
export RESEND_API_KEY=...
export CO_EMAIL_FROM='Co <verify@example.com>'
export CO_EMAIL_OTP_SECRET="$(openssl rand -hex 32)"
```

Requesting through the CLI is itself explicit authorization to send the code, so it does not ask for a second approval. Verification reads the code from a masked terminal prompt instead of accepting it as a command-line argument:

```bash
npm start -- email request owner@example.com --purpose onboarding
npm start -- email verify evc_...   # enter the six digits at the prompt
npm start -- emails                # opaque IDs and masked addresses only
npm start -- email revoke email_...
```

The authenticated HTTP lifecycle is `POST /v1/email-verifications`, `GET /v1/email-verifications/:id`, `POST /v1/email-verifications/:id/actions` with `{"action":"verify","code":"......"}`, `GET /v1/email-identities`, and `POST /v1/email-identities/:id/actions` with `{"action":"revoke"}`. Supply a stable `Idempotency-Key` on request creation. A UI calling this API may treat submission of the address as the person's send instruction; no model needs to handle the code.

Conversation tools are stricter. `email.verification.request` and `email.send_verified` remain `external-write`, so a model-initiated message pauses at the ordinary approval boundary unless the deployment has separately granted standing authority. The model can list only opaque IDs and masked addresses, and it never receives a generated verification code. Codes are generated cryptographically, stored only as an HMAC digest, expire, lock after bounded guesses, and are subject to cooldown plus hourly/daily per-address limits. Provider retries use stable idempotency keys; uncertain delivery is recorded and not blindly repeated.

This proves control of a contact address for the configured tenant. It does not create a login session, replace application authentication, or authorize unrelated actions. The normalized address is retained in the tenant's local SQLite challenge/identity records because it is the delivery destination; email-specific lifecycle events and public identity projections use a mask and hash. If an address arrived through chat or an agent tool, the ordinary message, approval, and receipt history also retains what the user/model supplied. Revocation preserves history. See [the v0.9 implementation note](./docs/email-verification-v0.9-2026-08-24.md).

## Sendblue

Set:

```bash
export SENDBLUE_API_KEY_ID=...
export SENDBLUE_API_SECRET_KEY=...
export SENDBLUE_FROM_NUMBER=+1...
export SENDBLUE_WEBHOOK_SECRET=...
export CO_MEMBER_PEERS=+15551234567
```

Point the Sendblue receive webhook to `POST /webhooks/sendblue`. The adapter validates `sb-signing-secret`, but that signature authenticates Sendblue—not the human sender. Before retaining raw content, routes, evidence, or jobs, the runtime requires a direct canonical sender in the selected profile's `memberPeerIds` (or `CO_MEMBER_PEERS` only when no profile is selected). Unknown senders, groups, and unbound call transcripts receive a deduplicated 202 and leave only a redacted security event. Authorized messages are deduplicated on `message_handle`, durably queued, and then answered through Sendblue.

Approval requests arriving through iMessage include an explicit `approve apr_…` / `deny apr_…` reply command. The worker verifies that the approval belongs to that canonical relationship before resuming it.

## Linq

Set:

```bash
export LINQ_API_KEY=...
export LINQ_FROM_NUMBER=+1...
export LINQ_WEBHOOK_SECRET=whsec_...
export CO_MEMBER_PEERS=+15551234567
```

Point the Linq webhook to `POST /webhooks/linq`. Verification uses the exact raw request bytes and rejects signatures outside a five-minute replay window. Human-authored events must also resolve to an explicitly configured direct member before Linq's raw payload or route can enter tenant state. The adapter learns Linq's chat ID durably from authorized inbound or successful outbound traffic, replies into the known chat, and refuses to treat a group chat as a private member route. Sendblue and Linq remain separate delivery providers, but a direct conversation with the same phone number uses one `imessage` relationship session, so changing rails does not fork memory or conversational history.

Inspect connector readiness with `npm start -- connector status`. A deliberate live outbound smoke is available only as an explicit operator command:

```bash
npm start -- connector smoke linq --peer +15551234567 \
  --message "Co connector smoke" --idempotency-key release-27-linq --confirm-send
```

The idempotency key, delivery intent, provider response, and accepted-or-uncertain receipt use the same durable path as ordinary messages. Reusing the same key does not submit a second accepted message. A provider 2xx is recorded as `message.delivery_accepted`, not falsely as handset delivery; delivered/read status comes from a signed provider webhook. The full rail gate requires both halves through the deployed endpoint.

After a real member message has traversed a production deployment, verify the complete causal chain without sending or rewriting anything:

```bash
npm start -- connector qualify linq --run run_... \
  --since 2026-09-04T12:00:00Z --release release_... --require delivered
```

The fail-closed report requires current bidirectional rail readiness, production mode, a post-deployment authenticated member ingress, the exact non-mock release-pinned run, an exact-digest provider acceptance replying to that inbound message, and an authenticated delivered/read callback. It redacts message content and external identifiers. The command and synthetic adversarial tests exist; no live round-trip report was produced in this implementation pass. See [the connector qualification contract](./docs/connector-round-trip-qualification.md).

Calendar, calls, activity, and location feeds can push provenance-bearing ambient events to `POST /v1/events`. Include a stable `externalId` for atomic deduplication. Include `channel` and `peerId` only when that connector is authorized to propose an outbound intervention; otherwise the evidence is retained without a delivery target. A calendar or other service that exposes tools can also be connected through MCP. The current location is only what an authorized connector or `CO_LOCATION` supplies; the runtime never guesses it.

## MCP tools

Set `CO_MCP_CONFIG` to a JSON file (or put the same array in `CO_MCP_SERVERS`):

```json
[
  {
    "name": "calendar",
    "transport": "stdio",
    "command": "calendar-mcp",
    "args": ["--stdio"],
    "allowedTools": ["events.list", "events.create"],
    "toolRisks": {
      "events.list": "read",
      "events.create": "external-write"
    },
    "timeoutMs": 30000
  },
  {
    "name": "remote",
    "transport": "http",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
  }
]
```

Unclassified MCP tools default to `external-write`, so they pause for approval. Check discovery with `npm start -- mcp`.

The daemon refuses a non-loopback bind unless `CO_SERVER_TOKEN` is set. In `CO_ENV=production`, startup additionally requires a selected profile, a service token of at least 32 bytes, explicit credentialed API providers, HTTPS remote dependencies, bounded existing workspace roots, and conservative standing authority. A configured browser CDP boundary also requires an unambiguous 32-byte credential key and rejects non-loopback plaintext discovery or discovery URLs containing embedded credentials, query strings, or fragments. Run `npm start -- config check --profile ...` before deployment. A runtime process is scoped to one configured tenant; request bodies cannot switch tenants. See [.env.example](./.env.example) for the main controls.

## Data location

The default database for a new installation is `~/.co/runtime.sqlite`. Override it with `CO_HOME` or `CO_DB`. The name-migration fallback above keeps an existing database discoverable without moving it. Raw imported logs remain where they are. Imports use stable file identity plus record position, so appends and local moves do not duplicate prior history. Every derived memory retains source provenance and can be corrected or retired without deleting history. Search evidence is another rebuildable projection with a source event ID, observation time, and trust class (`owner`, `agent`, or `untrusted`). Migrations are additive; the one legacy import-table rewrite retains `imports_v1_backup` as a recovery copy.

```bash
npm start -- tenant audit --profile ~/.co/profiles/alex.json
npm start -- tenant export ~/.co/exports/alex.json --profile ~/.co/profiles/alex.json
# Restore requires an empty destination tenant/profile and its exact confirmation:
npm start -- tenant restore --export ~/.co/exports/alex.json --confirm RESTORE:alex --profile ~/.co/profiles/alex-new-cell.json
# Destructive by design; refuses a stale or different-tenant export:
npm start -- tenant delete --export ~/.co/exports/alex.json --confirm DELETE:alex --profile ~/.co/profiles/alex.json
```

Portable v3 exports contain original messages, events, imported records, receipts, corrections, outcomes, agents, budgets, connector routes, projections, and only the global release manifests/rollouts referenced by that tenant. Restore is local-only, refuses merge or overwrite, installs nonconflicting release dependencies transactionally, remaps database-local event sequence numbers without changing event identity or time, rebuilds FTS, and reports credential handles that need re-entry. Exports exclude encrypted browser credential bytes; handles and metadata remain so the destination can ask for re-entry. Export does not modify the database evidence or any referenced source log. Deletion is the only intentional exception to ordinary non-erasure and is unavailable as a model tool or HTTP mutation.

Behavior changes are released as complete manifests so prompt, models, exact skill versions, and policy cannot drift independently:

```bash
npm start -- release template --profile ~/.co/profiles/alex.json
npm start -- release stage --file candidate.json --profile ~/.co/profiles/alex.json
npm start -- release canary RELEASE_ID --basis-points 500 --profile ~/.co/profiles/alex.json
npm start -- release status --profile ~/.co/profiles/alex.json
npm start -- release promote RELEASE_ID --profile ~/.co/profiles/alex.json
npm start -- release rollback --profile ~/.co/profiles/alex.json
```

Canary assignment is deterministic per tenant and rollout. Every run exposes its release ID, digest, rollout, and stable/canary cohort. Durable background jobs pin a release before execution, and work derived from a run inherits that run's release. Promotion and rollback therefore apply only to newly admitted work; existing foreground and background chains resume against their pinned prompt, routes, skill set, and effective policy. Release manifests are integrity checked, unavailable skill revisions fail before model work, and a manifest's auto-approval list is always intersected with the deployment configuration, which remains the authority ceiling. `GET /v1/releases` exposes authenticated rollout status and component digests without returning the prompt body.

Private longitudinal evaluation requires a dated corpus, case manifest, explicit private-model-upload acknowledgement, and a fifth response set captured from the strongest relevant external harness. A source JSON/JSONL transcript can be normalized into a new mode-`0600` corpus without modifying or overwriting its source; naive timestamps require an explicit UTC offset. Both the full-context candidate and its context ablation execute through isolated temporary Co runtimes with the same release, provider, tools, and receipt path; only the pre-checkpoint personal history is withheld from the ablation. This separates context contribution from execution capability instead of comparing Co with a tool-less prompt. `useful-action` cases must name required tools and cannot pass unless those exact outcome receipts are confirmed. The external capture command invokes a pinned runner without a shell and binds its executable, fixed arguments, configuration, exact case input, response, and receipts into baseline schema v2. Action-proof requirements apply equally to every compared system, so an external or logged response cannot win by merely claiming completion. Default reports retain response and judge-rationale hashes but redact their text because a judge can quote private history:

```bash
npm start -- eval corpus prepare --source raw-private.json --out private.jsonl --naive-offset -07:00
npm start -- eval replay packet --corpus private.jsonl --manifest cases.json \
  --out external-packet.json --allow-private-export
npm start -- eval replay openclaw-config \
  --out pinned-openclaw-runner.json --command /absolute/path/to/node \
  --command-arg /absolute/path/to/openclaw/openclaw.mjs \
  --launcher-cwd /absolute/path/to/openclaw --repo /absolute/path/to/openclaw \
  --openclaw-config /private/openclaw-eval.json \
  --openclaw-state /private/empty-openclaw-state \
  --agent-cwd /private/empty-openclaw-workspace \
  --model openai/gpt-5.6-sol --thinking high \
  --runtime-evidence /absolute/path/to/openclaw/node_modules/@openai
npm start -- eval replay capture --corpus private.jsonl --manifest cases.json \
  --out openclaw-results.json --runner /absolute/path/to/node \
  --runner-arg /absolute/path/to/agent-runtime/src/openclaw-replay-runner.ts \
  --runner-config pinned-openclaw-runner.json --harness OpenClaw \
  --harness-version pinned-full-commit --allow-private-model-upload
npm start -- eval replay --corpus private.jsonl --manifest cases.json \
  --external-baseline openclaw-results.json --allow-private-model-upload
```

The OpenClaw pin refuses a dirty checkout and binds its commit, executable, invoked source, generated runtime, dependency metadata, selected provider-runtime bytes, isolated configuration, and exact case input. Its generic tool summary is intentionally not translated into outcome receipts. The packet and external-baseline schemas, privacy boundary, exact OpenClaw procedure, and receipt contract are documented in [the private replay qualification contract](./docs/private-replay-qualification.md).

See [ARCHITECTURE.md](./ARCHITECTURE.md) and [docs/research-2026-07.md](./docs/research-2026-07.md).

## Production boundary

v0.10 has a production-shaped isolated-cell deployment, documented in [deploy/README.md](./deploy/README.md), but has not cleared the live integration, security, deployed disaster-recovery, load, and product-quality gates required to call it production-ready. Local online-backup recovery and portable empty-cell tenant restore are tested. One gateway plus multiple workers on one host and SQLite volume is coordinated by durable leases. Deployment across machines still requires transactional Postgres, distributed queue, and blob-store adapters. A hosted product still needs account authentication, connector pairing, tenant provisioning, billing/quotas, distributed tracing, and sustained external security/load testing.

Native binary-media analysis currently has one implementation, Gemini, behind a provider-neutral interface; additional analyzers can be added without changing jobs or artifacts. Existing logs are never imported automatically; the import command is explicit, append-only, and leaves every source file unchanged.

The complete product boundary, non-erasure invariant, phased roadmap, and acceptance criteria live in [goal.md](./goal.md). Longitudinal perception is recorded in [the v0.10 implementation note](./docs/perception-engine-v0.10-2026-08-25.md); verified email is recorded in [the v0.9 implementation note](./docs/email-verification-v0.9-2026-08-24.md); receipt-gated execution is recorded in [the v0.8 action-proof note](./docs/action-proof-v0.8-2026-08-23.md), and the daemon/office daily-driver architecture is recorded in [the v0.7 implementation note](./docs/daily-driver-v0.7-2026-08-22.md). Prime Agent adoption evidence and remaining caveats are recorded in [the v0.5 adoption audit](./docs/prime-adoption-audit-2026-08-07.md); the product rename and backward compatibility are recorded in [the v0.6 naming audit](./docs/co-naming-audit-2026-08-09.md).
