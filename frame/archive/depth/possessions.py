#!/usr/bin/env python3
"""POSSESSIONS — infer the devices / products / subscriptions Dennis actually owns, from email.

Mines TRANSACTIONAL email (receipts, orders, shipping, welcome/account emails) — NOT promotional —
and the LLM extracts a structured profile: devices (Oura? Whoop? Apple Watch? which?), subscriptions,
services he actually uses. Discovers HIS specifics (no fixed device list to check against).

The promo filter is the §13 data-quality rule: signal is transactional + personal; promo is noise.

SANDBOXED read-only on email; writes a profile to the vault (possessions.md).
Usage:  doppler run -- /…/substrate/.venv/bin/python3 possessions.py
"""
import json
import re
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, "/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/lib")
from llm import complete  # noqa: E402

DB_RO = "file:/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/state/substrate.db?mode=ro"
VAULT = Path("/Users/main/Projects/Secretary/Secretary-Production/.claude/memory")
MODEL = "claude-sonnet-4-6"

# Obvious promo to drop even if it slips past the transactional SQL filter (§13 promo rule).
PROMO = re.compile(r"(% off|\bsale\b|\bdeal\b|save \$|limited time|flash|clearance|don'?t miss|"
                   r"last chance|ends (tonight|today|soon)|new arrivals|shop now)", re.I)


def from_email(raw):
    m = re.search(r'"from_email"\s*:\s*"([^"]*)"', raw or "")
    return (m.group(1) if m else "").lower()


def main():
    conn = sqlite3.connect(DB_RO, uri=True)
    # Transactional signal only — receipts/orders/shipping/account/welcome. Promo rarely matches these.
    # Recent received (~last 2yr; archive goes back to 2011 so recency avoids a 2014 persona).
    # Aggregate by SENDER DOMAIN: frequency = engagement — a device/service that emails you weekly =
    # you own/use it (Oura insights, Whoop reports, a sleep app) EVEN when the subject never says
    # "receipt". Plus sample transactional subjects + a returned/refunded flag. Promo subjects dropped.
    rows = conn.execute(
        "SELECT raw_metadata, subject FROM communications "
        "WHERE channel='gmail' AND direction='received' AND ts > '2024-06'"
    ).fetchall()
    TXN = re.compile(r"(order|receipt|shipp|invoice|tracking|confirm|welcome to|subscription|renew|"
                     r"refund|return|trial|insight|recovery|sleep|readiness|workout|score)", re.I)
    SKIP_DOM = re.compile(r"(google|gmail|facebook|youtube|linkedin|nextdoor|twitter|instagram|reddit|quora)")
    agg = defaultdict(lambda: {"n": 0, "subs": [], "returned": False})
    for raw, subj in rows:
        subj = subj or ""
        if PROMO.search(subj):
            continue
        dom = from_email(raw).split("@")[-1]
        if not dom or SKIP_DOM.search(dom):
            continue
        d = agg[dom]
        d["n"] += 1
        if TXN.search(subj) and len(d["subs"]) < 4:
            d["subs"].append(subj[:90])
        if re.search(r"(refund|return)", subj, re.I):
            d["returned"] = True
    ranked = sorted(agg.items(), key=lambda kv: -kv[1]["n"])[:55]
    senders = {dom: {"emails": v["n"], "sample": v["subs"], "returned_signal": v["returned"]}
               for dom, v in ranked}

    # ACCESSORY/PRODUCT signal: order / review-request / shipped subjects NAME the specific product —
    # and an accessory reveals the DEVICE by implication (a watch band → an Apple Watch; an iPad case →
    # an iPad). This catches devices that were never bought directly on this account.
    prod_rows = conn.execute(
        "SELECT subject FROM communications WHERE channel='gmail' AND direction='received' AND ts > '2023-01' "
        "AND (lower(subject) LIKE '%order of%' OR lower(subject) LIKE '%meet your expectations%' "
        "OR lower(subject) LIKE '%has shipped%')"
    ).fetchall()
    products, seen = [], set()
    for (s,) in prod_rows:
        s = (s or "").strip()
        m = re.search(r'"([^"]+)"', s) or re.search(r"'([^']+)'", s)
        name = (m.group(1) if m else s)[:80]
        k = name.lower()
        if name and k not in seen:
            seen.add(k)
            products.append(name)
    # device/accessory products to the front so they survive truncation (they're the device signal)
    _dev = re.compile(r"watch|ipad|iphone|airpod|macbook|kindle|echo|ring|whoop|oura|galaxy|pixel|"
                      r"band|case|charger|strap|cover|screen|laptop|tablet|dock|mount", re.I)
    products.sort(key=lambda p: 0 if _dev.search(p) else 1)
    payload = {"recurring_senders": senders, "purchased_products": products[:65]}

    SYS = """You're given (1) recent email SENDERS aggregated by domain (each with an "emails" frequency
count, sample transactional subjects, and a returned_signal flag) and (2) a list of PURCHASED_PRODUCTS
(specific products they ordered). Promo is filtered out. Infer what they actually OWN and USE — SPECIFIC
products/devices/services (real brands), never categories.

FREQUENCY IS SIGNAL: a brand that emails them regularly (high "emails") = they own/use it, even when no
subject says "receipt" (Oura insights, Whoop recovery, a sleep app's digests, Apple). returned_signal=true
on a domain = they bought then returned/refunded it.

ACCESSORIES REVEAL DEVICES (read purchased_products this way): an accessory names the device by implication —
a watch BAND → they own that smartwatch (likely Apple Watch); an iPad/iPhone CASE → that device; an AirPods
case → AirPods; a charger/strap/cover/screen-protector → the thing it fits. INFER and NAME the device behind
each accessory, even when they never bought the device itself on this account. Mark it inferred.

Be a NOSY DETECTIVE — reason BEYOND the literal receipt:
- A sleep/recovery app or subscription (e.g. a Pillow/sleep-tracking app) implies they track sleep → so they
  likely own a sleep WEARABLE (Oura / Whoop / Apple Watch / Fitbit). Say which the evidence points to, and
  mark it inferred.
- A fitness/training subscription implies a tracker; a device-companion app implies that hardware; etc.
- Connect a curious subscription to what it reveals ("why subscribe to THIS? → therefore they have X").

Surface RETURNS / abandonment: if they bought then returned or refunded something (e.g. a Whoop), say so —
"had it, returned it." That's real signal about what they tried and rejected.

For devices: if a wearable/device brand appears, say WHICH one(s). Distinguish OWNS/USES from one-off or
abandoned. Include what the evidence supports — direct OR reasonably inferred (mark inferences).

HARD RULE: do NOT infer or state demographics — age, race, ethnicity, gender, religion, household status.
NONE of that is in receipts; guessing it is a trust-breaking false claim. Name ONLY products, devices,
services, spending patterns, and reasoned device-inferences. The "notable" line is a sharp read of their
POSSESSIONS pattern (named brands + the nosy inference), never a persona or demographic portrait.

Return ONLY JSON:
{"devices": ["e.g. 'Oura Ring (inferred from a sleep-app subscription)'"],
 "returned": ["things bought then returned/refunded"],
 "subscriptions": ["..."], "services": ["..."],
 "notable": "<1-2 lines: the nosy read — what the combination + curious subscriptions reveal. Named brands, NO demographics>"}"""

    res = complete(model=MODEL, system=SYS, user=json.dumps(payload), max_tokens=900)
    text = res["text"] if isinstance(res, dict) else str(res)
    m = re.search(r"\{.*\}", text, re.S)
    try:
        prof = json.loads(m.group(0))
    except (json.JSONDecodeError, AttributeError):
        print("⚠️ couldn't parse profile:\n" + text)
        return

    md = ["# Possessions / Devices (inferred from email — auto-generated)\n"]
    for section in ("devices", "returned", "subscriptions", "services"):
        items = prof.get(section) or []
        if items:
            md.append(f"## {section.capitalize()}")
            md += [f"- {x}" for x in items]
            md.append("")
    if prof.get("notable"):
        md.append(f"**Read:** {prof['notable']}")
    out = VAULT / "possessions.md"
    out.write_text("\n".join(md) + "\n")

    print(f"📦 possessions profile → {out}\n")
    print("\n".join(md))


if __name__ == "__main__":
    main()
