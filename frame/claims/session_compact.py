#!/usr/bin/env python3
"""Rolling session compaction (7/2) — long conversations keep their ARC, not just their facts.

The engine sees ~12 verbatim exchanges; in a 40-turn evening session, turn 35 had lost turn 4 unless it
became a claim. This folds the OLDEST turns (everything beyond the last 12 exchanges of the CURRENT
session) into a running "session so far" block: incremental (each pass folds into the existing summary),
QUOTE-PRESERVING (2-4 short verbatim user phrases — the emotionally weighted lines, the exact words of
commitments; gist alone reads as a stranger with notes), cheap (gemini flash-lite), and run strictly in
post-reply bookkeeping — never the hot path.

Files, beside the transcript (restart-safe, same seeding path as the durable history):
  ~/.co_<tenant>_session.json     {"summary","quotes","covered","start_idx","folded_last_ts"}
  ~/.co_<tenant>_sessions.jsonl   finished-session summaries (a 4h+ gap closes a session) — the
                                     input for later consolidation; nothing reads it yet by design.

The block is INTERNAL: the persona never references it ("as we discussed" is banned phrasing — you
simply remember).
"""
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

KEEP_VERBATIM_MSGS = 24          # the last ~12 exchanges stay verbatim in the window
FOLD_TRIGGER_MSGS = 40           # compact when the current session's uncompacted tail exceeds this (~20 turns)
SESSION_GAP_H = 4                # a 4h+ silence closes the session

FOLD_SYS = """You maintain the running memory of ONE ongoing conversation session between a person and their
friend. You get the EXISTING running summary (may be empty), the quotes kept so far, and the NEXT chunk of
verbatim turns. Return the UPDATED memory.

- "summary": the conversational ARC in tight prose, chronological: what they brought up, how it developed,
  what shifted, decisions and moods. FOLD the new chunk into the existing summary (extend/merge, never
  restart). 180 words max. Specific over general; keep names, numbers, dates.
- "quotes": 2 to 4 SHORT VERBATIM quotes from the USER's own turns — the emotionally weighted phrases, the
  exact words of commitments, the line they'd remember saying. EXACT words, never paraphrased. Keep the
  existing quotes unless a new one clearly outweighs one.
Return ONLY JSON: {"summary":"...","quotes":["..."]}"""


def _session_path(transcript_path: str) -> Path:
    return Path(str(transcript_path).replace("_sendblue_transcript.json", "_session.json"))


def _archive_path(transcript_path: str) -> Path:
    return Path(str(transcript_path).replace("_sendblue_transcript.json", "_sessions.jsonl"))


def _load_json(p: Path, default):
    try:
        if p.exists():
            return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return default


def _parse_ts(m: dict):
    try:
        return dt.datetime.fromisoformat(m["ts"])
    except (KeyError, ValueError, TypeError):
        return None


def _session_start_idx(msgs: list) -> int:
    """Index of the first message of the CURRENT session (last 4h+ gap wins; ts-less history = one session)."""
    start = 0
    prev = None
    for i, m in enumerate(msgs):
        t = _parse_ts(m)
        if t and prev and (t - prev).total_seconds() > SESSION_GAP_H * 3600:
            start = i
        if t:
            prev = t
    return start


def _fold(summary: str, quotes: list, chunk: list) -> dict | None:
    """One incremental fold via gemini flash-lite. None on any failure (retry next turn, never break)."""
    try:
        import link_read
        client = link_read._gemini_client()
        if not client:
            return None
        convo = "\n".join(f"{m['role']}: {m['content'][:400]}" for m in chunk)
        payload = json.dumps({"existing_summary": summary, "kept_quotes": quotes,
                              "next_chunk_of_turns": convo})
        out = link_read._gemini_generate(client, [FOLD_SYS, payload])
        if not out:
            return None
        m = re.search(r"\{.*\}", out, re.S)
        got = json.loads(m.group(0)) if m else None
        if not got or not isinstance(got.get("summary"), str):
            return None
        got["quotes"] = [str(q)[:160] for q in (got.get("quotes") or [])][:4]
        got["summary"] = got["summary"][:1600]
        return got
    except Exception as e:
        print(f"  (session fold failed: {e})", file=sys.stderr)
        return None


def compact(transcript_path: str) -> dict | None:
    """The bookkeeping entry point: session-boundary handling + one incremental fold when due."""
    msgs = _load_json(Path(transcript_path), [])
    if not msgs:
        return None
    sp = _session_path(transcript_path)
    sess = _load_json(sp, {"summary": "", "quotes": [], "covered": 0, "start_idx": 0, "folded_last_ts": None})

    start = _session_start_idx(msgs)
    if start > sess.get("start_idx", 0):
        # a 4h+ gap closed the old session → archive its summary for future consolidation, start fresh
        if sess.get("summary"):
            try:
                with open(_archive_path(transcript_path), "a") as f:
                    f.write(json.dumps({"ended": dt.datetime.now().isoformat(timespec="seconds"),
                                        "summary": sess["summary"], "quotes": sess.get("quotes", [])}) + "\n")
            except OSError:
                pass
        sess = {"summary": "", "quotes": [], "covered": start, "start_idx": start, "folded_last_ts": None}

    covered = max(sess.get("covered", 0), sess.get("start_idx", 0))
    live = msgs[covered:]
    if len(live) <= FOLD_TRIGGER_MSGS:
        _save(sp, sess)
        return sess
    chunk = live[: len(live) - KEEP_VERBATIM_MSGS]
    folded = _fold(sess.get("summary", ""), sess.get("quotes", []), chunk)
    if folded:
        sess["summary"] = folded["summary"]
        sess["quotes"] = folded["quotes"]
        sess["covered"] = covered + len(chunk)
        last_ts = next((m.get("ts") for m in reversed(chunk) if m.get("ts")), None)
        sess["folded_last_ts"] = last_ts or dt.datetime.now().isoformat(timespec="seconds")
    _save(sp, sess)
    return sess


def _save(p: Path, sess: dict) -> None:
    try:
        tmp = Path(str(p) + ".tmp")
        tmp.write_text(json.dumps(sess, ensure_ascii=False))
        os.replace(tmp, p)
    except OSError:
        pass


def _scrub_forgotten(text: str, transcript_path: str) -> str:
    """kyo e3dccf8, ported: a wording the user asked co to forget must not survive inside an arc
    summary that was digested BEFORE the forget. Spans come from the ontology tombstones."""
    try:
        import re as _re
        m = _re.search(r"\.co_([a-z0-9_]+)_sendblue_transcript", transcript_path)
        if not m:
            return text
        tenant = m.group(1)
        import os as _os
        import sys as _sys
        _sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)),
                                                           "..", "..", "engine")))
        from co_engine import ontology as _onto
        db = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)),
                           "claims.db" if tenant == "dennis" else f"claims_{tenant}.db")
        if not _os.path.exists(db):
            return text
        conn = _onto.connect(db)
        try:
            for span in _onto.forgotten_spans(conn):
                if span and span in text:
                    text = text.replace(span, "[forgotten at their request]")
        finally:
            conn.close()
    except Exception:
        pass
    return text


def context_block(transcript_path: str) -> str:
    """The pinned block for the engine, or "". Only for the CURRENT session (a stale summary from a
    previous session never rides into a fresh one — that's consolidation's job, later)."""
    sess = _load_json(_session_path(transcript_path), {})
    summary = (sess.get("summary") or "").strip()
    if not summary:
        return ""
    try:
        folded = dt.datetime.fromisoformat(sess["folded_last_ts"])
        if (dt.datetime.now() - folded).total_seconds() > SESSION_GAP_H * 3600:
            return ""
    except (KeyError, ValueError, TypeError):
        pass
    quotes = [q for q in (sess.get("quotes") or []) if q][:4]
    qline = ("\nTHEIR EXACT WORDS from earlier in this session (quote back naturally when it fits): " +
             " | ".join(f'"{q}"' for q in quotes)) if quotes else ""
    block = ("EARLIER THIS SESSION (this same conversation, before the recent messages — you simply remember "
             "it; never say 'as we discussed', never mention notes or summaries):\n" + summary + qline)
    return _scrub_forgotten(block, transcript_path)


if __name__ == "__main__":
    tp = sys.argv[1]
    print(json.dumps(compact(tp) or {}, indent=1)[:800])
    print("---")
    print(context_block(tp) or "(no session block)")
