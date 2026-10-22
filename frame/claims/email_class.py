#!/usr/bin/env python3
"""Email classifier — the RECEIVING vs DOING gate (code-enforced integrity).

Empirically grounded: of 244 Codecademy emails, only 3 were transactional (doing) — the other 241 were
marketing the user never acted on. A prompt rule ("RECEIVING ≠ DOING") wasn't enough; the graph still
manufactured "actively job searching." So we classify each email DETERMINISTICALLY and forbid behavioral
claims from inbound-push email in CODE, not in the prompt.

The axis that matters: did the user INITIATE/transact (real behavioral evidence) or did this just LAND in
their inbox (marketing / job-alerts / newsletters = receiving, not doing)?

Conservative by design — we only flag `receiving` on an AFFIRMATIVE push-signal (promo/alert/digest), so
notifications about the user's OWN actions (a GitHub PR, a Linear ticket, a Vercel deploy) still flow through
as behavioral evidence. Default = behavioral-OK (don't over-suppress).

  classify(subject, sender) -> (label, is_receiving)
"""
import re

TRANSACTIONAL = re.compile(
    r"(receipt|order\s*(#|confirm|placed|shipped|delivered|is on its way|has shipped)|your\s+(statement|invoice|"
    r"payment|booking|reservation|itinerary|e-?ticket|refund)|payment\s+(received|confirmation|due|successful|failed)|"
    r"invoice|verif(y|ication)|your\s+(code|otp)|confirm your|welcome to|you'?re (in|all set)|reservation confirmed|"
    r"\bcompleted\b|certificate of|submission received|thanks for your (order|purchase|payment|booking|sign)|"
    r"out for delivery|has shipped|appointment|you signed up|you registered|your (course|lesson|streak|progress))", re.I)
ALERT = re.compile(
    r"(job alert|jobs? (for you|matching|near you)|\d+\s*new jobs?|recommended for you|matching your|"
    r"people (viewed|searched|you may know)|see who|who'?s hiring|new (matches|opportunities|connections)|"
    r"application (status|update)|alerts? (for|you)|\bsuggested\b|you might (like|be interested))", re.I)
PROMO = re.compile(
    r"(%\s*off|\d+%\s*(off|back)|\bsale\b|\bdeal(s)?\b|save \$|save \d+%|limited time|flash sale|clearance|"
    r"don'?t miss|last chance|ends (tonight|today|soon|in)|new arrivals|shop now|just dropped|exclusive offer|"
    r"free trial|upgrade (now|today)|claim your|biggest sale|black friday|cyber monday|% discount|coupon|"
    r"promo code|expires|\boffer\b|new(:| course)|introducing|get \d+%)", re.I)
DIGEST = re.compile(
    r"(newsletter|\bdigest\b|weekly (update|recap|roundup|digest)|this week in|top (stories|posts)|\btrending\b|"
    r"daily brief|your \w+ (update|recap|year)|in case you missed|read of the (day|week)|edition\b|\bbulletin\b)", re.I)
SENDER_PUSH = re.compile(r"(marketing|newsletter|promotions?@|deals?@|offers?@|news@|noreply.*marketing)", re.I)


def classify(subject: str, sender: str = ""):
    """Returns (label, is_receiving). Transactional wins ties (a 'Your statement' from a promo sender is a
    real action). Only affirmative push-signals set receiving=True; everything else defaults behavioral-OK."""
    s = subject or ""
    f = sender or ""
    if TRANSACTIONAL.search(s):
        return ("transactional", False)
    if ALERT.search(s):
        return ("alert", True)
    if PROMO.search(s):
        return ("promo", True)
    if DIGEST.search(s):
        return ("newsletter", True)
    if SENDER_PUSH.search(f):
        return ("promo", True)
    return ("unknown", False)


# --- the code-enforced rule (used by the extractor) ---
# A claim whose evidence is ENTIRELY receiving-class email may NOT assert behavior/identity — only receipt.
BEHAVIORAL = re.compile(
    r"\b(uses?|owns?|has\b|holds?|drives?|stud(y|ies|ying)|learn(s|ing|ed)?|works? (at|on|as|in|for)|"
    r"practic(e|ing|es)|train(s|ing)?|appl(y|ies|ying)|actively|building|builds?|plays?|attends?|"
    r"member of|enrolled|takes? (a )?course|coding|codes?|job\s*search|is an?\b|interested in|wants?)\b", re.I)
RECEIVING_FRAMED = re.compile(
    r"\b(receives?|subscribed|on (the )?[\w' ]{0,24}list|gets? [\w ]*(emails?|alerts?|newsletter|promotions?|"
    r"digest|recommendations?)|signed up (for|to) [\w ]*(newsletter|marketing|alerts?|list|promotions?))\b", re.I)


def receiving_violation(statement: str) -> bool:
    """True if a claim sourced only from receiving-email asserts DOING/identity instead of mere receipt."""
    st = statement or ""
    return bool(BEHAVIORAL.search(st)) and not RECEIVING_FRAMED.search(st)


if __name__ == "__main__":
    tests = [
        ("Get 50% off Codecademy Pro", "no-reply@codecademy.com"),
        ("Job alert: 5 new Software Engineer roles", "jobalerts@linkedin.com"),
        ("Your SoFi banking statement is available", "no-reply@sofi.com"),
        ("X opened a pull request in your repo", "notifications@github.com"),
        ("Beta Update (Mar 30) — Hackathon & Raising Capital", "team@betauniversity.com"),
        ("Your order has shipped", "ship@amazon.com"),
    ]
    for subj, snd in tests:
        lbl, rec = classify(subj, snd)
        print(f"  {'RECV' if rec else 'OK  '} [{lbl:13}] {subj[:50]}")
