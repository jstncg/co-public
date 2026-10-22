"""IDENTITY — who the member is, keyed on their phone number (8/28).

Three times in one day co mistook somebody else's data for the member's: it searched the web for
his own name off a calendar title, turned his description of another founder's ambition into his
own aim, and claimed a friend's forwarded itinerary as his trip. Each fix passed identity in
explicitly — and each worked ONLY FOR HIM, because his tenant handle happens to be his name.

    member_names('dennis')       -> ['dennis']          works by accident
    member_names('p15550001111') -> ['p15550001111']    a phone, not a name

The phone is the key; everything else is discovered from what the member already connected.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import identity  # noqa: E402


def test_the_phone_is_the_key(monkeypatch):
    assert identity.phone("p15550001111") == "+15550001111"
    monkeypatch.setenv("CO_FOUNDER_TENANT", "dennis")
    monkeypatch.setenv("CO_FOUNDER_HANDLE", "+15550001111")
    assert identity.phone("dennis") == "+15550001111"


def test_a_name_is_recovered_from_the_address_not_configured():
    # nobody should have to type their own name into an env file
    assert "dennis" in identity._from_local_part("432dennis@example.com")
    assert identity._from_local_part("sam.rivera@acme.example") >= {"sam", "rivera"}
    assert identity._from_local_part("x@acme.example") == set()      # too short to be a name


def test_a_phone_handle_never_becomes_a_name(tmp_path, monkeypatch):
    # the whole bug: p15550001111 was being treated as what to call the member
    monkeypatch.setattr(identity, "_path", lambda t: str(tmp_path / f"{t}.json"))
    monkeypatch.setattr(identity, "_accounts_for", lambda t: [])
    st = identity.resolve("p15550001111", force=True)
    assert "p15550001111" not in st["names"]


def test_a_member_never_inherits_another_tenants_account(tmp_path, monkeypatch):
    # caught live: resolve("t7") came back "dennis" because gcal._accounts() lists ONE global
    # directory, so every tenant resolved to whichever Google account is linked on the box
    monkeypatch.setattr(identity, "_path", lambda t: str(tmp_path / f"{t}.json"))
    monkeypatch.setenv("CO_FOUNDER_TENANT", "dennis")
    monkeypatch.setattr("os.path.isdir", lambda p: False)
    assert identity._accounts_for("p15550001111") == []      # unlinked member gets nothing
    body = (CLAIMS / "identity.py").read_text().split("def _accounts_for")[1].split("\ndef ")[0]
    assert "Never inherit" in " ".join(body.split())


def test_a_handle_that_is_a_name_still_counts(tmp_path, monkeypatch):
    monkeypatch.setattr(identity, "_path", lambda t: str(tmp_path / f"{t}.json"))
    assert "isabel" in identity.resolve("isabel", force=True)["names"]


def test_is_me_matches_an_address_exactly_and_a_name_loosely(tmp_path, monkeypatch):
    monkeypatch.setattr(identity, "_path", lambda t: str(tmp_path / f"{t}.json"))
    monkeypatch.setattr(identity, "resolve",
                        lambda t, force=False: {"names": ["dennis"], "emails": ["d@x.example"]})
    assert identity.is_me("t", "d@x.example")
    assert identity.is_me("t", "Dennis Lee")
    assert not identity.is_me("t", "Hamza")
    assert not identity.is_me("t", "someone@else.example")


def test_the_guards_resolve_from_the_key_not_the_handle():
    body = (CLAIMS / "moment.py").read_text().split("def member_names")[1].split("\ndef ")[0]
    assert "identity.names(tenant)" in body
    assert "only worked for the founder" in " ".join(body.split())   # prose wraps; laws do not


def test_resolution_never_breaks_an_organ(tmp_path, monkeypatch):
    # an organ that cannot resolve identity must still run, it just runs with less
    monkeypatch.setattr(identity, "_path", lambda t: "/nonexistent/x.json")
    assert identity.names("whoever")


def test_one_roster_covers_every_lane(monkeypatch):
    # onboarding was surgery across six env vars, two of them added the same day
    import roster
    for v in ("CO_MOMENT_TENANTS", "CO_SITDOWN_TENANTS"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setenv("CO_MEMBERS", "dennis,lance")
    assert roster._rostered("lance", "CO_MOMENT_TENANTS")
    assert not roster._rostered("nobody", "CO_MOMENT_TENANTS")
    monkeypatch.setenv("CO_MOMENT_TENANTS", "dennis")     # a lane may still be held back
    assert not roster._rostered("lance", "CO_MOMENT_TENANTS")


def test_mail_and_calendar_never_read_another_members_account():
    # the leak: every organ called the flat gcal._accounts(), so a second member's brief would
    # have been built from the founder's inbox and hold() would write to his calendar
    for mod in ("gmail_guard.py", "gmail_audit.py", "gcal.py", "proactive_tick.py"):
        src = (CLAIMS / mod).read_text()
        for line in src.splitlines():
            if "_accounts()" not in line or line.strip().startswith("#"):
                continue
            ok = ("accounts_for" in line              # the scoped reader
                  or "def _accounts" in line          # its definition
                  or "CO_FOUNDER_TENANT" in line)     # the founder-only fallback inside it
            assert ok, f"{mod} still reads every account: {line.strip()}"
