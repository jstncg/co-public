#!/usr/bin/env python3
"""Total tenant deletion — rank-1, non-negotiable (the kyo deletion.py law, on frame's organs).

When a person asks to be forgotten, EVERYTHING goes: the claims db and every sidecar
(memory, anchors, threads, viewer recs, skip flags, transcripts), the journal, the
sendblue transcript + session arcs, deferred watches, commissioned research, and their
lines in the shared dual-write archive/spool (scrubbed by phone, atomic rewrite). The
derived layer dies with the raw layer in one shot — forgetting one memory cascades its
inferences; deleting an account is that cascade applied to the whole person.

Returns a MANIFEST of what was removed, for auditability — and it is honest about what
it could NOT reach: cloud Supabase rows are listed as pending until the receiver grows
a /forget endpoint (the receiver owns the cloud seam; frame holds no cloud credential
by design, and that stays true even here).

SAFETY: the founder tenant refuses without force=True — a misfired conversational
deletion of the primary account is the one irreversible catastrophe this module could
cause, so the founder path is CLI-only, on purpose. v0 is CLI-only for everyone; the
conversational flow ships later behind a two-step typed confirmation.

    python3 forget.py <tenant> --dry     # manifest of what WOULD go
    python3 forget.py <tenant> --yes     # actually delete
"""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import sys
from pathlib import Path

CLAIMS_DIR = os.path.dirname(os.path.abspath(__file__))
FOUNDER = "dennis"


def _tenant_db(tenant: str) -> str:
    return os.path.join(CLAIMS_DIR, "claims.db" if tenant == FOUNDER else f"claims_{tenant}.db")


def _tenant_phone(tenant: str) -> str | None:
    try:
        sys.path.insert(0, CLAIMS_DIR)
        import daily_text
        return daily_text.tenant_phone(tenant, daily_text._cfg(Path(_tenant_db(tenant))))
    except Exception:
        return None


def surfaces(tenant: str) -> dict:
    """Every place this tenant exists on this machine. The map IS the audit."""
    db = _tenant_db(tenant)
    home = os.path.expanduser("~")
    files = sorted(glob.glob(db + "*"))                       # db + every sidecar
    for p in (f"{home}/.co_{tenant}_sendblue_transcript.json",
              f"{home}/.co_{tenant}_sessions.jsonl",
              f"{home}/.co/journal/{tenant}.json",
              f"{home}/.co/deferred_watch/{tenant}.jsonl"):
        if os.path.exists(p):
            files.append(p)
    dirs = [d for d in (f"{home}/.co/research/{tenant}",) if os.path.isdir(d)]
    return {"files": files, "dirs": dirs, "phone": _tenant_phone(tenant)}


def _scrub_shared(phone: str, dry: bool) -> dict:
    """The tenant's lines out of SHARED files (dual-write archive/spool, outbound status),
    keyed by phone. Atomic rewrites; counts reported in the manifest."""
    home = os.path.expanduser("~")
    norm = re.sub(r"[^\d+]", "", phone or "")
    out = {}
    if not norm:
        return {"skipped": "no phone on file"}
    for p in (f"{home}/.co/co_dualwrite_archive.jsonl", f"{home}/.co/co_dualwrite_spool.jsonl",
              f"{home}/.co/outbound_status_log.jsonl"):
        if not os.path.exists(p):
            continue
        kept, dropped = [], 0
        with open(p) as f:
            for line in f:
                if norm in line:
                    dropped += 1
                else:
                    kept.append(line)
        out[os.path.basename(p)] = dropped
        if not dry and dropped:
            tmp = p + ".tmp"
            with open(tmp, "w") as f:
                f.writelines(kept)
            os.replace(tmp, p)
    sp = f"{home}/.co/outbound_status.json"
    if os.path.exists(sp):
        try:
            st = json.loads(open(sp).read())
            if norm in st:
                out["outbound_status.json"] = 1
                if not dry:
                    del st[norm]
                    tmp = sp + ".tmp"
                    open(tmp, "w").write(json.dumps(st))
                    os.replace(tmp, sp)
        except (json.JSONDecodeError, OSError):
            pass
    return out


def delete_tenant(tenant: str, dry: bool = True, force: bool = False) -> dict:
    """The cascade. Returns the manifest. Founder refuses without force."""
    if tenant == FOUNDER and not force:
        return {"refused": "founder tenant requires force=True (CLI-only, on purpose)"}
    s = surfaces(tenant)
    manifest = {"tenant": tenant, "dry_run": dry,
                "files": s["files"], "dirs": s["dirs"],
                "shared_scrub": _scrub_shared(s["phone"] or "", dry),
                "cloud": "PENDING — receiver /forget endpoint not built yet; cloud rows for "
                         f"{s['phone'] or '(no phone)'} still exist in Supabase"}
    if not dry:
        for p in s["files"]:
            try:
                os.remove(p)
            except OSError as e:
                manifest.setdefault("errors", []).append(f"{p}: {e}")
        for d in s["dirs"]:
            shutil.rmtree(d, ignore_errors=True)
    return manifest


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)
    tenant = args[0]
    dry = "--yes" not in args
    m = delete_tenant(tenant, dry=dry, force="--force" in args)
    print(json.dumps(m, indent=1))
    if dry and "refused" not in m:
        print("\n(dry run — nothing deleted. re-run with --yes to execute.)", file=sys.stderr)
