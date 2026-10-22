#!/usr/bin/env python3
"""Agency — the witness acts in the real world ON YOUR BEHALF (the 'not just a journal' half).

A friend doesn't only listen; they DO things: draft the email, make the intro, propose the meeting, handle
the logistics. This is that layer. Voice-call-as-frame: during/after a call, the witness can take the action
you discussed.

THE ABSOLUTE RULE (from CLAUDE.md, enforced in code, no exceptions): NEVER send/execute anything outbound
without 100% explicit confirmation. Every tool here DRAFTS or PROPOSES — a pure, side-effect-free artifact.
Execution is a SEPARATE, explicitly-confirmed step (`execute`), which refuses unless handed a draft the user
said "yes/send/go" to. Drafting is safe by construction; sending is deliberate.

  draft_message / draft_intro / propose_event  → return a draft (NO side effects)
  execute(draft_id, confirm="<the user's literal yes>")  → performs it (only with explicit confirm)
"""
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

DRAFTS = Path.home() / ".co_drafts.json"
CONFIRM_WORDS = {"yes", "send", "send it", "go", "do it", "confirm", "approved", "yep", "yeah send"}


def _load():
    try:
        return json.loads(DRAFTS.read_text()) if DRAFTS.exists() else {}
    except json.JSONDecodeError:
        return {}


def _save(d):
    DRAFTS.write_text(json.dumps(d, indent=2))


def _stage(kind, payload, tenant: str = "") -> dict:
    """Stage a draft. No side effects. Tenant is stored on the record: hands need it, and a
    falsy one makes work.log() early-return silently."""
    d = _load()
    did = f"{kind}-{int(time.time())}-{len(d)}"
    rec = {"id": did, "kind": kind, "payload": payload, "tenant": tenant or payload.get("tenant", ""),
           "status": "draft", "staged": time.strftime("%Y-%m-%d %H:%M")}
    d[did] = rec
    _save(d)
    return rec


async def _write_in_voice(instruction: str) -> str:
    """Draft text in the user's own voice using the witness engine (carried-core informs tone)."""
    try:
        from anthro import make_client
        client = make_client()
        r = await client.messages.create(
            model=os.environ.get("CO_DRAFT_MODEL", "claude-sonnet-5"), max_tokens=400,
            system="Draft this in the USER's own voice (short, real, how they'd actually write it — not "
                   "assistant-speak). Output ONLY the draft text, nothing else.",
            messages=[{"role": "user", "content": instruction}])
        import disposition
        return disposition.sanitize("".join(b.text for b in r.content if b.type == "text").strip())
    except Exception as e:
        return f"(draft failed: {e})"


# ---------------- the action tools (all DRAFT-only — no side effects) ----------------
async def draft_message(to: str, about: str) -> dict:
    """Draft an email/text to someone, in the user's voice. Returns a draft to confirm — does NOT send."""
    body = await _write_in_voice(f"Write a message to {to} about: {about}")
    return _stage("message", {"to": to, "about": about, "body": body})


async def draft_intro(person_a: str, person_b: str, why: str) -> dict:
    """Draft a (double-opt-in) intro between two people the user knows. Returns a draft — does NOT send."""
    body = await _write_in_voice(f"Write a warm, brief intro connecting {person_a} and {person_b}. Reason: {why}. "
                                 f"Double-opt-in style (ask if they're open before connecting).")
    return _stage("intro", {"person_a": person_a, "person_b": person_b, "why": why, "body": body})


def propose_event(title: str, when: str, who: str = "") -> dict:
    """Propose a calendar event. Returns a proposal — does NOT create it."""
    return _stage("event", {"title": title, "when": when, "who": who})


# SELF touches only the member's surfaces and needs no tap. OTHERS reaches a human and always
# needs one. OTHERS never shrinks; moving a kind into SELF is a reviewed decision.
SELF = {"event", "draft", "note", "research"}
OTHERS = {"message", "intro"}


def consequence(kind: str) -> str:
    return "SELF" if kind in SELF else "OTHERS"


# A hand returns (ok, evidence). ok is true only if something happened; evidence is the proof.
def _hand_event(payload: dict) -> tuple:
    """A hold on the member's own calendar. Real when Google is linked; honest when it is not."""
    try:
        import gcal
        got = gcal.hold(payload.get("title", "hold"), payload.get("when", ""),
                        int(payload.get("minutes", 30)), tenant=payload.get("tenant", ""))
        if got.get("ok"):
            return True, got.get("receipt") or got.get("id") or "created"
        return False, f"gcal refused: {got.get('why') or got}"
    except Exception as e:
        return False, f"gcal unavailable: {e}"


def _hand_draft(payload: dict) -> tuple:
    """Writes the artifact where the member will find it, rather than telling them about it."""
    try:
        import work
        body = (payload.get("body") or "").strip()
        if not body and payload.get("about"):
            import asyncio
            body = asyncio.run(_write_in_voice(f"Write this: {payload['about']}")).strip()
        if not body or body.startswith("(draft failed"):
            return False, body or "nothing drafted"
        out = Path.home() / ".co" / "drafts"
        out.mkdir(parents=True, exist_ok=True)
        f = out / f"{payload.get('slug') or 'draft'}-{int(time.time())}.md"
        f.write_text(body)
        work.log(payload.get("tenant", ""), "drafted", payload.get("about") or "a draft",
                 why=payload.get("why"), url=str(f))
        return True, str(f)
    except Exception as e:
        return False, f"draft hand failed: {e}"


HANDS = {"event": _hand_event, "draft": _hand_draft}


# A deposit only reaches the model if it lexically looks like an ask. Most do not, and a model call
# per deposit is the cost the queue exists to avoid.
_ASK = re.compile(r"\b(draft|write|reply|respond|email|remind|book|hold|schedule|block|set ?up|"
                  r"put .{0,20}\bon\b|pencil|note to self)\b", re.I)

_STAGE_SYS = """The member sent you something. Decide whether it asks for a concrete act you can do on
THEIR OWN surfaces, and nothing else.

  draft  they want something written (a reply, an email, a note). Give it a short slug and what it is about.
  event  they want time held. Give a title and an ISO datetime.

Return kind "" for anything else, including anything that would reach another person. Most deposits
are not asks; "" is the common and correct answer.

Reply ONLY JSON: {"kind": "draft"|"event"|"", "slug": "...", "about": "...", "title": "...", "when": "..."}"""


def stage_from(text: str, tenant: str = "") -> dict | None:
    """A deposit becomes at most one staged SELF act, or nothing."""
    if not _ASK.search(text or ""):
        return None
    try:
        import llm
        got = llm.ask_json(llm.json_specs(), _STAGE_SYS, text[:1200], max_tokens=200) or {}
    except Exception:
        return None
    kind = str(got.get("kind") or "")
    if kind not in SELF or kind not in HANDS:
        return None
    payload = {"tenant": tenant, "about": str(got.get("about") or "")[:160],
               "slug": re.sub(r"[^a-z0-9-]+", "-", str(got.get("slug") or kind).lower())[:40],
               "title": str(got.get("title") or "")[:120], "when": str(got.get("when") or "")[:32]}
    return _stage(kind, payload, tenant)


# ---------------- execution (the ONLY thing with side effects) ----------------
def execute(draft_id: str, confirm: str = "") -> str:
    """Perform a staged draft. Status only ever reflects what a hand proved."""
    d = _load()
    rec = d.get(draft_id)
    if not rec:
        return f"no such draft {draft_id}"
    if rec["status"] == "done":
        return f"already executed {draft_id}"

    kind = rec["kind"]
    if consequence(kind) == "OTHERS" and (confirm or "").strip().lower() not in CONFIRM_WORDS:
        return (f"NOT executed — {kind} reaches another person and has no explicit confirmation "
                f"(got: {confirm!r}). Staged; say 'send'/'go' to confirm.")

    hand = HANDS.get(kind)
    if not hand:
        rec["status"] = "unwired"
        _save(d)
        return f"NOT executed — no hand is wired for {kind!r}. Staged and honest; nothing was sent."

    ok, evidence = hand({**rec["payload"], **({"tenant": rec["tenant"]} if rec.get("tenant") else {})})
    if not ok:
        rec["status"] = "failed"
        rec["error"] = str(evidence)[:200]
        _save(d)
        return f"NOT executed — {evidence}"
    rec["status"] = "done"
    rec["evidence"] = str(evidence)[:300]
    rec["executed"] = time.strftime("%Y-%m-%d %H:%M")
    _save(d)
    try:
        import landed
        landed.record(rec.get("tenant", ""), f"{kind}: {str(evidence)[:60]}", lane="actions",
                      kind="act", expected="the member finds it and keeps it")
    except Exception:
        pass
    return f"executed {draft_id} ({kind}, {consequence(kind)}): {evidence}"


if __name__ == "__main__":
    import asyncio
    print("=== agency self-test (SELF acts run; OTHERS refuse without a tap) ===")
    dr = _stage("draft", {"body": "a real artifact, written to disk", "about": "the self-test",
                          "slug": "selftest", "tenant": "dennis"})
    print("  draft staged     →", dr["id"])
    print("  execute (SELF)   →", execute(dr["id"]))
    m = _stage("message", {"to": "someone", "about": "a thing", "body": "hi"})
    print("  execute (OTHERS) →", execute(m["id"])[:88])
    print("  with confirm     →", execute(m["id"], "send")[:88])
