# Co runtime migration

The durable harness is integrated at `projects/co/packages/runtime`. As of 2026-09-06, the Dennis
relationship's live conversational brain is the runtime on port 8090. Python still owns the proven
Linq ingress/delivery, burst, media, app and voice compatibility surface on port 8099. An isolated
incumbent engine on port 8091 protects other tenants during the incremental cutover. This is a live
brain cutover, not a claim that connector delivery, every accepted duty, or all historical semantics
have been reimplemented inside the runtime.

## Preservation and provenance

- Source includes the diyagi working tree at `89466993b8f69523d31349bc98dc99e98d9b47eb`, including
  the uncommitted evidence, inquiry-delivery and responsibility fixes. Per-file original hashes
  are in `MIGRATION-SOURCE.json`; subsequent differences are intentional Co integration work.
- The original checkout and Git history are retained. No nested `.git`, dependency tree, coverage,
  credential or live database was imported into this package. Co's workspace lock and CI govern it.
- Private backups and candidate data stay outside Git. The local migration record lives in
  Co's ignored `docs/specs/runtime-migration-2026-09-05.md`.
- Snapshot every selected database with SQLite's online backup API, including committed WAL.
  Preserve ordinary files byte-for-byte and reject concurrent replacement during copying.
- Every claims/relation/correction row and transcript entry becomes a provenance-bearing historical
  record. Blobs and integer precision survive. Other tables and sidecars remain in full snapshots.
- A legacy inference is not a confirmed fact about the member. Corrected, retired and superseded
  claims are retained but not indexed as current evidence. Unknown timestamps stay unresolved;
  naive timestamps require the writer's historical timezone, not a guessed current location.
- Imports do not create sessions, jobs, permissions, promises, goals or model calls. Sidecars with
  outstanding obligations are preserved but are NOT automatically executable in the new runtime.

## Commands (from the Co root)

```sh
pnpm install --frozen-lockfile
pnpm check:runtime
pnpm migration prepare /absolute/private-plan.json /absolute/new-candidate-directory
pnpm migration verify /absolute/candidate-directory
```

`prepare` refuses existing destinations, never overwrites a live store, and retains partial snapshots
with a `FAILED` marker on error. `verify` opens the candidate read-only, checks snapshot hashes,
reconciles every imported record against its snapshot, verifies attribution and counts, and rejects
active work or silently promoted memories. Neither command can switch traffic or contact providers.

Plan shape (identities and mappings must be explicitly reviewed; never infer routing from a filename):

```json
{
  "format": "co.legacy-migration.v1",
  "sources": [
    { "id": "member-a-claims", "tenantId": "member-a", "path": "/private/claims.db", "format": "claims-sqlite" },
    { "id": "member-a-transcript", "tenantId": "member-a", "path": "/private/transcript.json", "format": "transcript-json", "timestampZone": "America/Los_Angeles" },
    { "id": "member-a-obligations", "tenantId": "member-a", "path": "/private/anchors.json", "format": "preserve-only" }
  ]
}
```

One consistent SQLite snapshot is not a globally consistent snapshot of every live service. This
first preparation is a rehearsal. Final cutover requires quiescence or an authenticated durable
ingress buffer, a final snapshot/delta reconciliation, and proof that no accepted message was lost.
Raw shared-service backups may contain credentials and other members' data. Keep them private and
access-controlled; do not attach them to issues, model requests or tenant exports. Snapshots have a
separate retention/deletion lifecycle from the candidate's tenant-scoped imported events.

## Cutover gates (all still required)

Functional parity with the incumbent is a prerequisite, not post-cutover work. See
`FUNCTIONAL-PARITY.md` for the minimum capability inventory, adapter ownership and comparative proof.
Every enabled capability and accepted duty needs a disposition; an unqualified essential capability
blocks switching even when infrastructure tests pass.

| Gate | Evidence required |
|---|---|
| Unattended execution | An operating-system-supervised daemon drains release-pinned jobs and automatically resumes after process death, without an operator restarting it. |
| In-turn understanding | Screenshot/link question is read before grounded composition; bounded timeout and honest partial coverage. Real Instagram/X/TikTok/YouTube samples. |
| Conversation behavior | Signed real-channel bursts, typing hold, supersession, no duplicate or half-thought replies. |
| Memory continuity | Historical retrieval, correct subject attribution, conversational correction/retirement, timezone and DST fixtures. |
| Surface compatibility | Existing `/w/<slug>/app.json`, `/chat`, `/lived`, viewer and voice contracts, tenant authentication, unchanged existing pairings. |
| Accepted duties | Every anchor, watch, promise, mandate and pending effect accounted for: migrated or explicitly retained under one execution owner. |
| Source access | Existing Gmail/calendar consent and credential bindings preserved; no expanded scopes or copied secrets in model context. |
| One sender | Old cron/launchd send paths drained or fenced; new dispatch owns exact channel/tenant; no dual active sender. |
| Release qualification | Non-mock model disposition and longitudinal behavior probes, real-reader checks, authenticated connector receipt chain. |
| State reconciliation | Final snapshot/delta and pending-send reconciliation; no unresolved uncertain effects replayed. |
| Rollback | Rehearsed restoration of old routing, retention/reconciliation of new inbound messages and completed effects. |

Do not substitute a bearer `/v1` API for the app's existing capability URL contract. Do not copy the
Python schedulers into the new daemon while leaving old cron active. Do not use a subscription-seat
provider as the default production provider. Do not mistake a green archive verification for any
of the live gates above.

## Implementation checkpoint — 2026-09-05

The three prerequisite answers now distinguish code from deployment:

| Prerequisite | Local implementation | Live qualification |
|---|---|---|
| Supervised execution | Compose-only mode and a macOS supervisor preparation command; a release-pinned queued fixture completes. | **Not passed.** Automatic relaunch after termination did not reliably occur on the current host. Manual restart is not proof. |
| Native image parts | HTTP/connector attachments retain provenance; cached original bytes reach Responses, Messages and compatible vision APIs at compose time. | API wire-format and restart tests, not real-model or real-channel qualification. |
| Embedding retrieval | Tenant/model-scoped cosine index, off-path backfill, hybrid memory/history tools and automatic source context. | Opt-in; not activated on the historical candidate or production. Historical coverage and retrieval-quality comparison remain open. |

Shadow is a deliberately restricted composition profile, not a full action-agent canary. It rejects
tool execution, delivery, executable model routes, MCP/plugins/process backends, mutating HTTP routes
other than chat, and non-composition jobs. It does not start detached enrichment or inference lanes.
Configured vision/retrieval/model API reads are still possible; it is not an operating-system network
sandbox. A shadow database is permanently marked and cannot be opened live by dropping an env flag.
Promote reviewed data into a separate live store; do not rename the shadow database into production.

Native vision currently accepts declared PNG/JPEG/WebP references, at most the newest four images,
3 MB per image, with a shared 12-second foreground fetch deadline. Omitted or unavailable images are
explicit in model context. Original bytes remain immutable and tenant-bound. CLI models reject native
image input. Image calls with dollar ceilings or shared responsibility budgets fail closed until a
model-specific visual-token estimator is implemented; text-byte accounting is not sufficient.

### Gemini preference — 2026-09-05

`CO_FOREGROUND_MEDIA=gemini` is now the configured default, alongside the existing
`CO_MEDIA_ANALYZER=auto`, `CO_GEMINI_MODEL` and secret-file support. Supported images and audio
attachments go through Gemini before compose, independently of the conversational provider.
Successful evidence is cached by tenant, immutable original, model and prompt version; source URLs
stay below the model. Evidence remains explicitly attributed/untrusted, not owner commands or facts.
Analysis uses one 30-second deadline and no model fallback; audio downloads have a 12-second bound,
four total attachments and a 10 MB per-audio bound. Containers are signature-checked, not decoded
locally. Real channel/codec/quality qualification, HEIC/HEIF and media budget reservation remain open.
`CO_FOREGROUND_MEDIA=native` preserves API-native PNG/JPEG/WebP images and explicitly declines audio.

This is candidate code, not a live provider switch. Neither Gemini key environment variable is
configured in the test process; the isolated LaunchAgent still has media disabled and mock chat.
No actual Gemini inference, private-media upload or live iMessage cutover was performed in this step.
The real outstanding operational failure remains automatic daemon relaunch. The other migration
gates above are unfinished implementation/qualification, not missing user authorization.

Verification: full workspace `pnpm check` passed; the final runtime check passed 453 tests.
Wire format and inline size policy were checked against Google's
[image](https://ai.google.dev/gemini-api/docs/generate-content/image-understanding) and
[audio](https://ai.google.dev/gemini-api/docs/generate-content/audio) documentation. Provider tests
intercept HTTP; this is not a claim of real-model quality or deployed credential validity.

### Operational follow-through — 2026-09-05

- Actual Gemini Flash-Lite calls with synthetic PNG and WAV fixtures succeeded using an existing
  incumbent credential below the model boundary. This establishes connectivity for the selected
  model and two formats, not personal-media or real-channel quality. No private media was uploaded.
- A bounded local incumbent-archive follower is implemented and enabled on the isolated daemon.
  It starts at EOF, uses explicit owner/direct-thread mappings, records outbound baselines and
  atomically admits release-pinned no-send jobs. Six tests include a real daemon subprocess,
  restart/cursor recovery, transaction rollback, malformed/partial lines and isolation boundaries.
- The deployed comparison still uses a mock conversational model. At activation its cursor was
  initialized; no newly arriving real message had yet qualified the live feed. The original rail
  owns ingress, replies, app/voice and all incumbent duties. No historical messages were replayed.
- Automatic GUI LaunchAgent recovery failed again under both unconditional and conditional
  crash-restart policies. The original policy was restored. The cause remains unproven; changing
  policy or manually starting the daemon is not a pass. System-level supervision has not been tested:
  local administrator authentication is required and unavailable to this session.

Nothing here qualifies full cutover. Compatibility, historical semantics/embedding coverage,
accepted duties, non-mock longitudinal comparison, signed delivery and rollback still gate it.

The full workspace `pnpm check` passed after this step, including 459 runtime tests. These six new
archive tests qualify the implementation and subprocess recovery, not macOS automatic restart.

Semantic indexing is disabled unless `CO_EMBEDDING_MODEL` explicitly selects a Voyage model. The
adapter reuses Co's existing Voyage API shape behind a replaceable embedding interface. Configure
`CO_EMBEDDING_API_KEY_ENV`, `CO_EMBEDDING_DIMENSIONS` and `CO_EMBEDDING_MAX_CALLS_PER_DAY` as needed.
Writes never call the embedder. One bounded idle batch runs outside the worker's execution lane;
queries have a 1.2-second deadline and report lexical fallback on failure. Vectors represent the first
4,000 characters, not full-document understanding. The SQLite exact-search implementation is a
single-cell backend, not a multi-host vector service or a completed semantic restraint gate.

Automatic remembering no longer asserts confidence 1.0 or user confirmation. First-person subjects
are retained; model-authored memories remain below the always-carried confidence threshold.
Conversational correction requires an owner's verbatim replacement; retirement requires an owner
quote tied to the exact statement/ID and retains history. This does **not** finish the legacy
confidence/decay/salience/subject mapping. New schedule, promise, goal and authority-expiry admissions
require an explicit timezone offset and reject invalid calendar dates; historical timestamps are not rewritten.

Next: qualify unattended restart, activate reviewed embedding backfill, run real-reader/image and
longitudinal retrieval comparisons, then shadow the authenticated existing inbound mirror without
sends. Preserve readers, shaping, burst/supersession, typing, mark-read, reactions and useful accepted
deferred watches. Do **not** copy the legacy unsolicited proactive lanes. App/voice compatibility,
accepted-duty reconciliation, single-sender cutover and rollback still gate moving live traffic.

## Live compatibility cutover — 2026-09-06 09:15 Pacific

The Dennis relationship now uses the runtime for every router `ask_engine` turn. The runtime is a
single-tenant live cell on loopback port 8090 with an Anthropic conversational provider, Gemini
Flash-Lite media configuration, a private Dennis profile, the verified Dennis-only legacy import,
and authenticated compatibility routes. The Linq router remains the only carrier sender. It supplies
the existing shaped conversation window, session context and stable peer identity to
`POST /v1/chat/completions`; prior messages are quoted context and cannot grant action authority.
Voice uses the same tenant and peer binding and the compatibility response supports JSON and SSE.
The adapter removes only an exact ordered history suffix already present in the canonical runtime
transcript, avoiding duplicated context cost without using fuzzy similarity to erase a distinct turn.

The cutover is deliberately tenant-scoped. `CO_RUNTIME_TENANTS` chooses the runtime cell; all other
onboarded identities use an incumbent fallback on port 8091. With no runtime allowlist the router's
historical all-primary behavior remains, and with an allowlist but no fallback it fails closed.
Tests cover both decisions. This prevents a request body from selecting another person's runtime
cell and prevents an incremental founder cutover from muting everyone else on the shared router.

Observed live evidence, with no carrier message sent by the qualification:

- authenticated runtime readiness, model discovery and runtime metadata returned 200;
- a real Anthropic reply completed through the exact router `ask_engine` path;
- JSON and voice-style SSE responses were nonempty and SSE terminated with `[DONE]`;
- the retained app `app.json` and `chat.json` routes returned 200; the latter retained 250 messages;
- a forced runtime `SIGKILL` returned under external supervision with a different PID and readiness;
- the live database contains one tenant only; imported history remains evidence/archive rather than
  silently promoted memory or executable work;
- the router, runtime and fallback listen independently on 8099, 8090 and 8091;
- the old half-hourly unsolicited `daily_text --send` LaunchAgent is unloaded and disabled. The
  existing router remains the single sender; runtime outbound-delivery rows remain zero.
- full workspace lint, formatting, brain checks, typechecks, tests and dead-code checks pass; the
  runtime suite contains 480 passing tests, and all 86 router tests pass with five optional skips.

Private source data, tokens, profiles, database backups, plist rollback copies and pre-cutover cron
are retained under the mode-0700 live operations directory outside Git. Secret and database files
are mode 0600. The old brain source and service definition were not erased.

Rollback does not need to rewrite history: stop the exact runtime service, bootstrap the retained
old-brain plist on 8090, and restart the router. Keep the port-8091 fallback running so non-runtime
tenants remain served. Router transcripts are still canonical to the retained app/brain surface, so
post-cutover turns remain available to the incumbent. Reconcile any runtime work/effects before a
rollback; this cutover has not transferred external action ownership into the runtime.

Still open for a *full responsibility migration*: direct runtime carrier receipts and delivery
reconciliation, accepted-duty transfer, activated/qualified historical semantic backfill, real
channel media fixtures, unattended reboot/sleep/hang recovery, and longitudinal conversation/value
evidence. These gaps limit the breadth of the migration claim; they do not mean the Dennis number's
conversation is still answered by the old brain.
