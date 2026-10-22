"""Google reaches the runtime over loopback, tenant-scoped, and fails as 'not connected'.

The runtime owns the founder's conversation and has no Google client; the working OAuth,
per-member account scoping and 800 tested lines live here in the router. Rather than port them,
the router exposes three verbs on a token-gated loopback route and the runtime calls them under
its own authority.

The rule these pin: an unlinked account returns a reason, never an empty list. `gcal.accounts_for`
exists because an unscoped hold once landed on the founder's calendar instead of the member's
(8/28), so a tenant is required on every call and a tenant with no linked account gets nothing
rather than inheriting someone else's mailbox.
"""
import json
import os
import sys
from pathlib import Path

import pytest

ROUTER = Path(__file__).resolve().parents[2] / "frame" / "homebase" / "router"
sys.path.insert(0, str(ROUTER))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "frame" / "claims"))

import sendblue_router as router  # noqa: E402

SRC = (ROUTER / "sendblue_router.py").read_text()


def _bridge_source() -> str:
    """The whole function body, to the next def. A fixed character slice silently stops covering
    the tail of the function the moment anyone adds a branch."""
    return SRC.split("def _google_bridge")[1].split("\n    def ")[0]


def test_the_route_is_token_gated_like_every_other_webhook():
    assert 'startswith(f"/google/{tok}/")' in SRC
    assert "_google_bridge" in SRC


def test_every_verb_requires_a_tenant():
    """No tenant, no call. This is the 8/28 bug's guard, and it is checked before any Google work."""
    body = router.Handler._google_bridge.__doc__ or ""
    assert "Tenant-scoped on every call" in body
    fn = _bridge_source()
    assert 'tenant = str(body.get("tenant")' in fn
    assert '"tenant is required"' in fn


def test_a_missing_account_is_a_reason_not_an_empty_calendar():
    fn = _bridge_source()
    assert '"no linked google account for this member"' in fn
    assert '"connected": False' in fn


def test_the_three_verbs_and_nothing_else():
    fn = _bridge_source()
    for verb in ('verb == "calendar"', 'verb == "hold"', 'verb == "mail"'):
        assert verb in fn
    assert '"unknown verb"' in fn


def test_a_failure_returns_a_reason_and_a_non_200():
    fn = _bridge_source()
    assert "200 if out.get(\"ok\") else 502" in fn


@pytest.mark.skipif(not os.path.isdir(os.path.expanduser("~/.co/google")),
                    reason="no google directory on this machine")
def test_accounts_are_scoped_per_member():
    """A tenant with no linked directory must get an empty list, not the founder's accounts."""
    import gcal
    assert gcal.accounts_for("p15551000777") == []


def test_a_linked_account_with_a_dead_token_is_not_connected():
    """Found live 9/6: ~/.co/google/personal exists on disk while the keyring holds no refresh
    token, so accounts_for() said yes, sync() returned nothing, and the bridge reported an empty
    day. A free calendar and a broken one are indistinguishable to the member until they miss
    something, so the bridge must prove the token refreshes before it claims connected."""
    fn = _bridge_source()
    assert "gcal._access(a)" in fn, "connected must be proven by a refresh, not by a file existing"
    assert "will not refresh" in fn
    assert "re-run gog auth add" in fn


def test_no_failure_shape_carries_an_empty_collection():
    """An empty events/messages list beside connected:false is the lie in miniature — a model
    reading the object sees a list and reports nothing scheduled."""
    fn = _bridge_source()
    for shape in ('"connected": False, "events": []', '"connected": False, "messages": []'):
        assert shape not in fn, f"failure shape still carries a list: {shape}"
