# Co v0.9 verified email

## Outcome

Co can now request an email address, send a short-lived control code, create a tenant-scoped verified identity, and send later messages only to that opaque verified recipient. The runtime owns code generation and verification. Models can request the operation but never receive the code.

This is a contact-verification and delivery capability, not application authentication. The HTTP routes are protected by the cell's existing bearer boundary; successful verification does not mint a cookie, token, role, or broader authority.

## Boundaries

- `EmailDeliveryAdapter` keeps the runtime provider-neutral. `ResendEmailAdapter` is the first implementation and uses the provider's HTTPS send endpoint plus a stable idempotency key.
- Direct CLI/API requests are explicit operator actions and send immediately. Model tool calls remain `external-write` and use the existing approval/receipt mechanism.
- `email.verification.request` accepts an address explicitly supplied by the user. `email.send_verified` accepts only a tenant-scoped opaque identity ID, not an arbitrary recipient.
- Public challenge and identity projections contain masked addresses. Email-specific lifecycle events contain a mask and SHA-256 address hash. The normalized delivery address remains in the tenant database; codes do not. If an address arrives through chat or a model tool, the ordinary source message, exact approval arguments, and tool receipt retain it for provenance and approval binding.

## Verification protocol

The runtime generates a uniform six-digit value with `crypto.randomInt`. It stores an HMAC-SHA-256 digest bound to the deployment OTP secret, challenge ID, normalized address, and code. Comparison is constant-time. Challenges have a bounded TTL, resend cooldown, maximum guess count, hourly limit, daily limit, single-use transition, and tenant scope.

Provider submission uses a challenge-stable idempotency key. Known failure becomes `delivery_failed`. A network timeout, ambiguous provider response, rate limit, conflict, or server failure becomes `delivery_uncertain`; the runtime does not blindly resubmit it. A code that actually arrived across an uncertain boundary remains verifiable. A recent concurrent duplicate reports that delivery is in progress; a stale `pending` record becomes uncertain for crash recovery.

Verified messages use an intent event with a deterministic ID before provider I/O, followed by a delivery receipt. A duplicate successful intent returns the existing receipt. An intent without a receipt is treated as uncertain and is not repeated automatically.

## Storage and non-erasure

Schema v10 adds `email_verification_challenges` and `verified_email_identities`. It does not update or delete prior events, imports, sessions, messages, memories, receipts, work orders, or source logs. Verification, expiry, lockout, revocation, and delivery append lifecycle evidence. Revocation disables future sending while retaining audit history.

The normalized address is personal data and is retained locally because Co needs it as the delivery destination. A hosted control plane still needs explicit retention/deletion policy, encrypted tenant secrets, account authentication, data-subject tooling, and hostile-tenant isolation. The current cell should not be marketed as hosted identity infrastructure.

## Configuration and provider contract

Required settings are `CO_EMAIL_PROVIDER=resend`, `RESEND_API_KEY` (or `_FILE`), `CO_EMAIL_FROM`, and a distinct high-entropy `CO_EMAIL_OTP_SECRET` (or `_FILE`). Production validation requires TLS, complete provider configuration, at least 32 bytes of non-trivial OTP material, conservative standing authority, and no reused server/provider/connector/OTP secrets.

The adapter follows Resend's documented [`POST /emails`](https://resend.com/docs/api-reference/emails/send-email) request and [`Idempotency-Key`](https://resend.com/docs/dashboard/emails/idempotency-keys) behavior. A live provider smoke still requires a deployment-owned API key and authorized sender domain.

## Evidence

The v0.9 suite exercises code secrecy, normalization/masking, idempotent requests, guess rejection and lockout, expiry, uncertain delivery, successful verification, verified-recipient send/retry/revocation, the Resend HTTP contract, model approval, authenticated HTTP lifecycle, production validation, and additive migration. On 2026-08-24, TypeScript and all 108 tests passed. No live provider claim was made.
