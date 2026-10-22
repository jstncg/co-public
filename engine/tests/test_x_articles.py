"""X Articles read as articles (8/28).

Co reported every X Article as unreadable for months while the fetch worked the whole time. The
bug was ordering: for an Article URL, _x_read asked the fxtwitter mirror FIRST, "in case X
exposes the same id both ways". It does — and what comes back is the TWEET that links to the
article plus a note saying the article is JS-walled. That is truthy, so the short-circuit fired
and the page read never ran.

An Article IS long-form prose at a URL. Read the URL.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import link_read  # noqa: E402


def test_an_article_url_is_recognised_and_is_not_a_status():
    # short fixture id on purpose: a realistic 19-digit article id contains a phone-shaped
    # substring and trips the repo's pre-commit guard, which is doing its job
    u = "https://x.com/someone/article/4242"
    assert not link_read.X_RE.search(u)
    m = link_read.X_ARTICLE_RE.search(u)
    assert m and m.group(3) == "4242"


def test_the_page_read_leads_for_articles(monkeypatch):
    # the fallback must never be able to short-circuit the thing that works
    calls = []
    monkeypatch.setattr(link_read, "_page_read",
                        lambda u, prompt=None: calls.append("page") or "the body")
    monkeypatch.setattr(link_read, "_fx_read",
                        lambda t, timeout=20: calls.append("fx") or "the tweet, js-walled")
    got = link_read._x_read("https://x.com/a/article/4242")
    assert got.startswith("x article —") and "the body" in got
    assert calls == ["page"]                      # fx never consulted when the page read works


def test_the_mirror_is_only_a_fallback(monkeypatch):
    calls = []
    monkeypatch.setattr(link_read, "_page_read", lambda u, prompt=None: calls.append("page"))
    monkeypatch.setattr(link_read, "_fx_read",
                        lambda t, timeout=20: calls.append("fx") or "at least whose it is")
    got = link_read._x_read("https://x.com/a/article/4242")
    assert calls == ["page", "fx"] and got == "at least whose it is"


def test_a_plain_tweet_still_prefers_the_mirror(monkeypatch):
    # fxtwitter carries media, quotes and the parent chain in one payload; the ordering fix must
    # not touch the status path
    calls = []
    monkeypatch.setattr(link_read, "_fx_read",
                        lambda t, timeout=20: calls.append("fx") or "tweet @x: hello")
    got = link_read._x_read("https://x.com/a/status/123456789")
    assert got == "tweet @x: hello" and calls == ["fx"]


def test_the_ordering_reason_is_written_where_it_can_be_undone():
    body = (CLAIMS / "link_read.py").read_text().split("def _x_read")[1].split("\ndef ")[0]
    assert "PAGE FIRST FOR ARTICLES" in body
    assert "short-circuit" in body


def test_a_tweet_linking_to_an_article_falls_back_to_the_post_page(monkeypatch):
    # the commonest long-form share on X, and the shape the founder actually sends. The
    # /article/<id> URL the card advertises frequently 404s in BOTH forms ("Article Not Found"),
    # while the same post returns ~20k clean characters as a status.
    body = (CLAIMS / "link_read.py").read_text()
    blk = body.split("THE ARTICLE LIVES ON THE TWEET PAGE")[1][:700]
    assert "x.com/i/status/{tid}" in blk
    assert "_page_read" in blk and "ARTICLE_PROMPT" in blk


def test_the_honest_failure_survives_when_both_paths_fail():
    body = (CLAIMS / "link_read.py").read_text()
    blk = body.split("THE ARTICLE LIVES ON THE TWEET PAGE")[1][:1200]
    assert "NEVER guess at what it says" in blk          # still refuses to invent
