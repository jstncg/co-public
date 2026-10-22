#!/usr/bin/env python3
"""Account data export — "your data is yours; export always works" (the kyo export.py law).

One zip, ALLOWLIST not denylist (fail-closed): only surfaces that are explicitly the
person's own content ship. Anything else — API keys in env, other tenants' dbs, ops
state, logs, the raw sqlite with its embedding blobs — is excluded BY DEFAULT until
someone deliberately allows it. The failure mode is a too-small export (fixable),
never a leaked secret.

What ships:
  transcript.json         the whole conversation, both directions
  sessions.jsonl          the archived session arcs (what co remembers of each stretch)
  journal.json            every capture — the Saga
  claims.md               the belief graph, dumped READABLE (text/confidence/dates —
                          not the raw db: embeddings are derivable, sqlite carries state)
  watches.md              active + expired watches (what co is watching for them)
  episodes.md             the episode ledger (asks, outcomes, receipts)
  anchors.json            reminders and promises
  research/               commissioned research findings
  threads/ (founder)      the woven living documents

    python3 export_data.py <tenant> [out.zip]
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import zipfile
from pathlib import Path

CLAIMS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, CLAIMS_DIR)
FOUNDER = "dennis"


def _db(tenant: str) -> str:
    return os.path.join(CLAIMS_DIR, "claims.db" if tenant == FOUNDER else f"claims_{tenant}.db")


def _claims_md(tenant: str) -> str:
    try:
        c = sqlite3.connect(f"file:{_db(tenant)}?mode=ro", uri=True)
        rows = c.execute("SELECT statement, type, confidence, first_seen FROM claims "
                         "ORDER BY first_seen DESC LIMIT 5000").fetchall()
        c.close()
        lines = [f"# What co believes (from what you've told it)\n"]
        lines += [f"- {st_}  _({ty}, conf {cf}, {fs[:10] if fs else '?'})_" for st_, ty, cf, fs in rows]
        return "\n".join(lines)
    except Exception as e:
        return f"# (belief graph unavailable: {e})"


def _table_md(tenant: str, table: str, cols: str, title: str) -> str:
    try:
        c = sqlite3.connect(f"file:{_db(tenant)}?mode=ro", uri=True)
        rows = c.execute(f"SELECT {cols} FROM {table} ORDER BY rowid DESC LIMIT 500").fetchall()
        c.close()
        return f"# {title}\n" + "\n".join("- " + " | ".join(str(x) for x in r) for r in rows)
    except Exception:
        return f"# {title}\n(none)"


def export(tenant: str, out_path: str | None = None) -> str:
    home = os.path.expanduser("~")
    out = out_path or os.path.join(home, f"co-export-{tenant}-{time.strftime('%Y%m%d')}.zip")
    # THE ALLOWLIST — a path ships only by appearing here.
    allowed_files = {
        "transcript.json": f"{home}/.co_{tenant}_sendblue_transcript.json",
        "sessions.jsonl": f"{home}/.co_{tenant}_sessions.jsonl",
        "journal.json": f"{home}/.co/journal/{tenant}.json",
        "anchors.json": f"{_db(tenant)}.anchors.json",
    }
    allowed_dirs = {
        "research": f"{home}/.co/research/{tenant}",
    }
    if tenant == FOUNDER:
        allowed_dirs["threads"] = os.path.join(CLAIMS_DIR, "..", "..", "..", "..",
                                               "Secretary-Production", ".claude", "memory", "threads")
        allowed_dirs["threads"] = "/Users/main/Projects/Secretary/Secretary-Production/.claude/memory/threads"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for arc, p in allowed_files.items():
            if os.path.exists(p):
                z.write(p, arc)
        for arc, d in allowed_dirs.items():
            if os.path.isdir(d):
                for fn in sorted(os.listdir(d)):
                    fp = os.path.join(d, fn)
                    if os.path.isfile(fp) and (fn.endswith(".json") or fn.endswith(".md")):
                        z.write(fp, f"{arc}/{fn}")
        z.writestr("claims.md", _claims_md(tenant))
        z.writestr("watches.md", _table_md(tenant, "watches", "what, kind, status, created_at",
                                           "What co is watching for you"))
        z.writestr("episodes.md", _table_md(tenant, "episodes", "what, state, receipt, outcome, created_at",
                                            "Things co made real (or didn't)"))
        z.writestr("README.md",
                   f"# Your co data — exported {time.strftime('%Y-%m-%d')}\n\n"
                   "Everything co knows about you, readable. The belief graph is in claims.md;\n"
                   "the raw conversation is transcript.json. This export is the allowlist kind:\n"
                   "if something you expected is missing, that's a bug to report, not data lost.\n")
    return out


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else FOUNDER
    p = export(t, sys.argv[2] if len(sys.argv) > 2 else None)
    print(f"{p} ({os.path.getsize(p) // 1024}KB)")
