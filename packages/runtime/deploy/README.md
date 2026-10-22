# Production deployment

This deployment runs one neutral, single-tenant Co cell. Scale people as isolated cells rather than allowing request bodies to choose a tenant. The cell has a read-only root filesystem, no Linux capabilities, bounded process and temporary-file use, a persistent data volume, explicit secrets, health probes, graceful termination, and authenticated API/metrics access.

## macOS infrastructure rehearsal (not production)

`node deploy/launchd-shadow.ts /absolute/new/private-directory [port] [com.co.runtime-shadow.suffix]`
prepares an isolated mock-provider, compose-only cell and a LaunchAgent. It refuses existing
destinations, keeps tokens in a private file, uses an absolute Node path and binds only to loopback.
Start the printed plist with `launchctl bootstrap gui/$(id -u) /absolute/printed.plist`; an initial
`launchctl kickstart gui/$(id -u)/com.co.runtime-shadow` can start it on demand. That manual command
is **not** a successful restart test. Inspect the exact service and verify automatic return after
termination, then prove a release-pinned durable job completes. `launchctl bootout` of that exact
service stops the rehearsal; retain its private state for diagnosis. No live connector is configured.

On the current migration host, manual execution drains work but automatic relaunch was not reliable.
This adapter is therefore prepared/tested infrastructure, not an unattended-operation qualification.
Do not copy the mock profile into a production deployment or switch traffic because `/health` is green.

### No-send incumbent archive comparison

`node src/cli.ts daemon --shadow-archive-plan /absolute/private-plan.json` adds a bounded local
archive follower to a **shadow-only** daemon. It neither changes nor acknowledges the live webhook.
The plan is a mode-0600 owner-controlled JSON file:

```json
{
  "format": "co.shadow-archive.v1",
  "id": "member-comparison-v1",
  "path": "/absolute/incumbent-archive.jsonl",
  "tenantId": "member-cell",
  "routes": [
    { "transport": "linq", "tenantPhone": "+15550001111", "threadId": "verified-direct-thread", "peerId": "member" }
  ]
}
```

Map existing direct threads explicitly; the same member can have separate carrier mappings to one
shadow peer. Never infer a member from an archive filename or accept a group as a direct thread.
The first poll starts at EOF. Subsequent complete lines admit release-pinned composition jobs and
record incumbent outbound baselines; the cursor commits atomically with each row's work. Repeated
IDs with different content, changed plans, source replacement/truncation and consumed-boundary edits
hold the feed. Invalid/unmapped rows get hash-only diagnostic receipts; partial lines wait. A damaged
source does not stop the daemon from draining already-admitted work. Reads are bounded to 2 MB / 32
lines per pass; a busy worker can delay polling, while the incumbent retains the original archive.

This local mirror is not carrier-signature qualification. It has no typed attachment provenance:
archived attachments are explicitly uninspected, not guessed from URLs. A mock shadow tests plumbing,
not response quality. Quarantine uncertain source changes and resolve the operator mapping rather
than deleting a cursor to force historical replay. The source is never rewritten or pruned.

## Prepare

```bash
cd deploy
cp production.env.example production.env
mkdir -p secrets
openssl rand -hex 32 > secrets/server_token
printf '%s' 'replace-with-provider-key' > secrets/openai_api_key
chmod 700 secrets
chmod 600 secrets/* production.env
```

To enable verified email, create two additional, distinct secrets, uncomment their mounts in `docker-compose.yml`, and set the email fields in `production.env`:

```bash
printf '%s' 'replace-with-resend-key' > secrets/resend_api_key
openssl rand -hex 32 > secrets/co_email_otp_secret
chmod 600 secrets/resend_api_key secrets/co_email_otp_secret
```

Resend also requires `CO_EMAIL_FROM` to use a sender/domain authorized in that account. `co config check` fails closed on missing parts, non-TLS provider URLs, weak OTP material, or reused secrets.

Create and inspect an onboarding plan inside the same persistent volume. The default workspace is isolated under that profile; pass `--workspace /data/workspaces/account` to make the location explicit:

```bash
docker compose run --rm co onboard plan account \
  --timezone UTC \
  --workspace /data/workspaces/account \
  --provider openai \
  --out /data/account-onboarding.json
docker compose run --rm co onboard apply /data/account-onboarding.json
docker compose run --rm co onboard verify --profile /data/profiles/account.json
docker compose run --rm co config check --profile /data/profiles/account.json
```

Change `account` to a deployment-owned opaque identifier, not a person's email or phone number. The profile contains no credentials or inferred personal traits.

## Run

```bash
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8787/health/ready
```

The published port is loopback-only. Terminate TLS and apply an additional edge rate limit at a reverse proxy or managed load balancer before exposing it. Never publish the container directly on the public internet.

The Compose cell keeps process execution disabled. It deliberately does not mount the Docker socket: doing so would turn a compromise of the gateway into authority over the host daemon. Use separately isolated approved MCP services, or deploy the Docker execution backend behind a deliberately secured rootless daemon boundary.

Authenticated API and Prometheus metrics:

```bash
TOKEN=$(tr -d '\n' < secrets/server_token)
curl --fail -H "Authorization: Bearer ${TOKEN}" http://127.0.0.1:8787/metrics
curl --fail -H "Authorization: Bearer ${TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"message":"hello"}' \
  http://127.0.0.1:8787/v1/chat
```

## Operate and recover

Run diagnostics and create an online SQLite backup without stopping the cell:

```bash
docker compose exec co node src/cli.ts doctor
docker compose exec co node src/cli.ts backup /data/backups/runtime-$(date -u +%Y%m%dT%H%M%SZ).sqlite
```

Copy backups to storage outside the Docker host and test restoration regularly. Restoration is deliberately not automated: stop the cell, retain the current database and WAL files as a rollback copy, place the selected backup at the configured database path, start the cell, then require both `/health/ready` and `doctor` to pass before accepting traffic.

SQLite is the supported single-host production cell. Do not mount its data directory over NFS. Multiple workers on the same host are lease-safe, but multi-host active/active operation requires the planned transactional Postgres, queue, and blob-store adapters.

## Secret rotation

Write a new secret file atomically, then recreate the cell. API, connector, provider, and email OTP secrets must all be different. The runtime accepts `NAME_FILE` for service tokens, provider keys, Gemini keys, Sendblue credentials, the email OTP secret, and variables referenced by MCP configuration.

```bash
openssl rand -hex 32 > secrets/server_token.next
mv secrets/server_token.next secrets/server_token
chmod 600 secrets/server_token
docker compose up -d --force-recreate
```

## Selective credentials during a migration

`NAME_DOTENV_FILE=/absolute/private/service.env` resolves only `NAME` from an existing dotenv
file. It does not load that file into the process environment, expand variables, execute shell
text, or configure the other credentials in the file. For example, a no-send API-provider shadow
can reuse `ANTHROPIC_API_KEY` without acquiring the incumbent's messaging connector configuration.
The shared file must be a regular file controlled by this account or root, not group/world writable,
and no larger than 64 KiB. Inline, `_FILE`, and `_DOTENV_FILE` forms are mutually exclusive, including
an explicitly empty conflicting value. Missing selected keys fail closed. Keys are not copied into
the profile or model context; reads observe rotation. Separate mounted secret files remain the
preferred deployment contract when there is no existing shared service configuration to reuse.

## External recovery for a deferred macOS runtime

`deploy/launchd-watchdog.ts com.co.runtime-{shadow|live}[.suffix]` is a narrowly scoped recovery adapter
for the observed macOS KeepAlive deferral. Schedule it outside the runtime, for example in the same
user's crontab once per minute, using absolute Node/script paths and a private operator log. Preserve
existing crontab entries and a before-copy; do not replace the entire user's schedule with an example.
The adapter only inspects that user's exact loaded runtime service. It requests `launchctl kickstart`
without `-k` if the service is stopped. It never bootstraps an unloaded service, kills a running one,
or touches an incumbent sender. `bootout` therefore remains an intentional stop. Removing the exact
watchdog cron entry disables recovery; preserve unrelated entries added after installation.

A start request is not a health verdict. Qualify the actual scheduler: terminate the candidate,
admit a synthetic durable job while it is down, observe a different PID without manual intervention,
and verify the release-pinned job completes with zero deliveries. This watchdog detects absent
processes, not a hung worker. The GUI session still has to exist; it does not establish recovery
across logout, reboot, host sleep or machine failure. Use the isolated container deployment on an
always-on host for those availability requirements, with its own restart and restoration qualification.

Archive comparisons now isolate each input's candidate session and use a bounded window of earlier
incumbent archive observations. A later baseline cannot enter the context even if its timestamp is
backdated. Candidate drafts remain in the run audit but are not indexed as things Co told the member.
This fixes counterfactual-conversation leakage; it does not supply pre-activation history, fresh media
coverage, carrier delivery proof or action parity. Those still require separate qualification.

## Incremental live-brain topology

The 2026-09-06 macOS cutover keeps the existing carrier/router on 8099 and runs a single-tenant live
runtime cell on 8090. The router selects it only for identities listed in `CO_RUNTIME_TENANTS`; an
explicit `WITNESS_FALLBACK_URL` on 8091 preserves other tenants during rollout. Do not point multiple
tenant identities at one profile merely because the compatibility request contains a `user` field:
the server validates that field against its configured tenant.

`CO_ENGINE_TOKEN_FILE` authenticates the router without placing the token in its plist or source.
The file must be private and owner-controlled. The live runtime can select only the provider keys it
needs from an existing dotenv through `NAME_DOTENV_FILE`; this does not confer connector credentials.
The router remains the only sender until runtime delivery ownership is separately qualified.

The runtime LaunchAgent and its external watchdog have distinct responsibilities: LaunchAgent owns
the process; the watchdog requests startup only when the exact loaded runtime job is stopped. Neither
is a hung-worker detector. The observed test covered logged-in-session process death and a different
replacement PID, not reboot, sleep or host loss.

Rollback the brain without erasing post-cutover conversation:

```bash
launchctl bootout gui/$(id -u)/com.co.runtime-live
launchctl bootstrap gui/$(id -u) /absolute/private/rollback.co-brain.plist
launchctl kickstart -k gui/$(id -u)/com.dennis.co-brain
launchctl kickstart -k gui/$(id -u)/com.dennis.co-router
```

Keep the isolated fallback running while the tenant allowlist is present. Verify 8090 model health,
router health and the app/thread reads. Reconcile any accepted runtime work or uncertain effects
before rollback; never replay an external effect because a conversation transcript survived.
