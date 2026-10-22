# golden transcript set

The replayable regression suite for the predecessor rail (goal.md §5.7, §32 week 0b): the founder's
live Sendblue iMessage thread — 279 turns (user + assistant), July 1–20 2026 — labeled with the
praise and failure classes observed in production. The new system must preserve or improve the
behavior that produced 6–7 voluntary sends per day before it is allowed to replace the old brain.

## contents

- `taxonomy.md` — the labeled classes and their one-line definitions (committed)
- `data/transcript.jsonl` — one line per turn: `{idx, role, content, exchange_id}` (local only)
- `data/labels.jsonl` — one line per turn: `{idx, exchange_id, role, labels}` (local only)

## how to regenerate

From the co repo root, on homebase (the machine holding the live transcript):

```
python3 scripts/build_golden_set.py
```

The builder reads `~/.co_dennis_sendblue_transcript.json` (the router's durable per-tenant
transcript), emits the two jsonl files, auto-labels what is mechanically detectable (capability
denials, memory teases, the documented incidents), and prints a per-label count summary. Everything
it cannot detect mechanically is labeled `unlabeled` for human/founder review — the labels file is
the review worklist, not the finished truth.

## PRIVACY

`data/` is gitignored and NEVER leaves this machine. It is the founder's private conversation.
Only the taxonomy and the tooling are committed; anything derived from `data/` that gets shared
(eval results, dashboards, docs) must contain label counts and scores only — never message content.
