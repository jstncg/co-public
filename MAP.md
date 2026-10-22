# What is in here, and does it run

Nine top-level source areas, ~76,000 lines. Written 2026-09-01 because an audit found two
implementations of the same execution boundary — one Python and committed, one TypeScript and
untracked — neither aware of the other. A tree nobody can survey grows that twice.

`invariants.check_areas` fails when a new top-level source directory appears that is not listed
here, for the same reason `claims/TOOLS` and `claims/PARKED` exist: the cost of explaining a thing
is lowest on the day it is created.

## Live

| area | what it is |
|---|---|
| `frame/` | the rail (`homebase/router`, :8099), the organs (`claims/`, 97 of them), the persona (`brain/`, :8090), the laws (`evals/`) |
| `engine/` | `co_engine`: the claim ontology and the reconciler that schedules nine jobs |
| `ios/` | **the app** — `ios/Kyo`, the 8/6 ruling's one app. Talks to the rail over `/w/<slug>/…` |
| `packages/contracts` | shared type contracts between the rail and the app |
| `packages/action-harness` | provider-neutral governed execution boundary: opaque credentials, exact approvals, pause/resume, verified receipts, and browser canaries; activation remains feature-gated |
| `packages/google-workspace` | bounded Gmail awareness client and tenant-scoped connector contract; deployed ingestion remains feature-gated |

## Parked — built, dark, and all three behind the same two hours

`goal.md` §11 step 0 is fifteen credential tasks. It does not only block new work: these three
subsystems, roughly 14,000 lines, are already written and cannot run until it clears.

| area | blocked on |
|---|---|
| `apps/web` | a domain. 813 files, last commit 8/07 |
| `trigger/` | trigger.dev credentials. last commit 7/31 |
| `supabase/` | Supabase provisioning. last commit 8/10 |

## Retired

| area | ruling |
|---|---|
| `apps/ios` | 8/6: one app, and it is `ios/Kyo`. Read for reference, never build into it |

## Untracked, and at risk

Not gitignored — never added. A `git clean -fd` deletes them. Backed up 9/1 to
`~/.co/untracked-work-20260901.tgz`.

| path | what it is |
|---|---|
| `anti-ai-slop-writing/` | a vendored Claude Code skill. Its word list is already distilled into `disposition.SLOP_WORDS`; the directory is reference material, not code that runs |

## Support

`docs/` and `.agents/` are gitignored by founder decision — agent context and safekeeping, never
shipped. `design/`, `scripts/`, `evals/` hold assets, one utility, and golden data respectively.
