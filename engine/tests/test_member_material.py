"""Only the member's own iMessage words may model the member (8/25, founder law).

Two halves, because one is not enough. SOURCE: co's own documents and fetched pages are not
the member. AUTHORSHIP: a pasted article arrived over iMessage and is still not their words.

And the failure mode was CROWDING, not ratio. Miners read a fixed tail of the corpus; one
31,899-character article pasted the day before filled that entire window, so the organ that
decides who the member wants to become read a stranger's blog and answered with the stranger.
"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLAIMS = REPO / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import journal  # noqa: E402


def test_cos_own_documents_are_not_the_member():
    assert not journal.is_member_authored("# Co- (you)\n\nYou do almost everything alone.")
    assert not journal.is_member_authored("(from our conversations) you keep saying you'll ship")


def test_pasted_article_chrome_is_not_the_member():
    assert not journal.is_member_authored("Article\nSee new posts\nConversation\n\nDAN KOE")
    assert not journal.is_member_authored("great thread\nShow more replies\nand another")


def test_a_document_length_deposit_is_never_a_message():
    assert not journal.is_member_authored("x" * (journal.DOC_CHARS + 1))
    assert journal.is_member_authored("read this, it's the best thing on agents this year")


def test_no_single_deposit_can_crowd_out_the_rest(tmp_path, monkeypatch):
    # the whole bug in one assertion: a giant paste must not dominate the mining window
    monkeypatch.setattr(journal, "_load", lambda t: {"entries": [
        {"text": "i want standards that Naval would be impressed by", "date": "2026-06-01"},
        {"text": "shipped the router change", "date": "2026-06-02"},
        {"text": "long paste " * 300, "date": "2026-08-24"},          # 3300 chars, under DOC
    ]})
    monkeypatch.setattr(journal, "_transcript_path", lambda t: str(tmp_path / "none.json"))
    mat = journal.member_material("t")
    assert max(len(x) for x in mat) <= journal.PER_ITEM_MAX
    assert any("Naval" in x for x in mat)          # the real line survives the paste


def test_cos_own_replies_are_never_evidence(tmp_path, monkeypatch):
    p = tmp_path / "t.json"
    p.write_text(json.dumps([{"role": "user", "content": "i admire how Karpathy explains"},
                             {"role": "assistant", "content": "i admire that about you too"}]))
    monkeypatch.setattr(journal, "_load", lambda t: {"entries": []})
    monkeypatch.setattr(journal, "_transcript_path", lambda t: str(p))
    mat = journal.member_material("t")
    assert mat == ["i admire how Karpathy explains"]


def test_cos_narration_of_an_image_is_stripped_but_the_act_survives():
    # how a television anchor's face in a screenshot became a watched entity: co described the
    # image, the description sat inside the member's deposit, the miner read it as their words
    s = ("https://x.com/a/b [screenshot/image they sent: a black-and-white portrait of a "
         "man who is a TV anchor] look at this")
    assert journal.scrub_annotations(s) == "https://x.com/a/b look at this"


def test_the_scrubber_survives_parens_nested_in_the_annotation():
    s = "[photo they sent (taken saturday 2026-06-06 8:24am): a man beside a car] nice"
    assert journal.scrub_annotations(s) == "nice"


def test_a_quoted_tweet_body_is_cos_rendering_not_their_sentence():
    s = "https://x.com/x/1 [shared: tweet @someone: people are going to want this]"
    assert journal.scrub_annotations(s) == "https://x.com/x/1"


def test_scrubbing_leaves_ordinary_brackets_alone():
    s = "the thing i meant (the router one) is done [finally]"
    assert journal.scrub_annotations(s) == s


def test_every_organ_that_models_the_member_uses_the_one_door():
    for mod, fn in (("entities.py", "_material"), ("becoming.py", "_admiration_lines")):
        src = (CLAIMS / mod).read_text()
        body = src.split(f"def {fn}")[1].split("\ndef ")[0]
        assert "journal.member_material" in body, f"{mod}:{fn} still reads the raw stores"
        assert "transcript.json" not in body, f"{mod}:{fn} still opens the transcript directly"


def test_conversion_reads_through_the_one_door():
    # THE CHATER BUG (8/28). He screenshotted a bookstore page; co described the image ("...the
    # book The Mind is Flat by Nick Chater..."); this lane read co's own description as something
    # he had READ, and asked him to recall its core claim eight different ways over days. The
    # word "chater" appears ZERO times in his own words.
    body = (CLAIMS / "conversion.py").read_text().split("def _deposits")[1].split("\ndef ")[0]
    assert "journal.scrub_annotations" in body
    assert "journal.is_member_authored" in body


def test_the_scrubber_kills_the_exact_narration_that_caused_it():
    s = ("[screenshot: a product page on a website, likely for an online bookstore. The page "
         "displays information about the book \"The Mind is Flat\" by Nick Chater.]")
    assert "Chater" not in journal.scrub_annotations(s)


def test_the_act_of_sending_survives_when_the_words_do_not():
    # scrubbing rightly strips co's caption from their words. But an entry that was ONLY a photo
    # then has nothing left, and co lost every trace that he sent a book in July. Both facts are
    # true — "he sent this" is an observation, "he read it" is a claim — and they need tiers.
    src = (CLAIMS / "journal.py").read_text()
    body = src.split("def deposits")[1].split("\ndef ")[0]
    assert '"observed"' in body and '"said"' in body


def test_retrieval_asks_about_the_act_never_the_contents():
    import sys as _s
    _s.path.insert(0, str(CLAIMS))
    import conversion
    sys_ = " ".join(conversion.RECALL_SYS.split())
    assert "Ask about the act, not the contents" in sys_
    assert "never imply otherwise" in sys_
    body = (CLAIMS / "conversion.py").read_text().split("def _deposits")[1].split("\ndef ")[0]
    assert "journal.deposits" in body and "not their words" in body


def test_the_corpus_cap_adapts_to_the_member(tmp_path, monkeypatch):
    # PER_ITEM was 1200, commented "this member writes long" — a number tuned to one person.
    # Someone who texts in fragments had a cap forty times their median.
    monkeypatch.setattr(journal, "_load", lambda t: {"entries": [{"text": "hey"} for _ in range(40)]})
    assert journal.per_item("terse") == journal.PER_ITEM_MIN
    monkeypatch.setattr(journal, "_load",
                        lambda t: {"entries": [{"text": "x" * 5000} for _ in range(40)]})
    assert journal.per_item("verbose") == journal.PER_ITEM_MAX
    monkeypatch.setattr(journal, "_load", lambda t: {"entries": [{"text": "hi"}]})
    assert journal.per_item("new") == journal.PER_ITEM_DEFAULT      # too little data to adapt
