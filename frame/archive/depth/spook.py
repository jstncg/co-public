#!/usr/bin/env python3
"""
SPOOK — the trait-level equivalent of "smoke grey amber lamp shades."

Generic traits ("low follow-through") are horoscopes: true of everyone, spook no one.
The spook is a NAMED, SPECIFIC, idiosyncratic behavioral signature that would be FALSE
for most people. Not the psychological category — the particular, weird, undeniable
juxtaposition of things THIS person actually does.

Method: code surfaces the named specifics, all from the USER'S OWN BEHAVIOR (RECEIVING != DOING) —
  - what they FAITHFULLY ENGAGE WITH (subscriptions they actually OPEN, over years, still engaged)
  - what they STARTED AND ABANDONED (active for months then went absent / unsubscribed / they cancelled)
Then the LLM finds the single most specific juxtaposition that fails the
"applies-to-a-stranger" test. Named entities only. No psychology words.

RECEIVING != DOING (load-bearing): "abandoned" must be the user's ACTION, never a received email. A
"sorry to see you go" / "your trial ended" / "refund" message is something a COMPANY sent THEM — counting
it as "what he drops" is the exact receiving-is-not-doing bug the gate elsewhere retires claims for. So
abandonment is read from HIS disengagement (open-rate collapse on things he used to open + explicit
unsubscribes + outbound cancels he sent), never from a sender going quiet or a received cancel email.
"Kept" is read from real ENGAGEMENT (opens), never raw received volume (= inbox noise).

SANDBOXED read-only.
Usage: python3 spook.py
"""

import json
import re
import sqlite3
import sys

sys.path.insert(0, "/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/lib")
from llm import complete  # noqa: E402

DB_RO = "file:/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/state/substrate.db?mode=ro"
MODEL = "claude-sonnet-4-6"
NOISE = re.compile(r"(facebook|google|apple|linkedin|youtube|amazon|nextdoor|instagram|x\.com|twitter)", re.I)
# Explicit cancellation language — ONLY ever applied to OUTBOUND mail (mail the user wrote = a DOING signal).
OUTBOUND_CANCEL = re.compile(r"(cancel|unsubscribe|close my account|end my (subscription|membership)|stop my)", re.I)


def main():
    conn = sqlite3.connect(DB_RO, uri=True)

    def q(sql, params=()):
        try:
            return conn.execute(sql, params).fetchall()
        except Exception:
            return []

    # FAITHFULLY ENGAGED — what he actually OPENS, faithfully, over a long span, still engaging now.
    # Engagement (opens), not receipt: a newsletter that arrives 5000x and is never opened is noise, not loyalty.
    kept = []
    for name, dom, recv, opened, first_seen, last_eng in q(
        "SELECT sender_name, sender_domain, total_received, total_opened, first_seen, last_engagement "
        "FROM subscriptions WHERE total_opened >= 12"):
        label = (name or dom or "").strip()
        if not label or NOISE.search(label) or NOISE.search(dom or ""):
            continue
        span = ((last_eng or "")[:7] and (first_seen or "")[:7]) and f"{(first_seen or '')[:7]}→{(last_eng or '')[:7]}"
        # long relationship + still engaging in the last ~12 months
        if (first_seen or "") <= "2025-06" and (last_eng or "") >= "2025-06":
            kept.append((int(opened or 0), label, span or "", int(recv or 0)))
    kept.sort(reverse=True)

    # STARTED & ABANDONED — HIS disengagement, never the sender going quiet. Two honest signals:
    #  (1) subscriptions he engaged with early (opened) then STOPPED opening — his own open behavior dropped
    #  (2) senders he explicitly UNSUBSCRIBED from — his action.
    # Deliberately EXCLUDES absent_signals kind='sender_gone_silent'/'topic_ceased': those are the COMPANY's
    # choice to stop sending, not his choice to abandon — counting them is the same receiving≠doing trap.
    abandoned = []
    for name, dom, recv, opened, last_eng in q(
        "SELECT sender_name, sender_domain, total_received, total_opened, last_engagement FROM subscriptions "
        "WHERE total_received >= 30 AND total_opened >= 3 "
        "AND CAST(total_opened AS REAL)/total_received < 0.15 AND COALESCE(last_engagement,'') < '2025-09' "
        "ORDER BY total_received DESC LIMIT 18"):
        label = (name or dom or "").strip()
        if not label or NOISE.search(label) or NOISE.search(dom or ""):
            continue
        abandoned.append(f"{label} — opened {opened} of {recv}, then stopped (last engaged {(last_eng or '')[:7]})")
    for ref, last_active in q(
        "SELECT subject_ref, last_active_at FROM absent_signals WHERE kind='unsubscribe' "
        "ORDER BY last_active_at DESC LIMIT 10"):
        r = (ref or "").strip()
        if r and not NOISE.search(r):
            abandoned.append(f"unsubscribed from {r} ({(last_active or '')[:7]})")

    # EXPLICIT OUTBOUND CANCELLATIONS — mail HE sent to cancel/unsubscribe (unambiguous doing).
    explicit = []
    for subj, body in q("SELECT subject, substr(body,1,200) FROM communications "
                        "WHERE direction='sent' AND ts IS NOT NULL ORDER BY ts DESC LIMIT 4000"):
        text = f"{subj or ''} {body or ''}"
        if OUTBOUND_CANCEL.search(text):
            explicit.append((subj or body or "")[:70])
        if len(explicit) >= 10:
            break

    print("FAITHFULLY ENGAGED (opens, long span, still engaging) — what he actually keeps up with:")
    for opened, label, span, recv in kept[:20]:
        print(f"  {opened:5} opens  {label:34} {span}")
    print("\nSTARTED & ABANDONED (behavioral lapse — HIS action, not received mail):")
    for a in abandoned[:15]:
        print(f"  {a}")
    if explicit:
        print("\nEXPLICITLY CANCELLED (mail he SENT):")
        for e in explicit:
            print(f"  {e}")

    payload = {
        "faithfully_engaged": [f"{label} ({opened} opens, {span})" for opened, label, span, recv in kept[:20]],
        "abandoned": abandoned[:15],
        "explicitly_cancelled": explicit,
    }

    SYS = """You are given three behavioral lists about a person: what they FAITHFULLY ENGAGE WITH (actually
open/use for years), what they STARTED AND ABANDONED (was active for a long stretch, then lapsed), and what
they EXPLICITLY CANCELLED (mail they themselves sent). All three are the person's OWN behavior, not mail sent
to them.

Produce the single most SPOOKY-SPECIFIC observation about this person — the trait-level equivalent
of correctly naming an obscure thing they bought. It must:
  - name the ACTUAL specific things (the real services/brands), not categories
  - be a juxtaposition or pattern that would be FALSE for most random people (fails the
    "applies to a stranger" test)
  - be undeniably true given the data, and make them think "...how do you know that about me"
  - use ZERO psychology-jargon words (no "follow-through", "novelty-seeking", "conscientious").
    Describe the BEHAVIOR with its real nouns.

Return JSON: { "spook": "<2-3 sentences, named specifics, no jargon>",
               "why_it_lands": "<one line: what makes this not-generic>" }
Pick the weirdest TRUE thing, not the safest. Return ONLY JSON."""

    res = complete(model=MODEL, system=SYS, user=json.dumps(payload), max_tokens=600)
    print("\n" + "=" * 64)
    print("THE SPOOK:")
    print("=" * 64)
    m = re.search(r"\{.*\}", res["text"], re.S)
    try:
        out = json.loads(m.group(0))
        print("\n" + out.get("spook", ""))
        print(f"\n  (why it lands: {out.get('why_it_lands','')})")
    except (json.JSONDecodeError, AttributeError):
        print(res["text"])


if __name__ == "__main__":
    main()
