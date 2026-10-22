# Connector round-trip qualification

This gate answers one narrow release question: did one real, post-deployment member message traverse the authenticated connector boundary, complete through the intended behavior release and a non-mock model, receive a provider-accepted text reply to that exact message, and later acquire authenticated delivered or read evidence?

It is read-only. Qualification never sends, retries, repairs, reconciles, or rewrites anything.

## Procedure

1. Deploy Co with `CO_ENV=production`, one explicit behavior release, the intended model route, and both directions of either Linq or Sendblue ready.
2. Record the UTC deployment start time and release ID from `co release status`.
3. From an allowlisted member phone, send a new ordinary message to the deployed iMessage endpoint and wait for Co's reply plus the provider's delivered or read callback.
4. Find the foreground run with `co runs`, then qualify it:

```bash
npm start -- connector qualify linq \
  --run run_... \
  --since 2026-09-04T12:00:00Z \
  --release release_... \
  --require delivered
```

The inbound provider message ID may be used instead of the run ID:

```bash
npm start -- connector qualify linq \
  --inbound-id PROVIDER_INBOUND_MESSAGE_ID \
  --since 2026-09-04T12:00:00Z \
  --release release_... \
  --require read
```

The command exits nonzero unless every stage passes. `read` is stricter; `delivered` also accepts a later authenticated read callback because read implies delivery in the durable projection.

## What must agree

- The runtime is currently in production mode and the selected rail currently reports inbound and outbound ready.
- The ingress occurred at or after `--since`.
- The run used the exact requested immutable release, its stored release digest still matches, and its provider was not `mock`.
- One `webhook:<connector>` receipt points to the webhook event. That event can enter the store through the HTTP route only after connector authentication succeeds.
- The connector's member-authorization event causally binds the webhook event to the exact canonical relationship, inbound provider ID, and content digest.
- The canonical `message.received`, `run.started`, and unique `run.completed` events preserve that chain.
- One text delivery intent replies to the exact inbound provider ID. Its recomputed request digest matches both the event and the fenced outbound-delivery row.
- A real `message.delivery_accepted` event—not an operator reconciliation—contains a nonempty provider message ID from the same connector and is bound to that intent and run.
- A delivered/read evidence event is adjacent to its authenticated status-webhook event and receipt, names the same provider message ID, agrees with the outbound projection, and is bound either directly to the acceptance or through the exact early-callback reconciliation bridge.

The report contains hashes for the member peer, inbound selector, and provider message ID. It does not return message text, reply text, raw webhook payloads, phone numbers, or provider identifiers.

## What this does not prove

A passing synthetic fixture proves the implementation of the gate, not a live deployment. A passing report from a real post-deployment message proves one connector round trip; it does not establish longitudinal judgment quality, uptime, provider-wide reliability, or a non-founder product outcome. The Track 1 goal remains open until the operator retains a passing report from the actual deployed endpoint.

Raw webhook bodies and signature headers are deliberately not retained. The durable claim is therefore that the webhook event was admitted through code that verifies authentication before persistence, not that an auditor can later replay the original signature. A principal with arbitrary database-write access remains inside the trusted computing boundary.
