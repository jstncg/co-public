#!/usr/bin/env python3
"""
TRAIT ENGINE — the climb from facts to personality. Rung 2→3 of the depth ladder.

Facts ("you tithe at Sa-Rang") are retrieval. Traits ("you go quiet when a relationship
gets tense") are INFERENCE over behavioral statistics. The method:

  1. CODE computes per-relationship behavioral distributions — reply latency, who
     initiates, message length, volume trajectory. Personality lives in how these
     DIFFER across relationships and shift over time, not in any single message.
  2. LLM reads the cross-relationship table + message samples → names patterns →
     infers traits, each with evidence, COUNTEREVIDENCE, and a confidence score.
  3. Every trait ships with a FALSIFIABLE PREDICTION. That's the anti-horoscope gate:
     a real trait predicts the next behavior; a hallucinated one doesn't. (Ties to
     predict_self — prediction is how you validate a trait instead of asserting it.)

Hard rule (Mirror Principle): traits are HYPOTHESES surfaced for the user to confirm,
never assertions. Higher rung = higher cost of being wrong (a wrong fact is a shrug;
a wrong trait feels like being misjudged).

SANDBOXED: read-only on substrate.db. Writes nothing.

Usage: python3 trait_engine.py [--contacts 8] [--sample 12]
"""

import argparse
import json
import re
import sqlite3
import statistics
import sys
from collections import defaultdict
from datetime import datetime

sys.path.insert(0, "/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/lib")
from llm import complete  # noqa: E402

DB_RO = "file:/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/state/substrate.db?mode=ro"
MODEL = "claude-sonnet-4-6"
SELF = 1


def parse_ts(s):
    try:
        return datetime.fromisoformat(s[:19])
    except (ValueError, TypeError):
        return None


def top_contacts(conn, n):
    rows = conn.execute(
        """SELECT p.id, p.display_name, COUNT(*) tot
           FROM communications c JOIN persons p ON p.id=c.from_person_id
           WHERE c.channel='imessage' AND c.direction='received' AND c.is_group_chat=0
             AND p.is_self=0 AND length(p.display_name) BETWEEN 1 AND 40
           GROUP BY p.id HAVING tot > 500 ORDER BY tot DESC LIMIT ?""",
        (n,),
    ).fetchall()
    return rows


def relationship_stats(conn, cid, sample_n):
    """Pull the merged two-way thread with this contact; compute his behavioral distribution."""
    rows = conn.execute(
        """SELECT ts, direction, body FROM communications
           WHERE channel='imessage' AND is_group_chat=0 AND ts IS NOT NULL
             AND ( (direction='received' AND from_person_id=?)
                OR (direction='sent' AND to_person_ids LIKE '%'||?||'%') )
           ORDER BY ts""",
        (cid, cid),
    ).fetchall()

    his_latency, his_len, by_year = [], [], defaultdict(int)
    his_initiations = their_initiations = 0
    last = None  # (ts, direction)
    his_samples = []
    last_recv_ts = None
    for ts, direction, body in rows:
        d = parse_ts(ts)
        if not d:
            continue
        by_year[d.year] += 1
        # initiation: first message after a >6h silence
        if last and (d - last[0]).total_seconds() > 6 * 3600:
            if direction == "sent":
                his_initiations += 1
            else:
                their_initiations += 1
        last = (d, direction)
        if direction == "received":
            last_recv_ts = d
        elif direction == "sent":
            if last_recv_ts:
                gap = (d - last_recv_ts).total_seconds() / 60.0
                if 0 <= gap <= 60 * 24:
                    his_latency.append(gap)
                last_recv_ts = None
            if body and len(body) > 1:
                his_len.append(len(body))
                if len(his_samples) < sample_n and 3 < len(body) < 220:
                    his_samples.append(body.strip())

    total_init = his_initiations + their_initiations
    return {
        "msgs": len(rows),
        "his_median_reply_min": round(statistics.median(his_latency), 1) if his_latency else None,
        "his_pct_under_5min": round(100 * sum(1 for g in his_latency if g <= 5) / len(his_latency)) if his_latency else None,
        "his_initiation_ratio": round(his_initiations / total_init, 2) if total_init else None,
        "his_avg_msg_len": round(statistics.mean(his_len)) if his_len else None,
        "by_year": dict(sorted(by_year.items())),
        "his_samples": his_samples[: sample_n // 2],  # keep the LLM payload lean + less intrusive
    }


SYS = """You infer PERSONALITY from behavioral statistics across someone's closest relationships.
You are given, per contact, how the user behaves: reply speed, who initiates, message length,
volume trajectory over years, and a few of the user's own messages.

Personality is in the DIFFERENCES and SHIFTS, not any single number. Compare across relationships
(does he chase some and get chased by others? warm with whom, terse with whom?) and over time
(which relationships are growing, cooling, gone quiet?).

Output JSON:
{
  "patterns": [ {"pattern": "<behavioral regularity, <18 words>", "evidence": "<which contacts/numbers>"} ],   // 3-5
  "traits": [
     {"trait": "<character trait, <12 words>",
      "confidence": 0.0-1.0,
      "evidence": "<the patterns supporting it>",
      "counterevidence": "<what cuts against it — REQUIRED, be honest>",
      "prediction": "<a falsifiable near-term behavior this trait predicts>"}
  ]   // 2-3, only ones you'd stake a prediction on
}
Be a good detective, not a dumb one: a wrong trait is worse than no trait. Surface as hypothesis.
Return ONLY the JSON."""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--contacts", type=int, default=8)
    ap.add_argument("--sample", type=int, default=12)
    args = ap.parse_args()
    conn = sqlite3.connect(DB_RO, uri=True)

    contacts = top_contacts(conn, args.contacts)
    table = {}
    print(f"computing behavioral distributions across {len(contacts)} closest relationships...\n")
    for cid, name, tot in contacts:
        s = relationship_stats(conn, cid, args.sample)
        table[name] = s
        traj = "→".join(f"{y}:{n}" for y, n in list(s["by_year"].items())[-4:])
        print(f"  {name[:24]:24} {s['msgs']:6} msgs | reply {s['his_median_reply_min']}min "
              f"({s['his_pct_under_5min']}% <5min) | init {s['his_initiation_ratio']} | "
              f"len {s['his_avg_msg_len']} | {traj}")

    payload = json.dumps(table, ensure_ascii=False)[:14000]
    res = complete(model=MODEL, system=SYS, user=f"Behavioral distributions across closest relationships:\n{payload}", max_tokens=1600)

    print("\n" + "=" * 64)
    print("WHAT THE STATISTICS REVEAL (hypotheses, for you to confirm):")
    print("=" * 64)
    m = re.search(r"\{.*\}", res["text"], re.S)
    try:
        out = json.loads(m.group(0))
    except (json.JSONDecodeError, AttributeError):
        print(res["text"])
        return
    print("\nPATTERNS:")
    for p in out.get("patterns", []):
        print(f"  • {p.get('pattern')}")
        print(f"      ↳ {p.get('evidence')}")
    print("\nTRAITS (each with a falsifiable prediction):")
    for t in out.get("traits", []):
        print(f"  ◆ {t.get('trait')}  (confidence {t.get('confidence')})")
        print(f"      evidence:        {t.get('evidence')}")
        print(f"      counterevidence: {t.get('counterevidence')}")
        print(f"      → predicts:      {t.get('prediction')}")


if __name__ == "__main__":
    main()
