"""Linking Google is a member flow, not a founder utility (8/28).

The old flow redirected to http://localhost:8765, opened a browser on THIS machine, and wrote to
one flat directory labelled by account. Every assumption was "one person, at this computer",
which is why the integration was single-tenant and a second member could not connect mail at all.

The hosted half runs over the rail's public URL: the member taps a link in iMessage, consents on
their own phone, and their tokens land in their OWN directory.
"""
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
ROUTER = REPO / "frame" / "homebase" / "router"
sys.path.insert(0, str(CLAIMS))

os.environ.setdefault("CO_RAIL_SLUG_SECRET", "test-secret-for-signing")
import google_link as gl  # noqa: E402


def test_state_carries_the_tenant_and_is_signed():
    st = gl.sign_state("p15550001111", "personal", now=1000)
    assert gl.verify_state(st, now=1100) == ("p15550001111", "personal")


def test_a_forged_state_cannot_attach_an_account_to_someone_else():
    # the callback is a PUBLIC endpoint; an unsigned tenant would let anyone link their Google
    # account to another member's co
    st = gl.sign_state("p15550001111", "personal", now=1000)
    assert gl.verify_state(st.replace("p15550001111", "dennis"), now=1100) is None
    assert gl.verify_state("dennis|personal|2000|deadbeef", now=1100) is None


def test_a_consent_link_expires():
    # a link that outlives the sitting is a standing key to somebody's mailbox
    st = gl.sign_state("t", "personal", now=1000)
    assert gl.verify_state(st, now=1000 + gl.STATE_TTL_S + 1) is None
    assert gl.STATE_TTL_S <= 3600


def test_now_zero_is_not_treated_as_now():
    # `now or time()` is a falsy-zero trap: now=0 silently became "right now", so an expired
    # state verified clean. Caught by its own test before shipping.
    st = gl.sign_state("t", "personal", now=0)
    assert gl.verify_state(st, now=gl.STATE_TTL_S + 1) is None


def test_an_unsigned_deployment_refuses_rather_than_allows(monkeypatch):
    monkeypatch.setattr(gl, "_secret", lambda: b"")
    assert gl.verify_state("t|personal|2000|abc", now=1100) is None


def test_tokens_land_in_the_members_own_directory():
    assert gl.tenant_dir("p15550001111").endswith("/google/p15550001111")
    body = (CLAIMS / "google_link.py").read_text().split("def complete")[1].split("\ndef ")[0]
    assert "tenant_dir(tenant)" in body
    assert "0o600" in body


def test_the_redirect_is_public_not_loopback():
    body = (CLAIMS / "google_link.py").read_text().split("def _redirect_uri")[1].split("\ndef ")[0]
    assert "WEBHOOK_PUBLIC_URL" in body and "localhost" not in body


def test_an_unlinked_member_inherits_nobodys_mailbox():
    import gcal
    assert gcal.accounts_for("p15550001111") == []
    body = (CLAIMS / "gcal.py").read_text().split("def accounts_for")[1].split("\ndef ")[0]
    assert "worst possible default" in " ".join(body.split())


def test_the_callback_never_puts_a_token_in_a_log_or_a_body():
    r = (ROUTER / "sendblue_router.py").read_text()
    blk = r.split("GOOGLE CONSENT CALLBACK")[1][:1200]
    assert "refresh_token" not in blk
    assert 'got.get("tenant"' in blk          # logs the tenant, never the secret
