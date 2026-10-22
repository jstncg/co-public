"""The eyes name only what the platform names.

9/2: co's reaction read of an 84-minute interview called the guest the CEO of a company he has never
worked for. yt-dlp had the correct title and channel the whole time; the watch never saw them because
metadata was only consulted after a FAILED watch. These pin the fix: every YouTube pass carries the
platform's own facts in front of the prompt, and both video prompts forbid guessing identity.
"""
import sys
from pathlib import Path

CLAIMS = Path(__file__).resolve().parents[2] / "frame" / "claims"
sys.path.insert(0, str(CLAIMS))

import link_read  # noqa: E402

URL = "https://youtu.be/uyzqxIoiobU"
META = "Ex-NVIDIA Engineer: Why AI Is About to Get 1000x Cheaper — by Invest Like The Best — Neil Movva"


def test_video_prompts_forbid_guessing_identity():
    assert link_read.NO_GUESS in link_read.DEEP_PROMPT
    assert link_read.NO_GUESS in link_read.EXPLAIN_PROMPT


def test_single_pass_watch_carries_platform_metadata(monkeypatch):
    seen = []
    monkeypatch.setattr(link_read, "_ytdlp_meta", lambda url, timeout=20: META)
    monkeypatch.setattr(link_read, "_yt_try",
                        lambda client, url, prompt, fps, start=None, end=None: (seen.append(prompt) or ("a read", "ok")))
    assert link_read._yt_watch(None, URL) == "a read"
    assert len(seen) == 1
    assert META in seen[0] and link_read.DEEP_PROMPT in seen[0]
    assert seen[0].index(META) < seen[0].index(link_read.DEEP_PROMPT)


def test_chunked_watch_carries_metadata_on_every_window(monkeypatch):
    """The path the 84-minute interview actually took: three too-big passes, then 20-minute windows."""
    seen = []

    def yt_try(client, url, prompt, fps, start=None, end=None):
        seen.append(prompt)
        return (None, "too_big") if start is None else (f"notes {start}", "ok")

    monkeypatch.setattr(link_read, "_ytdlp_meta", lambda url, timeout=20: META)
    monkeypatch.setattr(link_read, "_yt_try", yt_try)
    monkeypatch.setattr(link_read, "_yt_duration", lambda url, timeout=20: 2400.0)
    monkeypatch.setattr(link_read, "_gemini_generate", lambda client, contents: "combined")
    assert link_read._yt_watch(None, URL) == "combined"
    assert len(seen) == 3 + 2
    assert all(META in p for p in seen)


def test_no_metadata_still_watches_with_the_rule(monkeypatch):
    seen = []
    monkeypatch.setattr(link_read, "_ytdlp_meta", lambda url, timeout=20: None)
    monkeypatch.setattr(link_read, "_yt_try",
                        lambda client, url, prompt, fps, start=None, end=None: (seen.append(prompt) or ("a read", "ok")))
    assert link_read._yt_watch(None, URL) == "a read"
    assert seen[0] == link_read.DEEP_PROMPT
    assert link_read.NO_GUESS in seen[0]


# 9/5: a scanned page came back as a two-sentence summary, so when they asked what it SAID co had
# only its own gist, refetched the source (401) and offered a screenshot read the same path could
# not deliver. The prompt must ask for the text when the image IS text, and the Claude fallback —
# which is where a RECITATION-blocked page lands — must be able to carry a page, not a caption.
def test_image_prompt_asks_for_text_when_the_image_is_text():
    p = link_read.IMAGE_PROMPT
    assert "TEXT:" in p
    assert "MOSTLY TEXT" in p
    assert p.index("one or two sentences") < p.index("TEXT:")   # description still leads


def test_claude_image_fallback_can_carry_a_page():
    assert link_read.IMAGE_MAX_TOKENS >= 1000, "truncates a page of text"


def test_one_image_read_cannot_flood_the_turn(monkeypatch):
    monkeypatch.setattr(link_read, "_gemini_client", lambda: None)
    monkeypatch.setattr(link_read, "_claude_image", lambda d, m, p: "x" * 50_000)
    assert len(link_read.read_image(b"", "image/png")) == link_read.READ_MAX
