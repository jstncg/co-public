# golden set taxonomy

Labeled classes for the predecessor-rail regression suite (goal.md §5.7). Sources: the live
production thread July 1–20 2026 and the incident log in `docs/imessage-rail-context.md` §5.
Positive classes (what to preserve) and failure classes (what must never regress) both count:
a candidate brain is scored on reproducing the first set and avoiding the second.

## positive classes (preserve)

- **comprehension_success** — a reply proving the media was actually watched/read: specific detail
  only the content itself could supply (the trust moment; the single biggest quality delta observed).
- **praised_line** — a reply the founder explicitly praised or tapback-loved (the earned LINE that
  landed).
- **held_correctly** — restraint correctly applied: a none/light-tier send where the ack WAS the
  right reply and no text followed (restraint is the product; zero mute events in 3 weeks).
- **proactive_relevant** — an unprompted send the founder engaged with ("co texting me first
  definitely does wonders, but it has to be relevant").

## failure classes (never regress)

- **capability_denial** — the model denies a capability it demonstrably has in-context ("i can't
  watch videos" while holding the watch) — the worst trust-burner observed.
- **enumeration_truncation** — an N-item ask answered with fewer than N items (a length cap
  silently truncating a 9-term breakdown to 2 read as laziness; completeness beats brevity when the
  ask enumerates).
- **memory_tease** — referencing held memory without producing it ("i know what tuesday cost you"
  with no receipt in the same bubble).
- **share_floor_miss** — a successfully-read link answered with only a tapback/emoji: below the
  one-specific-sentence floor (a share is a bid for a take — "Um hello?").
- **receipt_missing** — a memory-based claim stated without the quotable evidence alongside it.
- **false_enforcement** — confident enforcement of a wrong fact (enforcement requires a quotable
  receipt).
- **proactive_noise** — an unprompted send that was irrelevant or ignored (the mute-button path).

## bookkeeping

- **unlabeled** — not mechanically detectable; awaiting human/founder review.
