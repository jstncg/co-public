# Co Naming Audit — 2026-08-09

## Decision

The product is **Co**. “Runtime” describes an architectural component; it is not part of the product name.

Version 0.6 makes the following names canonical:

| Surface | Canonical name |
| --- | --- |
| Product | `Co` |
| CLI | `co` |
| Package | `@co/runtime` |
| TypeScript entry types | `CoRuntime`, `CoProfile` |
| Environment prefix | `CO_*` |
| New local home | `~/.co` |
| Neutral distribution | `co`, displayed as `Co` |
| Metrics | `co_*` |
| Docker Compose project/service | `co` |
| Execution containers and labels | `co-*`, `co.runtime.execution=true` |

The bundled neutral manifest moved from `distributions/companion.json` to `distributions/co.json`. Product documentation, prompts, CLI help, deployment examples, tests, temporary directories, MCP client identity, image tags, and monitoring names now use Co.

## Compatibility and non-erasure

The rename does not rewrite stored events, memories, runs, messages, profiles, artifacts, imports, receipts, or source logs.

- `CO_*` is authoritative. If it is absent, the corresponding legacy `COMPANION_*` value or `_FILE` secret remains readable.
- New installations default to `~/.co`. If that home does not contain a database and `~/.companion/runtime.sqlite` exists, Co continues using the existing home automatically.
- A profile or caller using the old neutral distribution ID `companion` resolves to the canonical `co` distribution in memory. The profile file is not overwritten.
- Existing database IDs and event payloads are not rewritten merely for branding.
- No old file or directory is deleted, copied, or renamed automatically.
- Primary Co values win deterministically when both generations of an environment setting exist.

The compatibility vocabulary appears only in the migration adapter, its regression test, and this audit. It is not emitted as current branding.

## Verification

The rename adds regression coverage for legacy environment values, home selection, `_FILE`-compatible secret resolution, distribution aliasing, and primary-name precedence. The full suite must also continue to cover onboarding isolation, runtime execution, monitoring, metrics, retained agents, goals, refinements, HTTP behavior, media, memory, and database migration.

Checks completed on 2026-08-09:

```text
npm run check
  TypeScript: pass
  Tests: 67 passed, 0 failed

npx --yes node@22.19.0 --test test/*.test.ts
  Tests: 67 passed, 0 failed

npm audit --omit=dev --audit-level=high
  Production vulnerabilities: 0

npm pack --dry-run --json
  Package: @co/runtime@0.6.0
  Binary: co
  Neutral manifest: distributions/co.json
```

The Docker image naming and configuration were updated, but the prior environment limitation still applies. `docker info` reports the Co client and OrbStack context, then hangs while obtaining server state; it was interrupted without claiming success. A responsive daemon must complete a fresh v0.6 image build.
