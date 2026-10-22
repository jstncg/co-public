#!/usr/bin/env python3
"""Link a Google account to co — one browser consent, tokens land in ~/.co/google/ (8/24).

Minimal scopes, deliberately: gmail.readonly (the guard reads, NEVER sends) and
calendar.events (the Time class holds hours on the member's own calendar). The old
everything-scope tokens are dead; co asks only for what its organs actually use.

    python3 google_link.py personal        # opens the browser, approve, done
    python3 google_link.py work
    python3 google_link.py <any-label>

Loopback flow, no extra deps. Client id/secret come from the existing
gmail_credentials.json (the client survived; only the grants died).
"""
from __future__ import annotations

import http.server
import json
import os
import secrets
import sys
import threading
import urllib.parse
import re
import urllib.request
import webbrowser

SETUP = "/Users/main/Projects/Secretary/Secretary-Production/.claude/setup/gmail_credentials.json"
OUT_DIR = os.path.expanduser("~/.co/google")
SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events"
PORT = 8765

# ── HOSTED FLOW (8/28) ────────────────────────────────────────────────────────────────────────
# The loopback flow below is a FOUNDER UTILITY: redirect to localhost, open a browser on this
# machine, write to one flat directory labelled by account. Every assumption is "one person, at
# this computer", which is why the Google integration was single-tenant and why a second member
# could not connect mail at all.
#
# This half runs over the rail's public URL, which already serves authenticated routes. The
# member taps a link in iMessage, consents on their own phone, and their tokens land in their
# OWN directory — the one identity._accounts_for already reads first.
#
# THE STATE IS SIGNED. The callback is a public endpoint, so an unsigned tenant in the state
# parameter would let anyone attach their Google account to somebody else's co. HMAC over
# tenant+label+expiry, with the same secret the webhook uses.

STATE_TTL_S = 900            # a consent link that outlives the sitting is a standing key


def _secret() -> bytes:
    return (os.environ.get("CO_RAIL_SLUG_SECRET") or os.environ.get("WEBHOOK_TOKEN") or "").encode()


def sign_state(tenant: str, label: str, now: int | None = None) -> str:
    import hashlib
    import hmac
    import time as _t
    exp = int(_t.time() if now is None else now) + STATE_TTL_S
    body = f"{tenant}|{label}|{exp}"
    mac = hmac.new(_secret(), body.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{body}|{mac}"


def verify_state(state: str, now: int | None = None) -> tuple[str, str] | None:
    """(tenant, label) or None. Wrong signature, wrong shape, or expired all fail the same way."""
    import hashlib
    import hmac
    import time as _t
    try:
        tenant, label, exp, mac = (state or "").split("|")
    except ValueError:
        return None
    if not _secret():
        return None                                   # unsigned deployment: refuse, never allow
    want = hmac.new(_secret(), f"{tenant}|{label}|{exp}".encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(mac, want):
        return None
    # `now or time()` is a falsy-zero trap: now=0 silently became 'right now', so an
    # expired state verified clean. Explicit None check, both directions.
    if int(_t.time() if now is None else now) > int(exp):
        return None
    return tenant, label


def _redirect_uri() -> str:
    base = (os.environ.get("WEBHOOK_PUBLIC_URL") or "").rstrip("/")
    return f"{base}/oauth/google" if base else ""


def consent_url(tenant: str, label: str = "personal") -> str:
    """The link the member taps. Nothing is written until they come back."""
    creds = json.load(open(SETUP))
    c = creds.get("installed") or creds.get("web") or {}
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": c["client_id"], "redirect_uri": _redirect_uri(),
        "response_type": "code", "scope": SCOPES, "access_type": "offline",
        "prompt": "consent", "state": sign_state(tenant, label),
    })


def tenant_dir(tenant: str) -> str:
    return os.path.join(OUT_DIR, tenant)


def complete(code: str, state: str) -> dict:
    """Exchange the code and store the refresh token under the MEMBER's own directory.
    Returns {ok, tenant} — the token value never leaves this function."""
    got = verify_state(state)
    if not got:
        return {"ok": False, "why": "bad or expired state"}
    tenant, label = got
    creds = json.load(open(SETUP))
    c = creds.get("installed") or creds.get("web") or {}
    data = urllib.parse.urlencode({
        "client_id": c["client_id"], "client_secret": c["client_secret"], "code": code,
        "grant_type": "authorization_code", "redirect_uri": _redirect_uri(),
    }).encode()
    try:
        tok = json.load(urllib.request.urlopen(
            urllib.request.Request("https://oauth2.googleapis.com/token", data=data), timeout=20))
    except Exception as e:
        return {"ok": False, "why": f"token exchange failed: {type(e).__name__}"}
    if not tok.get("refresh_token"):
        return {"ok": False, "why": "no refresh token (revoke co at myaccount.google.com and retry)"}
    d = tenant_dir(tenant)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{re.sub(r'[^a-z0-9_-]', '', label.lower()) or 'personal'}.json")
    json.dump({"client_id": c["client_id"], "client_secret": c["client_secret"],
               "refresh_token": tok["refresh_token"], "scopes": SCOPES.split()},
              open(path, "w"))
    os.chmod(path, 0o600)
    return {"ok": True, "tenant": tenant}


def main(label: str) -> None:
    creds = json.load(open(SETUP))
    c = creds.get("installed") or creds.get("web") or {}
    cid, csec = c["client_id"], c["client_secret"]
    state = secrets.token_urlsafe(16)
    redirect = f"http://localhost:{PORT}/oauth"
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": cid, "redirect_uri": redirect, "response_type": "code",
        "scope": SCOPES, "access_type": "offline", "prompt": "consent", "state": state,
    })
    got: dict = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if q.get("state", [""])[0] == state and q.get("code"):
                got["code"] = q["code"][0]
                body = b"<h2>co is linked. close this tab.</h2>"
            else:
                body = b"<h2>link failed (state mismatch), run it again.</h2>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):  # noqa: A002
            pass

    srv = http.server.HTTPServer(("localhost", PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print("opening browser — approve the two scopes (gmail read, calendar events)")
    webbrowser.open(url)
    import time
    for _ in range(600):
        if got.get("code"):
            break
        time.sleep(0.5)
    srv.shutdown()
    if not got.get("code"):
        sys.exit("no consent received in 5 minutes — run it again")
    data = urllib.parse.urlencode({
        "client_id": cid, "client_secret": csec, "code": got["code"],
        "grant_type": "authorization_code", "redirect_uri": redirect,
    }).encode()
    tok = json.load(urllib.request.urlopen(
        urllib.request.Request("https://oauth2.googleapis.com/token", data=data), timeout=20))
    if not tok.get("refresh_token"):
        sys.exit("no refresh token returned — revoke co's access at myaccount.google.com/permissions and rerun")
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"{label}.json")
    json.dump({"client_id": cid, "client_secret": csec,
               "refresh_token": tok["refresh_token"], "scopes": SCOPES.split()},
              open(path, "w"))
    os.chmod(path, 0o600)
    print(f"linked → {path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "personal")
