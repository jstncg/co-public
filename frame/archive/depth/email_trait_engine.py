#!/usr/bin/env python3
"""
EMAIL-ONLY TRAIT ENGINE — can straight Gmail reach personality, not just facts?

iMessage gives RELATIONAL personality (how you treat people). Email can't — you don't
talk to people there. But email holds something iMessage can't: your ASPIRATION and your
ACTUAL behavior in one place.

  - ASPIRATION = what you let into your inbox / subscribe to / sign up for
                 (newsletters, courses, gym, tools, communities). Who you want to be.
  - ACTUAL     = what you BUY (receipts), what you OPEN (Gmail read labels),
                 what you KEEP vs CANCEL. Who you are.

The GAP between them is personality — and it's the deepest rung (aspirational vs actual
self). "You subscribe to N productivity tools and your receipts show you cancel most within
a month" is a trait, from email alone, inbox-only.

Method: code computes exposure / engagement / action per life-category; LLM infers
consumer-execution traits + the gap, with evidence, counterevidence, confidence, and a
falsifiable prediction. SANDBOXED read-only.

Usage: python3 email_trait_engine.py
"""

import json
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime

sys.path.insert(0, "/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/lib")
from llm import complete  # noqa: E402

DB_RO = "file:/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/state/substrate.db?mode=ro"
MODEL = "claude-sonnet-4-6"
NOW = datetime(2026, 5, 20)

# life-category buckets, matched against sender domain + subject/body keywords
CATS = {
    "intellectual/newsletters": r"(substack|beehiiv|newsletter|ben thompson|stratechery|lenny|every\.to|the atlantic|new yorker)",
    "productivity/tools": r"(notion|linear|superhuman|todoist|roam|obsidian|figma|zapier|airtable|calendly|reclaim)",
    "fitness/health": r"(gym|fitness|peloton|strava|whoop|equinox|barry|crossfit|nutrition|protein|myfitnesspal)",
    "learning/courses": r"(coursera|udemy|udacity|masterclass|course|bootcamp|edx|brilliant|duolingo|certification)",
    "finance/investing": r"(robinhood|coinbase|schwab|webull|fidelity|wealthfront|angellist|sydecar|carta|stripe|mercury)",
    "shopping/fashion": r"(amazon|nike|stockx|ssense|nordstrom|uniqlo|zara|hollister|pacsun|tillys|cottonon|bloomingdale)",
    "food/delivery": r"(doordash|ubereats|grubhub|postmates|caviar|sweetgreen|chipotle|yelp)",
    "social/events": r"(luma|partiful|eventbrite|meetup|dice\.fm|posh)",
    "career/networking": r"(linkedin|glassdoor|wellfound|ycombinator|on deck|recruiter|hiring)",
}


def from_email(raw):
    m = re.search(r'"from_email"\s*:\s*"([^"]*)"', raw or "")
    return (m.group(1) if m else "").lower()


def labels(raw):
    try:
        return json.loads(raw).get("labels", [])
    except (json.JSONDecodeError, TypeError):
        return []


def rweight(ts):
    try:
        months = (NOW - datetime.fromisoformat(ts[:19])).days / 30.0
    except (ValueError, TypeError):
        return 0.5
    return 3.0 if months <= 12 else 1.5 if months <= 24 else 0.7


CANCEL = re.compile(r"(cancel|refund|return|subscription has ended|won.t renew|sorry to see you go|membership expired|trial (has )?ended)", re.I)
AMOUNT = re.compile(r"\$\s?(\d[\d,]*\.\d{2})")


def main():
    conn = sqlite3.connect(DB_RO, uri=True)
    rows = conn.execute(
        "SELECT ts, raw_metadata, subject, substr(body,1,400) FROM communications "
        "WHERE channel='gmail' AND direction='received' AND body IS NOT NULL"
    ).fetchall()

    # per category: exposure (recency-wt volume), engagement (read rate), action (purchase $), abandonment (cancel/refund)
    expo = defaultdict(float)
    read = defaultdict(lambda: [0, 0])      # [opened, total]
    spend = defaultdict(float)
    abandon = defaultdict(int)
    for ts, raw, subj, body in rows:
        text = f"{from_email(raw)} {subj or ''} {body or ''}".lower()
        w = rweight(ts)
        for cat, pat in CATS.items():
            if re.search(pat, text):
                expo[cat] += w
                read[cat][1] += 1
                if "UNREAD" not in labels(raw):
                    read[cat][0] += 1
                if ts > "2024-05-01":
                    amts = [float(a.replace(",", "")) for a in AMOUNT.findall(body or "")]
                    if amts and ("order" in text or "receipt" in text or "purchase" in text or "payment" in text):
                        spend[cat] += min(max(amts), 2000)   # clamp; ignore balances
                if CANCEL.search(text):
                    abandon[cat] += 1
                break

    # his sparse outbound: who he writes (ambition / self-presentation)
    sent = conn.execute("SELECT raw_metadata FROM communications WHERE channel='gmail' AND direction='sent'").fetchall()
    out_dom = defaultdict(int)
    for (raw,) in sent:
        m = re.search(r'"to[_a-z]*"\s*:\s*"([^"]*)"', raw or "")
        if m and "@" in m.group(1):
            out_dom[m.group(1).split("@")[-1].lower()] += 1

    table = {}
    for cat in CATS:
        o, t = read[cat]
        table[cat] = {
            "exposure_wt": round(expo[cat]),
            "read_rate_pct": round(100 * o / t) if t else None,
            "purchase_$_24mo": round(spend[cat]),
            "cancel_refund_signals": abandon[cat],
        }
    summary = {
        "categories": table,
        "his_outbound_total": len(sent),
        "his_top_recipient_domains": dict(sorted(out_dom.items(), key=lambda x: -x[1])[:8]),
    }

    print("EMAIL-ONLY BEHAVIORAL TABLE (exposure vs engagement vs action):\n")
    for cat, d in sorted(table.items(), key=lambda x: -x[1]["exposure_wt"]):
        print(f"  {cat:26} exposure {d['exposure_wt']:5} | read {str(d['read_rate_pct'])+'%':>5} "
              f"| bought ${d['purchase_$_24mo']:>6} | cancels {d['cancel_refund_signals']}")

    SYS = """You infer personality from the GAP between what someone is EXPOSED to / subscribes to
(aspiration) and what they actually READ, BUY, and KEEP (behavior) — from email alone.

The signal is the DELTA:
- High exposure + low read rate + no purchase = ASPIRATIONAL/FANTASY self (wants to be, isn't)
- Low exposure + high purchase = ACTUAL self (does it without performing it)
- High exposure + high purchase + high cancels = NOVELTY-SEEKING, low follow-through
- Sustained purchase + low cancels = genuine commitment

Output JSON:
{ "gap": "<one sentence: aspirational self vs actual self>",
  "traits": [ {"trait":"<<12 words>", "confidence":0-1, "evidence":"<categories+numbers>",
               "counterevidence":"<honest>", "prediction":"<falsifiable>"} ] }   // 2-3
Email cannot see relationships or emotion — do NOT infer those. Only consumer/execution/identity
traits the data supports. Be a good detective. Return ONLY JSON."""

    res = complete(model=MODEL, system=SYS, user=json.dumps(summary), max_tokens=1400)
    print("\n" + "=" * 64)
    print("PERSONALITY FROM STRAIGHT EMAIL (hypotheses):")
    print("=" * 64)
    m = re.search(r"\{.*\}", res["text"], re.S)
    try:
        out = json.loads(m.group(0))
    except (json.JSONDecodeError, AttributeError):
        print(res["text"]); return
    print(f"\nTHE GAP: {out.get('gap')}\n")
    for t in out.get("traits", []):
        print(f"  ◆ {t.get('trait')}  (confidence {t.get('confidence')})")
        print(f"      evidence:        {t.get('evidence')}")
        print(f"      counterevidence: {t.get('counterevidence')}")
        print(f"      → predicts:      {t.get('prediction')}\n")


if __name__ == "__main__":
    main()
