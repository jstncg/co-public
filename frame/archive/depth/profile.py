#!/usr/bin/env python3
"""PROFILE — understand the user deeply from email METADATA alone. Deterministic, no LLM, can't hallucinate.

Leads with the spooky one: WHAT YEAR DID YOU STOP READING YOUR EMAIL — read-rate (read vs UNREAD) bucketed
by year; the year it collapses and stays down = email bankruptcy. Plus: how much you read now, inbox volume
over time, are-you-an-Apple-user, and who you actually read vs. ignore. Pure arithmetic on Gmail labels +
dates — the precise half of the email-profile questionnaire (§14).

SANDBOXED read-only on email; writes vault/profile.md.  Usage: python3 profile.py
"""
import json
import re
import sqlite3
from collections import defaultdict
from pathlib import Path

DB_RO = "file:/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/state/substrate.db?mode=ro"
VAULT = Path("/Users/main/Projects/Secretary/Secretary-Production/.claude/memory")
MIN_YEAR_VOL = 50   # ignore years with too little mail to be meaningful


def _meta(raw):
    try:
        return json.loads(raw)
    except Exception:
        return {}


def main():
    conn = sqlite3.connect(DB_RO, uri=True)
    rows = conn.execute(
        "SELECT ts, raw_metadata FROM communications "
        "WHERE channel='gmail' AND direction='received' AND ts IS NOT NULL"
    ).fetchall()

    yr = defaultdict(lambda: {"total": 0, "read": 0})
    dom = defaultdict(lambda: {"total": 0, "read": 0})
    apple = 0
    for ts, raw in rows:
        y = ts[:4]
        m = _meta(raw)
        read = "UNREAD" not in set(m.get("labels") or [])
        yr[y]["total"] += 1
        yr[y]["read"] += read
        d = (m.get("from_email") or "").split("@")[-1].lower()
        if d:
            dom[d]["total"] += 1
            dom[d]["read"] += read
            if re.search(r"(apple\.com|icloud\.com|@apple|email\.apple)", d):
                apple += 1

    years = sorted(y for y in yr if yr[y]["total"] >= MIN_YEAR_VOL)
    rate = {y: yr[y]["read"] / yr[y]["total"] for y in years}

    # --- stopped-reading-year: first year read-rate falls below 40% and STAYS down (avg rest < 45%) ---
    collapse = None
    for i, y in enumerate(years):
        if rate[y] < 0.40 and (i == 0 or rate[years[i - 1]] >= 0.40):
            rest = [rate[z] for z in years[i:]]
            if sum(rest) / len(rest) < 0.45:
                collapse = y
                break

    peak_y = max(years, key=lambda y: rate[y]) if years else None
    recent = years[-1] if years else None

    L = ["# Email Profile (from metadata — deterministic, auto-generated)\n"]
    L.append("## When you stopped reading your email")
    if collapse:
        L.append(f"**You stopped keeping up with your inbox in {collapse}.** Read-rate went from "
                 f"~{rate[peak_y]*100:.0f}% (peak, {peak_y}) to ~{rate[recent]*100:.0f}% now ({recent}). "
                 f"That's the year the inbox won.")
    elif recent:
        L.append(f"You still mostly keep up — ~{rate[recent]*100:.0f}% read in {recent}. No bankruptcy year.")
    L.append("\n_read-rate by year:_")
    for y in years:
        bar = "█" * round(rate[y] * 20)
        L.append(f"  {y}  {rate[y]*100:5.0f}%  {bar}  ({yr[y]['read']}/{yr[y]['total']})")

    total_all = sum(yr[y]["total"] for y in years)
    read_all = sum(yr[y]["read"] for y in years)
    L.append(f"\n## How much you read\nLifetime: {read_all/total_all*100:.0f}% of received email "
             f"({read_all:,}/{total_all:,}). This year: ~{rate[recent]*100:.0f}%.")

    L.append("\n## Inbox volume over time")
    for y in years:
        L.append(f"  {y}  {yr[y]['total']:>6,} emails")

    L.append(f"\n## Apple user?\n{'YES' if apple > 200 else ('likely' if apple > 30 else 'weak signal')} "
             f"— {apple:,} emails from Apple/iCloud domains.")

    # who you actually read vs ignore (high-volume senders, by read-rate)
    big = [(d, v) for d, v in dom.items() if v["total"] >= 40]
    big.sort(key=lambda x: -x[1]["total"])
    reads = sorted(big, key=lambda x: -(x[1]["read"] / x[1]["total"]))[:8]
    ignores = sorted(big, key=lambda x: (x[1]["read"] / x[1]["total"]))[:8]
    L.append("\n## Who you actually read (high-volume senders, top read-rate)")
    for d, v in reads:
        L.append(f"  {v['read']/v['total']*100:3.0f}%  {d}  ({v['total']})")
    L.append("\n## Who you ignore (high-volume, lowest read-rate)")
    for d, v in ignores:
        L.append(f"  {v['read']/v['total']*100:3.0f}%  {d}  ({v['total']})")

    out = VAULT / "profile.md"
    out.write_text("\n".join(L) + "\n")
    print(f"📊 email profile → {out}\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
