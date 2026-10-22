# @co/action-harness

Provider-neutral execution boundary for Co moves. This package is deliberately separate from
`@co/collaboration-harness`: collaborators interpret cited evidence and propose work; action workers
receive one bounded assignment only after Co has produced a move.

The protocol adopts useful execution mechanics demonstrated by OpenInstinct without importing its
coordinator prompt, memory model, UI, or provider assumptions. It includes a concrete raw-CDP
reference path so the security claims are executable rather than prompt conventions.

## Invariants

- A worker is never member-facing and treats untrusted content as data.
- Browser workers receive a known HTTPS start URL and an explicit origin allowlist.
- Raw passwords, tokens, OTPs, cookies, and payment details never enter the assignment. The worker
  receives only tenant-bound vault and sensitive-input references.
- External-effect capabilities are withheld from the worker until an approval verifier returns a
  grant bound to the exact tenant, run, source move, request hash, step, effect fingerprint, and
  capabilities. The final receipt must carry that same fingerprint.
- A blocked browser/API session is represented by an opaque checkpoint and can resume after approval,
  user input, or vault setup without replaying the whole task.
- Success requires a receipt bound to the exact request, independently verified completion evidence,
  and a rollback receipt for work classified as reversible.
- The run journal commits snapshots and content-free events with optimistic concurrency. Duplicate
  idempotency keys do not start a second worker, and stale resumes fail before the executor is called.
- A production executor must reconcile by run ID after a coordinator crash instead of blindly
  repeating a possibly completed side effect.

## Credentialed browser boundary

- `WorkspaceBoundVault` encrypts each record with AES-256-GCM and a per-workspace HKDF-derived key.
  Workspace ID, opaque handle, secret kind, exact HTTPS origin, and key version are authenticated as
  additional data. A record copied to another workspace therefore fails at the cryptographic layer.
- `OriginLockedSecretInjector` decrypts only after the current page origin exactly matches the stored
  origin. It injects the secret over the privileged DevTools connection; the worker receives only a
  handle and a fill receipt. CDP audits record method names and timestamps, never parameters.
- Injected fields are marked and CSS-masked before a screenshot can be taken. Browser text reads
  replace marked values with `[secret field]`.
- `browserToolPolicies` is an executable policy table. `web.submit` is available only when the active
  approval fingerprint exactly matches the proposed effect; prompt wording cannot grant authority.
- `ParkableBrowserProvider` keeps the page session behind an opaque checkpoint while approval or
  sensitive user input is pending. The in-memory provider proves the lifecycle locally; production
  hosts must supply a durable external provider implementation.

## Real-browser regression

Run `pnpm --filter @co/action-harness eval:browser`. The synthetic canary eval launches an installed
Chrome/Chromium with an ephemeral non-default profile and a raw CDP connection, then requires all of
the following in one run: exact final text, worker-reported completion, six real browser calls,
server-side effect verification, same-session resume, screenshot masking, cross-workspace crypto
failure, wrong-origin failure, mismatched-approval failure, and absence of the canary from observable
requests, snapshots, traces, screenshots, and CDP audit records. It never uses a real credential.

## Host responsibilities

The package contains the protocol, state machine, registry, encrypted-vault primitive, restricted CDP
tools, local browser adapter, in-memory parkable provider, and tests. A production host must supply a
durable `ActionRunJournal`, encrypted record store, external parkable browser provider, approval/input/
vault verifiers, key-management integration, and deployment policy. The `action_harness` feature flag
is off by default. This repository does not enable authenticated production browsing, store real
third-party credentials, or relax Co v1's final-user-action boundary.
