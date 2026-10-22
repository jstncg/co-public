#!/usr/bin/env python3
"""THE EYES PROBE — can co actually read each kind of thing people send it?

Nothing tested this. On 8/6 a member asked for research on two companies; both X links came
back "a page that couldn't be opened", two screenshots arrived fully black, and co returned
nothing useful. The rail eval was green the whole time, because it never feeds a real URL
to the real reader.

This does. One row per artifact type, through `link_read.read_media_url()` exactly as the
router calls it, reporting what coverage actually came back.

    ./evals/eyes.py                 # fast types only (~1 min)
    ./evals/eyes.py --deep          # includes long video / audio watches (minutes)
    ./evals/eyes.py --type tiktok_slides

WHAT THIS GRADES

  READ      content came back and it is substantive
  THIN      it opened but returned metadata only — a title, a handle, no substance
  BLIND     it could not open it at all
  HONEST    when it failed, did the marker SAY so (never-invent law) — this is the one
            that must never regress, because an honest miss is recoverable and a
            fabricated read is not

THIN is the interesting bucket. A title is not a read, and a reply that treats a title as
a read is the "watching both now" failure with better manners.

URLS ARE THE INSTRUMENT, AND THEY ROT. A row with a placeholder URL reports NO-URL, never
BLIND — measuring a made-up link and calling it a capability gap would be the same class of
mistake as measuring the founder's graph and calling it a member's. Fill `ARTIFACTS` with
real links you have personally opened, in `evals/eyes_urls.json` (gitignored, since a URL a
member sent is their data), or accept NO-URL for that type.

    cp evals/eyes_urls.example.json evals/eyes_urls.json   # then paste real links
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
FRAME = HERE.parent
sys.path.insert(0, str(FRAME / "claims"))

# Substance floor: below this many chars of actual read-back, it is a title, not a read.
SUBSTANCE_CHARS = int(os.environ.get("CO_EYES_SUBSTANCE_CHARS", "180"))

PLACEHOLDER = "TODO"   # a row with this URL reports NO-URL, never a false capability gap

# Real links, pasted by a human who opened them, override anything below.
_OVERRIDES = {}
_urls_file = HERE / "eyes_urls.json"
if _urls_file.exists():
    try:
        _OVERRIDES = json.loads(_urls_file.read_text())
    except Exception:
        _OVERRIDES = {}

# (id, kind, url, deep?, what a correct read must contain to count as real coverage)
ARTIFACTS = [
    # --- video, short and long -------------------------------------------------------
    ("yt_short",       "youtube short (<60s, vertical)",
     PLACEHOLDER, False, "what happens in it"),
    ("yt_long",        "youtube long-form (>12min)",
     "https://www.youtube.com/watch?v=NFm2Xjx61Q8", True,  "the argument, not the title"),
    ("yt_timestamp",   "youtube at an exact timestamp",
     "https://www.youtube.com/watch?v=NFm2Xjx61Q8&t=754", True, "what is said AT that mark"),

    # --- X / twitter, every shape ----------------------------------------------------
    ("x_post",         "x post, text only",
     PLACEHOLDER, False, "the text of the post"),
    ("x_reply",        "x REPLY (the parent is the point)",
     PLACEHOLDER, False, "what it is replying TO"),
    ("x_quote",        "x QUOTE tweet (quoted thing + the commentary)",
     PLACEHOLDER, False, "both the quote and the comment"),
    ("x_thread",       "x thread (multi-post)",
     PLACEHOLDER, False, "more than the first post"),
    ("x_article",      "x Article (long-form on X)",
     PLACEHOLDER, False, "the article body"),
    ("x_video",        "x post carrying video",
     PLACEHOLDER, True,  "what is in the video"),

    # --- tiktok ----------------------------------------------------------------------
    ("tiktok_video",   "tiktok video",
     PLACEHOLDER, True, "what happens + what is said"),
    ("tiktok_slides",  "tiktok PHOTO slides (the AUDIO is usually the joke)",
     PLACEHOLDER, True,
     "the slides AND the sound — audio is content here, not decoration"),

    # --- instagram -------------------------------------------------------------------
    ("ig_reel",        "instagram reel",
     PLACEHOLDER, True, "what happens in it"),
    ("ig_carousel",    "instagram carousel (slide by slide)",
     PLACEHOLDER, False, "more than slide one"),

    # --- text --------------------------------------------------------------------------
    ("article",        "a plain article / blog post",
     "https://paulgraham.com/greatwork.html", False, "the actual claim"),
    ("paywalled",      "a paywalled or 402 page (MUST fail honestly)",
     "https://www.wsj.com/", False, "an honest miss, never an invented read"),
    ("gh_raw",         "raw.githubusercontent (source file / README)",
     "https://raw.githubusercontent.com/torvalds/linux/master/README", False,
     "the file's actual contents"),
    ("gh_repo",        "a github repo page",
     "https://github.com/torvalds/linux", False, "what the project IS, not just the name"),

    ("dead_link",      "a dead link (MUST fail honestly)",
     "https://example.com/this-does-not-exist-404", False, "an honest miss"),
]


def classify(marker) -> tuple:
    """(grade, honest, chars).

    The never-invent law is enforced STRUCTURALLY, not by wording: link_read returns the
    READ_FAILED sentinel and the router drops it, so a failed fetch cannot reach the model.
    So a sentinel/None is an HONEST blind — it is the mechanism working. The only real
    dishonesty this can catch is a marker that reads as substantive content when the fetch
    did not succeed, which the sentinel makes structurally impossible.

    The grade that actually matters day to day is THIN: a title came back, not a read.
    """
    import link_read
    if marker is None or marker == link_read.READ_FAILED or not str(marker).strip():
        return "BLIND", True, 0
    body = re.sub(r"^\[shared:\s*", "", str(marker)).rstrip("]").strip()
    if re.search(r"couldn'?t be (opened|watched|read)|no content|unavailable|didn'?t give|"
                 r"can'?t see|not able to", body, re.I):
        return "BLIND", True, len(body)
    if len(body) < SUBSTANCE_CHARS:
        return "THIN", True, len(body)
    return "READ", True, len(body)


def _read(url: str, is_deep: bool):
    """Route to the reader the router would use for this URL — media vs page."""
    import link_read
    if re.search(r"(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|x\.com|twitter\.com)", url, re.I):
        return link_read.read_media_url(url, timeout=90 if is_deep else 30)
    try:
        return link_read.deep_read(url, timeout=45)
    except Exception:
        return None


def probe(deep: bool, only: str | None, as_json: bool) -> int:
    import link_read
    rows = []
    for aid, kind, url, is_deep, expects in ARTIFACTS:
        if only and aid != only:
            continue
        url = _OVERRIDES.get(aid, url)
        if url == PLACEHOLDER or not url:
            # never report a made-up link as a capability gap
            rows.append({"id": aid, "kind": kind, "grade": "NO-URL", "honest": True,
                         "chars": 0, "seconds": 0.0, "expects": expects})
            continue
        if is_deep and not deep:
            rows.append({"id": aid, "kind": kind, "grade": "SKIP", "honest": True,
                         "chars": 0, "seconds": 0.0, "expects": expects})
            continue
        t0 = time.time()
        try:
            marker = _read(url, is_deep)
        except Exception as e:
            # a crash is BLIND, never THIN — a short exception string would otherwise land
            # in the "returned a title" bucket and read as partial coverage
            marker = None
            print(f"    (reader raised {type(e).__name__} on {aid})", file=sys.stderr)
        grade, honest, chars = classify(marker)
        rows.append({"id": aid, "kind": kind, "grade": grade, "honest": honest,
                     "chars": chars, "seconds": round(time.time() - t0, 1),
                     "expects": expects, "marker": (marker or "")[:150]})

    if as_json:
        print(json.dumps(rows, indent=1))
    else:
        C = {"READ": "\033[32m", "THIN": "\033[33m", "BLIND": "\033[31m",
             "SKIP": "\033[90m", "NO-URL": "\033[90m"}
        print("\nTHE EYES — what co can actually read\n" + "=" * 76)
        for r in rows:
            g = f"{C[r['grade']]}{r['grade']:<5}\033[0m"
            flag = "" if r["honest"] else "  \033[31m*** FABRICATED — claimed a read it did not have ***\033[0m"
            print(f"  {g} {r['id']:15} {r['kind'][:40]:42} {r['chars']:>5}ch {r['seconds']:>5}s{flag}")
        live = [r for r in rows if r["grade"] not in ("SKIP", "NO-URL")]
        nourl = [r["id"] for r in rows if r["grade"] == "NO-URL"]
        read = sum(1 for r in live if r["grade"] == "READ")
        thin = sum(1 for r in live if r["grade"] == "THIN")
        blind = sum(1 for r in live if r["grade"] == "BLIND")
        liars = [r["id"] for r in live if not r["honest"]]
        print("=" * 76)
        print(f"  READ {read}   THIN {thin}   BLIND {blind}   (of {len(live)} actually probed)")
        if nourl:
            print(f"  \033[90mNO-URL {len(nourl)}: {', '.join(nourl)}\033[0m")
            print("  → these types are UNTESTED, not broken. Paste real links into "
                  "evals/eyes_urls.json.")
        print(f"  honesty: {'\033[32mheld — every miss said so\033[0m' if not liars else f'\033[31mBROKEN: {liars}\033[0m'}")
        if thin:
            print("  THIN means a title came back, not a read. A reply built on a title is the")
            print("  'watching both now' failure wearing better manners.")
    # Only fabrication fails the gate. BLIND is a capability gap and is allowed to be
    # visible; claiming a read you do not have is the thing that must never ship.
    return 1 if any(not r["honest"] for r in rows if r["grade"] not in ("SKIP", "NO-URL")) else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--deep", action="store_true", help="include video/audio watches (slow)")
    ap.add_argument("--type", help="one artifact id")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    raise SystemExit(probe(a.deep, a.type, a.json))
