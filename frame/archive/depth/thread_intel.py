#!/usr/bin/env python3
"""Thread-intelligence reader — a new level of contextual understanding of an email thread.

Two layers, both AVOIDING lossy content-extraction:
  1. DETERMINISTIC behavioral-meta (can't hallucinate): reply latency, read-but-never-replied, who went
     quiet, time-of-day, cadence, gaps. The subtle signal the claim pipeline throws away.
  2. RLM-style DEEP READ of the raw thread: the subtext, the relationship dynamic, what the user is
     doing/avoiding — the "dimple read." Surfaced TENTATIVELY (nosy in noticing, humble in claiming) —
     the whole point is to feel HEARD, not surveilled.

Reconstructs the real back-and-forth via thread_id (sent + received). One hypothesis: run on a correspondent.

  doppler run -- /…/python3 thread_intel.py [correspondent_email]
"""
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, "/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/lib")
from llm import complete  # noqa: E402

DB = "file:/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/state/substrate.db?mode=ro"
MODEL = "claude-sonnet-4-6"


def fetch_thread(corr):
    c = sqlite3.connect(DB, uri=True)
    tids = [r[0] for r in c.execute(
        "SELECT DISTINCT thread_id FROM communications WHERE channel='gmail' AND thread_id IS NOT NULL "
        "AND direction='received' AND json_extract(raw_metadata,'$.from_email')=?", (corr,)).fetchall()]
    if not tids:
        return []
    q = ",".join("?" * len(tids))
    rows = c.execute(
        f"SELECT ts, direction, subject, substr(body,1,500), raw_metadata FROM communications "
        f"WHERE thread_id IN ({q}) ORDER BY ts", tids).fetchall()
    return rows


def behavioral_meta(rows):
    """Deterministic — can't hallucinate."""
    sends = [r for r in rows if r[1] == "sent"]
    recvs = [r for r in rows if r[1] == "received"]
    # reply latencies: a received msg followed by a sent msg
    lat = []
    for i in range(len(rows) - 1):
        if rows[i][1] == "received" and rows[i + 1][1] == "sent":
            try:
                a = datetime.fromisoformat(rows[i][0]); b = datetime.fromisoformat(rows[i + 1][0])
                lat.append((b - a).total_seconds() / 3600.0)
            except ValueError:
                pass
    # read-but-never-replied: received messages with UNREAD absent and no sent after them at thread end
    last = rows[-1]
    span_days = 0
    try:
        span_days = (datetime.fromisoformat(rows[-1][0]) - datetime.fromisoformat(rows[0][0])).days
    except ValueError:
        pass
    # send hours (time-of-day)
    hours = []
    for r in sends:
        try:
            hours.append(datetime.fromisoformat(r[0]).hour)
        except ValueError:
            pass
    late = sum(1 for h in hours if h >= 22 or h <= 5)
    med_lat = sorted(lat)[len(lat) // 2] if lat else None
    out = [f"messages: {len(rows)} ({len(sends)} sent / {len(recvs)} received) over {span_days} days",
           f"reply latency: median {med_lat:.1f}h, max {max(lat):.1f}h" if lat else "reply latency: n/a",
           f"last message: {last[1].upper()} on {last[0][:10]} — {'YOU went quiet' if last[1]=='received' else 'they went quiet / you had the last word'}",
           f"your send times: {late}/{len(hours)} late-night (10pm-5am)" if hours else ""]
    return "\n".join(x for x in out if x), lat


def main():
    corr = sys.argv[1] if len(sys.argv) > 1 else "someone@example.com"
    rows = fetch_thread(corr)
    if not rows:
        print(f"no thread found with {corr}"); return
    meta, lat = behavioral_meta(rows)
    print(f"=== THREAD-INTELLIGENCE: {corr} ===\n")
    print("BEHAVIORAL META (deterministic):\n" + meta + "\n")

    transcript = "\n".join(
        f"[{r[0][:16]}] {'DENNIS' if r[1]=='sent' else corr.split('@')[0].upper()}: {(r[2] or '')[:60]} | {(r[3] or '').strip()[:300]}"
        for r in rows)

    SYS = """You read one email thread between Dennis and another person — the RAW back-and-forth plus the
behavioral metadata (reply latency, who went quiet, timing). Produce the DIMPLE READ: the subtext and the
relationship dynamic that a perceptive friend would notice — what's REALLY going on here, what Dennis is
doing or avoiding, the emotional/strategic undercurrent.

DISCIPLINE (this is what makes it land as 'heard' not 'surveilled'):
- Be nosy in NOTICING, humble in CLAIMING. Surface as observation ("I notice…", "it reads like…"), never
  asserted motive ("you are…"). Tentative on anything interpretive.
- Ground every read in specific evidence from the thread or the behavioral meta. No free-floating psychology.
- The payoff is making Dennis feel SEEN — name the thing he felt but didn't say. 1 sharp paragraph, then
  2-3 specific noticings. Plain text, warm, direct."""

    res = complete(model=MODEL, system=SYS, max_tokens=600,
                   user=f"BEHAVIORAL META:\n{meta}\n\nTHREAD (chronological):\n{transcript[:9000]}")
    txt = res["text"] if isinstance(res, dict) else str(res)
    print("THE DIMPLE READ (RLM over the raw thread, tentative):\n" + txt)


if __name__ == "__main__":
    main()
