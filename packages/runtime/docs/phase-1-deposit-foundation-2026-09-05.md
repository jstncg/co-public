# Phase 1 deposit foundation — 2026-09-05

This record distinguishes the locally proven deposit path from live-provider evidence that has not been earned.

## What is now composed

Sendblue and Linq normalize inbound media into the same bounded attachment descriptor: stable ID, exact URL, optional MIME type, filename, and declared size. The authenticated webhook receipt, raw provider payload, authorization event, durable `channel.turn` job, owner message event, and asynchronous `content.enrich` job retain one causally linked source. The authorization binds a digest of the attachment set, so changing a URL or descriptor under the same external message ID fails closed.

The foreground input contains only an attachment kind and optional filename. Exact signed query URLs remain available to the worker but are excluded from foreground requests, background judgment prompts, memory statements, and human-facing repair text. URL and attachment enrichment is admitted in the same transaction as the message/run, then processed by a worker; neither slow native analysis nor a retryable enrichment failure delays the foreground reply. Terminal enrichment failure creates one held repair record and preserves the submitted reference.

History retrieval remains provenance-bearing. Plain text is indexed as owner evidence; enriched source material is indexed as untrusted evidence with its artifact/source event. FTS retrieval is approximate and temporally diversified. Coverage labels remain explicit, and inaccessible or unanalyzable binaries become `metadata` or a durable failure rather than being described as inspected.

For explicit attachments, the first successful bounded fetch is persisted before interpretation in tenant-scoped content-addressed storage. Identical bytes share one SHA-256 blob while retaining distinct source-event/attachment references. Preserved bytes are included in exact tenant export, restore, confirmed deletion, and SQLite online backup. Authenticated metadata listing removes URL query strings; authenticated content retrieval returns the exact bytes. The SQLite/base64 implementation is the portable single-cell reference, not the future multi-host blob topology.

## Exercised modality matrix

| Deposit | Foreground path | Backstage result in deterministic tests | Live external coverage |
| --- | --- | --- | --- |
| text | exact owner text | owner evidence; no invented media work | ordinary runtime adapters, not qualified here |
| link | public URL in owner text | article/full-text artifact fixture | real fetch implementation; fixture network in CI |
| screenshot | opaque image marker | image + `multimodal` artifact fixture | Gemini adapter implemented; no live Gemini call in this record |
| voice note | opaque audio marker | podcast + `transcript` artifact fixture | Gemini adapter implemented; no live Gemini call in this record |
| long document | opaque document marker | document + `document` artifact fixture | bounded binary path implemented; no live provider-size trial in this record |

The composed matrix is `test/deposits.test.ts`. Connector tests use real HMAC/timing-safe signature verification and a real SQLite/HTTP/worker path, but simulated Sendblue/Linq endpoints and simulated model dependencies. Media unit tests execute resource classification, DNS/redirect controls, coverage semantics, Flash-Lite escalation, captions, and bounded multimodal behavior with deterministic dependencies. None of those is evidence of a deployed iMessage or Gemini round trip.

## Still open

- Qualify the deployed selected iMessage rail from signed inbound through authenticated delivery callback using non-fixture provider/model traffic.
- Add the multi-host object-store adapter and account quota policy before hosted scale; the current content-addressed SQLite/base64 implementation deliberately optimizes for a portable isolated cell.
- Measure the interval from webhook acceptance to first attachment fetch under load. A provider URL can still expire before the asynchronous capture begins, which remains a durable inaccessible-source failure.
- Run consented real screenshot, voice, and long-document deposits across the selected rail and record provider limits, latency, expiry behavior, partial media, and failure recovery.

Until those are complete, this is a dependable isolated-cell deposit foundation—not a claim that live provider behavior or hosted blob scale has been qualified.
