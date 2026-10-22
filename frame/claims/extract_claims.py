#!/usr/bin/env python3
"""Extract claims from email → the claim store (SUBSTRATE_PLAN v0.1).

Pulls recent emails from substrate.db, batches them through a cheap model, and writes typed claims
(possession/routine/relationship/preference/obligation/identity/frame) with confidence + evidence.
This is the v0 engines (profile/possessions/scrummage) collapsed into one coordinated extractor that
writes to the shared, auditable claim store.

Model: Haiku via the OAuth subscription token (what donna_warm uses; known-good). For the FULL 150k-email
run, swap MODEL to Qwen-on-Modal / Gemini Flash Lite (cheap-bulk) — one line. v0.1 proves the store on a
sample first; don't block on standing up Modal.

  doppler run -- /…/substrate/.venv/bin/python3 extract_claims.py [N]
"""
import asyncio
import json
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from claimstore import connect, upsert, dump_markdown
from anthro import make_client  # OAuth client — known-good with the subscription token
from email_class import classify, receiving_violation  # the RECEIVING vs DOING gate (code-enforced)

SUBSTRATE_DB = "file:/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/state/substrate.db?mode=ro"
VAULT = Path("/Users/main/Projects/Secretary/Secretary-Production/.claude/memory")
MODEL = "claude-haiku-4-5"   # cheap-bulk for v0.1; swap to Qwen-on-Modal / Gemini Flash Lite for full 150k
BATCH = 25                   # emails per LLM call
PROMO = re.compile(r"(% off|\bsale\b|\bdeal\b|save \$|limited time|flash|clearance|don'?t miss|"
                   r"last chance|ends (tonight|today|soon)|new arrivals|shop now|unsubscribe)", re.I)

SYS = """You extract AUDITABLE CLAIMS about a person from a batch of their emails. Output only what the
evidence supports — this is a belief store, not a guess store.

For each claim, give: type, level, statement, confidence (0-1), and which email(s) support it (by index).

type: possession | routine | relationship | preference | obligation | identity | frame | other
level (CRITICAL):
  fact    — concrete, directly evidenced ("owns an Apple Watch" from a watch-band order)
  pattern — behavior repeated across emails ("orders DoorDash most weeknights")
  frame   — interpretive read of who they are / what they avoid. DANGEROUS.

HARD RULES:
- RECEIVING ≠ DOING (the integrity rule). Inbound email the user RECEIVES — job ALERTS, newsletters,
  marketing, recommendations, "jobs matching your alerts", digests — is NOT evidence they DO the implied
  action. LinkedIn/Indeed/Resume-Library job alerts do NOT mean "actively job searching". A newsletter
  about X does NOT mean they practice X. At most: "receives X alerts" / "subscribed to X" (low confidence).
  Active-behavior claims ("actively job searching", "applying to jobs", "training for a marathon") require
  evidence they INITIATED the action (a confirmation, receipt, sent action), not that something landed in
  their inbox. When the only evidence is passive inbound, confidence ≤ 0.35 and phrase it as receipt, not action.
- ⟨RECEIVING⟩ TAG IS LAW. Emails prefixed ⟨RECEIVING⟩ are deterministically-classified inbound push
  (marketing/alerts/digests). From a ⟨RECEIVING⟩ email you may emit ONLY a "subscribed to / receives X from
  {sender}" claim (type preference/other, confidence ≤ 0.35) — NEVER "uses/owns/studies/works/learning/is a".
  A claim supported only by ⟨RECEIVING⟩ emails that asserts behavior or identity will be DROPPED in code.
- NEVER infer demographics (age/race/gender/religion/household). Not in emails; guessing breaks trust.
- frame-level claims: phrase TENTATIVELY ("possibly...", "may..."), confidence ≤ 0.5, only when a real
  pattern supports it. When unsure, DON'T emit a frame claim.
- ACCESSORIES REVEAL DEVICES: a watch band → they own that smartwatch; an iPad case → an iPad. Infer the
  device, mark it a fact with the accessory as evidence.
- confidence calibration: receipt/order = high (0.85+), account/welcome = 0.7, recurring sender = 0.6,
  single marketing-adjacent mention = ≤0.4. Be honest; low confidence is fine.
- Skip pure promotional noise. Extract the SIGNAL.

Return ONLY JSON: {"claims":[{"type","level","statement","confidence","evidence_idx":[int,...]}]}"""


def fetch(n):
    conn = sqlite3.connect(SUBSTRATE_DB, uri=True)
    rows = conn.execute(
        "SELECT ts, raw_metadata, subject FROM communications "
        "WHERE channel='gmail' AND direction='received' AND ts > '2024-06' AND subject IS NOT NULL "
        "ORDER BY ts DESC LIMIT ?", (n,)).fetchall()
    out = []
    for ts, raw, subj in rows:
        m = re.search(r'"from_email"\s*:\s*"([^"]*)"', raw or "")
        frm = (m.group(1) if m else "")
        label, receiving = classify(subj or "", frm)
        if label == "promo":
            continue  # blatant marketing — near-zero signal (Codecademy 244→3), skip for cost
        out.append({"date": (ts or "")[:10], "from": frm, "subject": (subj or "")[:120],
                    "receiving": receiving, "class": label})
    return out


async def run_batch(client, emails, base_idx):
    listing = "\n".join(
        f"[{base_idx+i}] {'⟨RECEIVING⟩ ' if e.get('receiving') else ''}{e['date']} | {e['from']} | {e['subject']}"
        for i, e in enumerate(emails))
    r = await client.messages.create(model=MODEL, system=SYS, max_tokens=2000,
                                     messages=[{"role": "user", "content": "EMAILS:\n" + listing}])
    txt = "".join(b.text for b in r.content if b.type == "text")
    m = re.search(r"\{.*\}", txt, re.S)
    if not m:
        return []
    try:
        return json.loads(m.group(0)).get("claims", [])
    except json.JSONDecodeError:
        return []


async def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
    emails = fetch(n)
    print(f"📥 {len(emails)} non-promo emails (most recent {n}). Extracting via {MODEL} in batches of {BATCH}...")
    client = make_client()
    conn = connect()

    batches = [(i, emails[i:i+BATCH]) for i in range(0, len(emails), BATCH)]
    # modest concurrency — be a good citizen
    sem = asyncio.Semaphore(5)

    async def do(base, chunk):
        async with sem:
            try:
                return base, chunk, await run_batch(client, chunk, base)
            except Exception as e:
                print(f"  ⚠️ batch {base}: {e}")
                return base, chunk, []

    results = await asyncio.gather(*[do(b, c) for b, c in batches])
    total = dropped = capped = 0
    for base, chunk, claims in results:
        for c in claims:
            idxs = [i for i in (c.get("evidence_idx") or []) if 0 <= i < len(emails)]
            srcs = [emails[i] for i in idxs]
            ev = [{"email_id": "", "date": e["date"], "from": e["from"], "subject": e["subject"]} for e in srcs]
            if not ev:
                continue
            stmt = c.get("statement", "").strip()
            conf = float(c.get("confidence", 0.5))
            # CODE-ENFORCED RECEIVING≠DOING: a claim supported ONLY by ⟨RECEIVING⟩ email cannot assert
            # behavior/identity. Drop the violators; cap the rest to receipt-confidence. Not trusted to the prompt.
            all_receiving = bool(srcs) and all(e.get("receiving") for e in srcs)
            if all_receiving:
                if receiving_violation(stmt):
                    dropped += 1
                    continue
                if conf > 0.35:
                    conf = 0.35
                    capped += 1
            upsert(conn, type=c.get("type", "other"), level=c.get("level", "fact"),
                   statement=stmt, confidence=conf, evidence=ev, when=max(e["date"] for e in ev))
            total += 1
    print(f"   gate: dropped {dropped} behavioral claims sourced only from RECEIVING email; "
          f"capped {capped} receiving-only claims to ≤0.35 confidence")
    md = dump_markdown(conn)
    (VAULT / "claims.md").write_text(md)
    print(f"\n✅ wrote {total} claim-observations → {conn.execute('SELECT count(*) FROM claims').fetchone()[0]} distinct claims")
    print(f"📂 audit dump → {VAULT/'claims.md'}\n")
    print(md[:2500])


if __name__ == "__main__":
    asyncio.run(main())
