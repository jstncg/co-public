# Functional parity is the migration floor

Requirement recorded 2026-09-05: the replacement must, at minimum, match the useful functionality
of the current Co. A stronger execution core, more tools, or a passing test count does not establish
that the product can replace it. This document specifies release requirements, not completed work.

## What must survive

| Capability | Minimum observable acceptance |
|---|---|
| iMessage relationship | Existing Linq/Sendblue identities, direct-thread routing, history and pairings still work. Text-only, attachment-only and mixed turns are accepted. |
| Conversation timing | Bursts form one coherent turn; continued typing and superseding input prevent stale/duplicate replies. Read, typing and reaction behavior is preserved where the carrier supports it. |
| Read before replying | Supported YouTube, Instagram, X, TikTok, article, document, image and audio inputs yield source-grounded replies. Gemini handles image/audio perception; supported incumbent formats are inventoried, not silently excluded. |
| Longer media work | A deferred read has durable ownership, bounded retries, restart recovery, accurate coverage and an eventual result or honest failure. A promise to return is not the job itself. |
| Remember and retrieve | Old conversations, claims, evidence, corrections, supersession and original files remain accessible with dates, speakers and uncertainty. Historical retrieval works across months, not only recent turns. |
| Conversational continuity | Follow-ups resolve against what Co actually sent, including proactive messages, delayed results and app/voice exchanges. Pasted quotations are not automatically the member's beliefs. |
| Corrections and preferences | Corrections, forgetting, standing style preferences, timezone and relevant relationship context survive restart and migration. Retired material remains historical rather than current truth. |
| Reminders and calendar | Existing accepted reminders, changes, cancellations, repeats and timezone/DST semantics remain supported. Failed writes cannot be reported as completed. |
| Connected sources | Existing authorized email/calendar reading, search, consent and token refresh remain usable under the same tenant and scope. A connection badge is not proof the reader works. |
| Proactive assistance | Useful watches, requested follow-ups and relevant discoveries retain a responsible executor and delivery path. Implementations may change; the capability must not disappear. Respect quiet hours, suppression, cancellation and the current conversation. |
| App, viewer and voice | Existing app/viewer/voice routes, authenticated pairings, state views, edits and call-to-work flows remain functional. Do not replace their contracts with an incompatible bearer API. |
| Preservation and operations | Accepted inbound, pending effects, source access and outstanding duties reconcile across cutover and rollback. Exactly one sender owns each effect; interrupted uncertain effects are not blindly replayed. |

This is a minimum inventory. The source audit must account for every additional enabled capability
and outstanding duty. A feature can be retired only by an explicit owner decision, not because its
replacement is inconvenient. The existing instruction not to port negative unsolicited lanes still
stands: preserve useful initiative through the governed inquiry/scout/attention mechanisms instead.

## Implementation choices

Reuse the existing readers and interfaces when appropriate. A compatibility adapter can satisfy
parity; rewriting everything in TypeScript is not a requirement. The boundary must name one owner
for admission, execution, memory mutation, scheduling and delivery, with failure/recovery tests.
Keeping an incumbent executor temporarily preserves a service; it does not prove that executor's
responsibility has migrated. Record that distinction instead of claiming full cutover.

## Qualification, not a checklist assertion

For every capability, record the enabled incumbent behavior and limitations, target implementation
owner, retained adapter (if any), representative fixtures, test results and remaining gaps. Distinguish
implemented, fixture-tested, live-qualified and migrated. A missing record is unqualified, not passed.

Run the same representative inputs against incumbent and candidate, including fresh and historical
context. Compare task correctness, source coverage, user-visible timing, continuity, actual effects,
recovery and unnecessary interruptions. Set acceptance thresholds before examining candidate results.
Do not substitute model eloquence, a model's self-score, or number of output bubbles for success.

No-send shadowing can compare composition and timing, not prove actions or carrier delivery. Those
need separately authorized, reversible canaries and receipt verification. Mock composition proves
plumbing only. Private transcripts and real-channel fixtures stay outside Git; shared CI uses synthetic
counterparts. No overall completion percentage hides a missing essential capability.

Required negative cases include:

- Invented obligations cannot trigger personal criticism or reminders.
- A failed calendar write cannot become a success claim or an unbacked follow-up promise.
- A follow-up about Co's own notification resolves the correct topic and source.
- A discarded paste cannot later be cited as an adopted member position.
- Sharing material does not automatically trigger coaching, accountability or an avoidance diagnosis.
- A source that was not read cannot be described as watched, heard or understood.

Only after functional parity and the safety gates in `MIGRATION.md` pass may production move.
Improved agency and deeper insight build on that floor; they do not compensate for missing features.

## Live ownership map — 2026-09-06

The Dennis conversational brain has moved, while proven compatibility stays deliberately retained:

| Responsibility | Current owner | Qualification |
|---|---|---|
| Dennis composition and turn policy | Runtime on 8090 | Live real-provider response through exact router call; authenticated and tenant-bound. |
| Linq ingress, burst/supersession, typing/read/reaction and delivery | Existing router on 8099 | Retained live path; still the only sender. Runtime delivery receipts are not yet authoritative. |
| Images/audio/link/social readers | Existing router readers, with runtime Gemini capability available | Retained path and synthetic Gemini format checks; representative live-channel parity remains open. |
| App/viewer/thread/lived routes | Existing router and claims modules | `app.json` and 250-message `chat.json` returned 200 after cutover. Mutation-route canaries remain open. |
| Voice proxy | Existing router to tenant-bound engine | Runtime SSE returned content and `[DONE]`; an actual phone-call canary remains open. |
| Historical archive | Runtime Dennis-only evidence plus retained legacy stores/transcript | Import verification and tenant audit passed; semantic backfill/current-belief promotion remains off. |
| Non-Dennis composition | Incumbent fallback on 8091 | Healthy isolated compatibility service; cannot enter Dennis runtime cell. |
| Unsolicited initiative | Runtime inquiry/scout/attention design | Old half-hourly sender disabled. New value and delivery still require governed live qualification. |
| External actions and accepted legacy duties | Retained adapters/executors | Not fully transferred. Runtime must not claim full responsibility until effects and receipts reconcile. |

This ownership map is the reason the cutover is not a glued dual brain: each live turn has one
composer and every carrier send has one sender. It is also why the status is not "everything
migrated": retained responsibilities have named owners and explicit transfer gates rather than being
misrepresented as runtime-native.
