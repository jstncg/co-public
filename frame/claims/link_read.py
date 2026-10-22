#!/usr/bin/env python3
"""The eyes — read what they sent (links, reels, tweets, screenshots) into text the reaction can use.

What someone shares is a dimension of who they are. CHEAP EYES, EXPENSIVE MOUTH: Gemini flash-lite does all
the watching/summarizing here; the reaction line is phrased elsewhere by the strongest available Claude.

Per-platform paths (all degrade gracefully — a link we can't open flags itself, it never breaks capture):
  YouTube    → NATIVE Gemini video understanding (file_data URI — Google owns YouTube, no download),
               yt-dlp metadata as the fallback.
  Instagram  → Apify instagram-scraper (run-sync): caption + owner + type. Thin caption + a videoUrl →
               download the mp4 and let Gemini watch it. (Verified live 7/1 on a real natgeo reel.)
  X/Twitter  → X_API_BEARER if present in env, else the keyless fxtwitter JSON API (verified live 7/1).
  TikTok/etc → yt-dlp metadata, escalating to download+Gemini-watch when the caption is too thin.
  Images     → read_media_url() (Sendblue attachment CDN) → Gemini flash-lite vision: what app, what
               content, what on-screen text. The router feeds inbound MMS through this.

  yt-dlp must be on PATH (it is on homebase). Network required. GEMINI_API_KEY/GOOGLE_API_KEY in env.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time

URL_RE = re.compile(r"https?://[^\s]+")
IG_RE = re.compile(r"instagram\.com", re.I)
YT_RE = re.compile(r"(youtube\.com|youtu\.be)", re.I)
X_RE = re.compile(r"(?:^|//|\.)((twitter|x)\.com)/\w+/status/(\d+)", re.I)
# X long-form Articles live at /i/article/<id> (or /<user>/article/<id>) and never matched X_RE, so
# they fell through to the generic page reader and died on X's JS wall (7/27).
X_ARTICLE_RE = re.compile(r"(?:^|//|\.)((twitter|x)\.com)/(?:i|\w+)/article/(\d+)", re.I)

X_TEXT_CAP = 6000   # long-form posts and Articles are the point; 280 threw the body away
CAROUSEL_MAX = 10   # slides read per carousel; beyond this the reaction gets a count, not silence
DEFER_SECONDS = int(__import__('os').environ.get('CO_DEFER_WATCH_SECONDS', '720'))
THIN = 40   # metadata shorter than this → escalate to the Gemini deep-read
# CO_EYES_MODEL="google/<model>" (the eyes are google-only in practice: native video/audio/vision).
# A non-google spec is ignored with a warning — Claude stays the image-only fallback inside read_image.
_eyes = os.environ.get("CO_EYES_MODEL", "")
if _eyes and not _eyes.startswith("google/"):
    print(f"(CO_EYES_MODEL {_eyes!r} ignored — eyes are google-only; using default)", file=__import__("sys").stderr)
    _eyes = ""
GEMINI_MODEL = (_eyes.split("/", 1)[1] if _eyes else os.environ.get("CO_GEMINI_MODEL", "gemini-3.5-flash-lite"))

# Identity is never inferred from frames: on 9/2 the reaction read named the guest of an 84-minute
# interview as the CEO of a company he has never worked for, because the prompt let the model guess
# from the topic. People and organisations are named only as the platform metadata or on-screen text
# names them (IMAGE_PROMPT already held this line; the video prompts did not).
NO_GUESS = ("Name people and organisations ONLY as the given metadata or on-screen text names them; if "
            "someone is not named there, describe them instead of guessing.")
DEEP_PROMPT = ("In one or two sentences: what is this clip actually about, and what does sharing it suggest the "
               "person is drawn to? Describe only what's in the clip — the topic, the vibe, the on-screen text. "
               "No psychoanalysis, no reaching. If it's just funny or random, say that. " + NO_GUESS)
# The explain-ask re-watch (7/15): DEEP_PROMPT is built for reactions (2 sentences, cheap). When the person
# asks to have a video actually EXPLAINED, the router re-watches with this instead.
EXPLAIN_PROMPT = ("They asked to have this video actually explained. Explain it like a sharp friend who just "
                  "watched it: the core argument or story, the key points with the specific examples, names and "
                  "numbers shown, and anything genuinely surprising or non-obvious. 120-200 words of plain "
                  "prose. No headers, no bullets, no preamble. " + NO_GUESS)
IMAGE_PROMPT = ("In one or two sentences: what does this image/screenshot actually show? IDENTIFY what's "
                "recognizable when you're confident: public figures by name, landmarks, car makes and models, "
                "brands, apps/sites — and quote the key on-screen text. If you're not sure who or what "
                "something is, describe it plainly instead of guessing. If it's a meme, say what the joke is. "
                "No psychoanalysis, no reaching. "
                # THE PAGE THEY SENT (9/5): a two-sentence read is right for a photo and wrong for a PAGE.
                # A scanned page came back as "a page of text starting 'physical excellence…'" — so when
                # they asked what it SAID, co had only its own summary, went back to x for the source
                # (401), and offered "screenshot it and i can actually read it" — a promise the same
                # two-sentence path could never keep. The description stays first (it is what a reaction
                # needs); the text rides after it, for the asks that come later.
                "Then, ONLY if the image is MOSTLY TEXT — a page, a note, a screenshot of a message or "
                "an article — add a line 'TEXT:' followed by that text transcribed as written. If the "
                "image is not mostly text, leave the TEXT line out entirely.")
# A page-long TEXT block is the point above, but NOTHING downstream bounds the enrichment
# (router builds `enriched` by plain concatenation) and a carousel reads up to CAROUSEL_MAX
# slides — so one read never grows past a dense page.
READ_MAX = 4000
IMAGE_MAX_TOKENS = 1500      # the Claude fallback must carry a page, not a caption
VOICE_PROMPT = ("This is a voice note someone sent to a friend. Transcribe what they say, verbatim but cleaned of "
                "filler (um, uh). Return ONLY the transcript text — no preamble, no quotes, no description.")
READ_FAILED = "__READ_FAILED__"   # sentinel the router checks — a failed read NEVER reaches the model

# 7/24: articles had NO path at all — every blog post, substack, paper and PDF ever sent came back
# "a link that couldn't be opened" because the generic branch only tried yt-dlp. These read the page.
ARTICLE_PROMPT = ("In two or three sentences: what does this piece actually argue or report, and what would "
                  "make someone send it to a friend? Name the specific claim, not the topic. Quote a number or "
                  "a phrase if one carries the point. No preamble, no 'this article discusses'.")
ARTICLE_EXPLAIN_PROMPT = ("They asked to have this piece actually explained. Explain it like a sharp friend who "
                          "just read it: the core argument, the evidence behind it, the specific names, numbers "
                          "and examples, and anything genuinely surprising. 120-200 words of plain prose. No "
                          "headers, no bullets, no preamble.")
# Known video hosts keep the download-and-watch path; everything else is a page to be read.
VIDEO_HOST_RE = re.compile(r"(tiktok\.com|vimeo\.com|twitch\.tv|dailymotion\.com|streamable\.com|v\.redd\.it)", re.I)
PAGE_MAX_BYTES = 6_000_000     # don't stream a video into memory by accident
PAGE_MAX_CHARS = 40_000        # ~10k tokens of article is plenty for a read
PAGE_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
           "Chrome/125.0 Safari/537.36")
# jina is the one host that must NOT get PAGE_UA: r.jina.ai sits behind Cloudflare, and a browser UA
# from a datacenter IP reads as a bot impersonating a browser — it answers 403 with a challenge page
# (found 8/7; the bot-walled fallback had been failing closed on every call since it was written).
# A key is optional and only lifts the keyless rate cap.
JINA_HEADERS = {"Accept": "text/plain",
                **({"Authorization": f"Bearer {os.environ['JINA_API_KEY']}"} if os.environ.get("JINA_API_KEY") else {})}


def find_urls(text: str):
    return URL_RE.findall(text or "")


# ── gemini plumbing (SDK, flash-lite everywhere) ─────────────────────────────────────────────────────
def _gemini_client():
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        return None
    try:
        from google import genai
        return genai.Client(api_key=key)
    except Exception:
        return None


def _gemini_generate(client, contents):
    """generate_content with overload resilience: flash-lite twice (503s spike), then flash once.
    CO_FORCE_GEMINI_FAIL=1 simulates quota death (429) for acceptance tests."""
    if os.environ.get("CO_FORCE_GEMINI_FAIL") == "1":
        return None
    for model, wait in ((GEMINI_MODEL, 2), (GEMINI_MODEL, 0), ("gemini-2.5-flash", 0)):
        try:
            resp = client.models.generate_content(model=model, contents=contents)
            return (resp.text or "").strip() or None
        except Exception as e:
            if "503" in str(e) or "UNAVAILABLE" in str(e) or "429" in str(e):
                if wait:
                    time.sleep(wait)
                continue
            return None
    return None


_VIDEO_EXT = (".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp", ".mpg", ".mpeg")
TOKEN_CEILING = 1_048_576
TOKEN_SAFE = 900_000          # leave room for the prompt and the response


def _gemini_watch(path: str, prompt: str = DEEP_PROMPT, timeout: int = None):
    """Upload a local media file and let Gemini watch/read it. None on any failure.

    7/24: a LONG attachment failed twice over and said nothing. A 70-minute video measured at
    1,239,887 tokens (ceiling 1,048,576) AND took 112s to finish processing against a hardcoded 90s
    poll. Now: the poll scales with file size, and video that would blow the ceiling is sampled down
    (measured, not guessed — count_tokens picks the rate) instead of silently failing."""
    client = _gemini_client()
    if not client:
        return None
    try:
        from google.genai import types
        try:
            size_mb = os.path.getsize(path) / 1_000_000
        except OSError:
            size_mb = 0
        # big files genuinely take minutes to become ACTIVE; 90s was a guess that long clips lose.
        deadline = time.time() + (timeout if timeout else max(90, int(size_mb * 3) + 60))

        up = client.files.upload(file=path)
        while getattr(up, "state", None) and str(up.state) not in ("FileState.ACTIVE", "ACTIVE"):
            if str(up.state) in ("FileState.FAILED", "FAILED") or time.time() > deadline:
                return None
            time.sleep(2)
            up = client.files.get(name=up.name)

        if not path.lower().endswith(_VIDEO_EXT):
            return _gemini_generate(client, [up, prompt])

        # video: measure before spending a call, then sample down only as far as needed.
        try:
            total = client.models.count_tokens(model=GEMINI_MODEL, contents=[up, prompt]).total_tokens
        except Exception:
            total = 0
        if total and total <= TOKEN_SAFE:
            return _gemini_generate(client, [up, prompt])

        for fps in (0.5, 0.2, 0.1):
            part = types.Part(file_data=types.FileData(file_uri=up.uri, mime_type="video/mp4"),
                              video_metadata=types.VideoMetadata(fps=fps))
            contents = types.Content(parts=[part, types.Part(text=prompt)])
            try:
                n = client.models.count_tokens(model=GEMINI_MODEL, contents=contents).total_tokens
            except Exception:
                n = 0
            if n and n > TOKEN_SAFE:
                continue
            cfg = types.GenerateContentConfig(media_resolution=types.MediaResolution.MEDIA_RESOLUTION_LOW)
            for model in (GEMINI_MODEL, "gemini-2.5-flash"):
                try:
                    resp = client.models.generate_content(model=model, contents=contents, config=cfg)
                    txt = (resp.text or "").strip()
                    if txt:
                        return txt
                except Exception as e:
                    s = str(e)
                    if "exceeds the maximum number of tokens" in s or "token count" in s:
                        break                                  # sample sparser
                    if "503" in s or "UNAVAILABLE" in s or "429" in s:
                        continue
                    return None
        return None
    except Exception:
        return None


def _claude_image(data: bytes, mime: str, prompt: str):
    """Claude vision fallback (7/2: Gemini free-tier quota death must never surface to the user).
    haiku first (fast, uncapped overnight), sonnet second. None on failure."""
    if os.environ.get("CO_FORCE_VISION_FAIL") == "1":
        return None
    tok = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")
    if not tok:
        return None
    import base64
    try:
        import requests
        # 200 was sized for the two-sentence read and silently truncated anything longer. Gemini
        # returns RECITATION (empty) on a page of printed text, which drops the read HERE — so this
        # is the path that has to be able to carry a whole page, not a caption.
        payload = {"model": "claude-haiku-4-5", "max_tokens": IMAGE_MAX_TOKENS,
                   "messages": [{"role": "user", "content": [
                       {"type": "image", "source": {"type": "base64", "media_type": mime,
                                                    "data": base64.b64encode(data).decode()}},
                       {"type": "text", "text": prompt}]}]}
        headers = ({"authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20"}
                   if os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") else {"x-api-key": tok})
        headers.update({"anthropic-version": "2023-06-01", "content-type": "application/json"})
        for model in ("claude-haiku-4-5", "claude-sonnet-4-6"):
            payload["model"] = model
            r = requests.post("https://api.anthropic.com/v1/messages", json=payload, headers=headers, timeout=45)
            if r.status_code == 429:
                continue
            r.raise_for_status()
            out = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text").strip()
            if out:
                return out
    except Exception:
        pass
    return None


def _exif_context(data: bytes):
    """When/where a full-quality camera photo was taken (iMessage preserves EXIF) → friend-context string
    like "taken saturday 2026-06-28 11:11pm, near Silver Lake, California". RESTRAINT LAW: place NAME and
    local time only — coordinates never leave this function. Screenshots have no EXIF → None, silently."""
    try:
        import io
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        exif = img.getexif()
        if not exif:
            return None
        import datetime as _dt
        when = None
        try:
            raw = exif.get_ifd(0x8769).get(36867) or exif.get(306)   # DateTimeOriginal, else DateTime
        except Exception:
            raw = exif.get(306)
        if raw:
            try:
                t = _dt.datetime.strptime(str(raw), "%Y:%m:%d %H:%M:%S")
                when = t.strftime("%A %Y-%m-%d %I:%M%p").lower().replace(" 0", " ")
            except ValueError:
                when = None
        place = None
        try:
            g = exif.get_ifd(0x8825)                                  # GPS IFD
            def _deg(v, ref):
                d = float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600
                return -d if ref in ("S", "W") else d
            if g and 2 in g and 4 in g:
                lat = _deg(g[2], g.get(1, "N"))
                lon = _deg(g[4], g.get(3, "E"))
                try:
                    import reverse_geocoder as rg                     # offline, no network
                    hit = rg.search((lat, lon), mode=1)[0]
                    place = f"{hit['name']}, {hit['admin1']}"
                except Exception:
                    place = None
        except Exception:
            place = None
        if not when and not place:
            return None
        parts = [f"taken {when}" if when else "", f"near {place}" if place else ""]
        return ", ".join(x for x in parts if x)
    except Exception:
        return None


def _exif_tz_update(data: bytes, claims_db: str) -> None:
    """Fresh camera photo (taken <24h ago) with GPS → move the tenant clock (timezonefinder, offline).
    Old trip photos never touch the clock. Silent on any failure."""
    try:
        import io
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        exif = img.getexif()
        raw = exif.get_ifd(0x8769).get(36867) if exif else None
        if not raw:
            return
        import datetime as _dt
        taken = _dt.datetime.strptime(str(raw), "%Y:%m:%d %H:%M:%S")
        if abs((_dt.datetime.now() - taken).total_seconds()) > 24 * 3600:
            return
        g = exif.get_ifd(0x8825)
        if not (g and 2 in g and 4 in g):
            return
        def _deg(v, ref):
            d = float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600
            return -d if ref in ("S", "W") else d
        lat, lon = _deg(g[2], g.get(1, "N")), _deg(g[4], g.get(3, "E"))
        from timezonefinder import TimezoneFinder
        tz = TimezoneFinder().timezone_at(lat=lat, lng=lon)
        if tz:
            import tz_dynamic
            tz_dynamic.set_tz(claims_db, tz, "fresh photo EXIF GPS")
    except Exception:
        pass


def read_image(data: bytes, mime: str = "image/jpeg", prompt: str = IMAGE_PROMPT):
    """Vision with a quota-proof chain: gemini flash-lite → flash → CLAUDE. None only when all are down."""
    what = None
    client = _gemini_client()
    if client and os.environ.get("CO_FORCE_VISION_FAIL") != "1":
        try:
            from google.genai import types
            what = _gemini_generate(client, [types.Part.from_bytes(data=data, mime_type=mime), types.Part(text=prompt)])
        except Exception:
            what = None
    got = what or _claude_image(data, mime, prompt)
    return got[:READ_MAX] if got else got


_EXT_MIME = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif",
             "heic": "image/heic", "webp": "image/webp", "mp4": "video/mp4", "mov": "video/quicktime",
             "m4a": "audio/mp4", "aac": "audio/aac", "mp3": "audio/mpeg", "wav": "audio/wav",
             "amr": "audio/amr", "caf": "audio/x-caf", "ogg": "audio/ogg"}


def _to_gemini_audio(path: str) -> str:
    """Gemini doesn't take CAF/AMR (the iMessage voice-note containers) — convert via macOS afconvert."""
    ext = path.rsplit(".", 1)[-1].lower()
    if ext not in ("caf", "amr"):
        return path
    out = path[: -len(ext) - 1] + ".converted.m4a"
    try:
        r = subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", path, out],
                           capture_output=True, timeout=60)
        if r.returncode == 0 and os.path.exists(out):
            return out
    except Exception:
        pass
    return path


def read_media_url(url: str, timeout: int = 60, claims_db: str = ""):
    """A Sendblue attachment URL (or a local path, for tests/local rails) → what it shows/says.
    Images → vision (gemini→claude chain); video → watched; AUDIO → TRANSCRIBED (a voice note IS them
    talking — the enrichment carries the transcript, never an 'audio file'). Returns READ_FAILED when the
    bytes arrived but no reader could see them — the router turns that into ONE honest line, never the
    model improvising blame. None only when there was nothing to read."""
    try:
        local = url.startswith("/") or url.startswith("file://")
        if local:
            path_in = url[7:] if url.startswith("file://") else url
            with open(path_in, "rb") as f:
                content = f.read()
            mime = _EXT_MIME.get(path_in.rsplit(".", 1)[-1].lower(), "image/jpeg")
        else:
            import requests
            r = requests.get(url, timeout=timeout)
            r.raise_for_status()
            content = r.content
            mime = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if not mime or mime == "application/octet-stream":
                ext = url.rsplit(".", 1)[-1].lower().split("?")[0]
                mime = _EXT_MIME.get(ext, "image/jpeg")
        if mime.startswith("image/"):
            what = read_image(content, mime)
            if not what:
                return READ_FAILED
            if claims_db:
                _exif_tz_update(content, claims_db)
            ctx = _exif_context(content)
            # camera photo with EXIF → the friend-who-was-there context rides in the same bracket
            if ctx:
                return f"[photo they sent ({ctx}): {what}]"
            return f"[screenshot/image they sent: {what}]"
        if mime.startswith(("video/", "audio/")):
            import tempfile
            ext = mime.split("/")[-1].replace("x-", "")
            if mime == "audio/mp4":
                ext = "m4a"
            with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False) as f:
                f.write(content)
                p = f.name
            paths = [p]
            if mime.startswith("audio/"):
                g = _to_gemini_audio(p)
                if g != p:
                    paths.append(g)
                said = _gemini_watch(g, prompt=VOICE_PROMPT)
                what = f'[voice note, them talking: "{said.strip()}"]' if said else READ_FAILED
            else:
                seen = _gemini_watch(p)
                what = f"[clip they sent: {seen}]" if seen else READ_FAILED
            for q in paths:
                try:
                    os.remove(q)
                except OSError:
                    pass
            return what
        return None
    except Exception:
        return READ_FAILED


# ── yt-dlp metadata (fast, no download) ──────────────────────────────────────────────────────────────
def _ytdlp_meta(url: str, timeout: int = 20):
    """Title + creator + caption snippet via yt-dlp, no media download. None on any failure/timeout."""
    try:
        out = subprocess.run(["yt-dlp", "-j", "--skip-download", "--no-warnings", "--no-playlist", url],
                             capture_output=True, text=True, timeout=timeout)
    except Exception:
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None
    try:
        d = json.loads(out.stdout.splitlines()[0])
    except json.JSONDecodeError:
        return None
    title = (d.get("title") or "").strip()
    who = (d.get("uploader") or d.get("channel") or "").strip()
    desc = (d.get("description") or "").strip().replace("\n", " ")[:200]
    parts = [p for p in [title, f"by {who}" if who else "", desc] if p]
    return " — ".join(parts) if parts else None


def _tiktok_oembed(url: str, timeout: int = 12):
    """TikTok photo-mode posts (slides + music) fail through yt-dlp — the keyless oEmbed still
    answers with title + author, so the read degrades to honest metadata instead of 'couldn't
    be opened'. Works for regular videos too (used only after yt-dlp came back empty)."""
    try:
        import requests
        r = requests.get("https://www.tiktok.com/oembed", params={"url": url.split("?")[0]},
                         timeout=timeout, headers={"User-Agent": PAGE_UA})
        if not r.ok:
            return None
        d = r.json()
        title = _strip_tag_wall((d.get("title") or "").replace("\n", " ").strip())
        who = (d.get("author_name") or "").strip()
        kind = "photo post" if "/photo/" in url else "tiktok"
        bits = [b for b in [f"tiktok {kind}" if kind == "photo post" else kind,
                            f"by {who}" if who else "", f'"{title[:300]}"' if title else ""] if b]
        out = " ".join(bits)
        if "/photo/" in url and out:
            out += " (slides not viewable from here — the caption is the read; a screenshot of a key slide gets the rest)"
        return out or None
    except Exception:
        return None


# ── platform readers ─────────────────────────────────────────────────────────────────────────────────
def _yt_duration(url: str, timeout: int = 20):
    """Seconds, via yt-dlp. Only called when we already know the video blew the token budget."""
    try:
        out = subprocess.run(["yt-dlp", "--no-warnings", "--no-playlist", "--skip-download",
                              "--print", "%(duration)s", url], capture_output=True, text=True, timeout=timeout)
        return float((out.stdout or "").strip())
    except Exception:
        return 0.0


def _yt_try(client, url: str, prompt: str, fps: float, start: int = None, end: int = None):
    """One native YouTube attempt at a given sampling rate (and optional time window).
    Returns (text, 'ok') | (None, 'too_big') | (None, 'fail') so the caller can escalate deliberately."""
    from google.genai import types
    vm = types.VideoMetadata(fps=fps)
    if start is not None:
        vm = types.VideoMetadata(fps=fps, start_offset=f"{int(start)}s", end_offset=f"{int(end)}s")
    parts = [types.Part(file_data=types.FileData(file_uri=url), video_metadata=vm), types.Part(text=prompt)]
    cfg = types.GenerateContentConfig(media_resolution=types.MediaResolution.MEDIA_RESOLUTION_LOW)
    for model in (GEMINI_MODEL, "gemini-2.5-flash"):
        try:
            resp = client.models.generate_content(model=model, contents=types.Content(parts=parts), config=cfg)
            txt = (resp.text or "").strip()
            if txt:
                return (txt, "ok")
        except Exception as e:
            s = str(e)
            if "exceeds the maximum number of tokens" in s or "token count" in s:
                return (None, "too_big")
            if "503" in s or "UNAVAILABLE" in s or "429" in s:
                continue
            return (None, "fail")
    return (None, "fail")


def _grounded(prompt: str, meta):
    """The platform's own title/channel/description are facts; the watch reasons from them, never past
    them. No metadata (yt-dlp down, private video) → the prompt stands alone and NO_GUESS still binds."""
    if not meta:
        return prompt
    return f"GIVEN by the platform (trust this over anything you infer from the frames): {meta}\n\n{prompt}"


def _yt_watch(client, url: str, prompt: str = DEEP_PROMPT):
    """WATCH a YouTube video of ANY length (7/24 fix), grounded in its metadata (9/2 fix).

    Before: one native call at default sampling. A 66-minute podcast blew the 1,048,576-token ceiling,
    the error was swallowed, and read_links quietly fell back to the yt-dlp DESCRIPTION — so long-form
    (talks, podcasts, lectures: the stuff actually worth watching) was never watched, and never said so.

    Now: low media resolution + frame sampling first, then sparser sampling, then chunk the video into
    windows, watch each, and combine the passes into one read. Descriptions are the last resort, not the
    silent default.

    9/2: the watch used to run blind and the title was consulted only if it failed, so a successful
    watch of a named guest could still misname him. The metadata now rides in front of every pass."""
    prompt = _grounded(prompt, _ytdlp_meta(url))
    for fps in (0.5, 0.2, 0.1):
        txt, why = _yt_try(client, url, prompt, fps)
        if txt:
            return txt
        if why == "fail":
            return None
        # 'too_big' → drop the sampling rate and try again

    dur = _yt_duration(url)
    if dur <= 0:
        return None
    window = 1200                                              # 20-minute windows, watched independently
    spans = [(s, min(s + window, int(dur))) for s in range(0, int(dur), window)][:8]
    if len(spans) < 2:
        return None
    pieces = []
    for i, (s, e) in enumerate(spans):
        txt, _ = _yt_try(client, url, f"(Part {i + 1} of {len(spans)}, {s // 60}-{e // 60} min.) {prompt}",
                         0.1, start=s, end=e)
        if txt:
            pieces.append(f"[{s // 60}-{e // 60} min] {txt}")
    if not pieces:
        return None
    if len(pieces) == 1:
        return pieces[0].split("] ", 1)[-1]
    joined = "\n".join(pieces)
    combined = _gemini_generate(client, [
        f"These are notes from watching one video in {len(pieces)} consecutive parts. Write the single "
        f"read the original request asked for, covering the whole video as one piece — not a list of parts.\n\n"
        f"ORIGINAL REQUEST: {prompt}\n\nPART NOTES:\n{joined}"])
    return combined or joined


def deep_read(url: str, timeout: int = 60, prompt: str = DEEP_PROMPT):
    """Gemini flash-lite WATCHES the clip — audio + visuals + on-screen text in one cheap call. YouTube goes
    in NATIVELY (file_data URI — Google owns it, no download); everything else is downloaded via yt-dlp and
    uploaded. `prompt` picks the read: DEEP_PROMPT (reaction) or EXPLAIN_PROMPT (they asked for the real
    thing). None on any failure."""
    client = _gemini_client()
    if not client:
        return None
    try:
        from google.genai import types
        if YT_RE.search(url):                                   # native YouTube understanding — no download
            return _yt_watch(client, url, prompt)
        if IG_RE.search(url):                                   # reels: Apify + watch (yt-dlp hits auth walls)
            return _ig_read(url, prompt=prompt)
        if not VIDEO_HOST_RE.search(url):
            # "break this down for me" on an ARTICLE used to dead-end in yt-dlp and answer nothing.
            page_prompt = ARTICLE_EXPLAIN_PROMPT if prompt is EXPLAIN_PROMPT else ARTICLE_PROMPT
            got = _page_read(url, prompt=page_prompt)
            if got:
                return got
        # TikTok/etc: download small, upload, watch
        import glob
        import tempfile
        d = tempfile.mkdtemp()
        r = subprocess.run(["yt-dlp", "-f", "mp4/best", "-o", os.path.join(d, "v.%(ext)s"),
                            "--no-warnings", "--no-playlist", url], capture_output=True, timeout=timeout)
        files = glob.glob(os.path.join(d, "v.*"))
        if r.returncode != 0 or not files:
            return None
        what = _gemini_watch(files[0], prompt)
        for f in files:
            try:
                os.remove(f)
            except OSError:
                pass
        return what
    except Exception:
        return None


def _extract_page_text(html: str) -> tuple:
    """(title, readable body text) from raw HTML. bs4 + html2text are both already in the live venv —
    no new dependency, because a missing import on homebase means the eyes go dark."""
    try:
        from bs4 import BeautifulSoup
    except Exception:
        return ("", "")
    soup = BeautifulSoup(html, "html.parser")
    title = ""
    if soup.title and soup.title.string:
        title = soup.title.string.strip()
    og = soup.find("meta", property="og:title")
    if og and og.get("content"):
        title = og["content"].strip() or title
    # strip the furniture so the model reads the piece, not the nav bar
    for tag in soup(["script", "style", "nav", "header", "footer", "aside", "form", "noscript", "svg"]):
        tag.decompose()
    # prefer the semantic body when the page has one
    node = soup.find("article") or soup.find("main") or soup.body or soup
    text = re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", node.get_text("\n", strip=True)))
    return (title, text)


def _fetchable(url: str) -> bool:
    """SSRF guard for AUTO-followed URLs (the tweet one-hop, thumbs): public http(s) hosts only.
    User-sent links go through the normal readers; this gate is for URLs co decides to open on
    its own. (thumbs.py has guarded on hasattr(link_read, '_fetchable') since 8/1 — it was
    vacuous until this existed, found 8/2 when the one-hop follow silently NameError'd.)"""
    try:
        import ipaddress
        import socket
        from urllib.parse import urlparse
        p = urlparse(url)
        if p.scheme not in ("http", "https") or not p.hostname:
            return False
        host = p.hostname
        if host == "localhost" or host.endswith((".local", ".internal", ".ts.net")):
            return False
        for _, _, _, _, sa in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(sa[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return False
        return True
    except Exception:
        return False


def read_raw(url: str, timeout: int = 20, max_chars: int = 12_000):
    """The rendered page as PLAIN TEXT — no model in the loop. _reader_read's first half, split out
    because the organs that were snippet-deep (watch evidence, commissioned research) need the page
    itself, not a summary of it: a judge comparing last week's state to this week's needs the same
    text both times, and a summarizer in the middle makes every check a coin flip.
    None when jina is down or the page came back empty."""
    try:
        import requests
        r = requests.get(f"https://r.jina.ai/{url}", timeout=timeout, headers=JINA_HEADERS)
        return r.text[:max_chars] if r.ok and len(r.text) >= 300 else None
    except Exception:
        return None


def _reader_read(url: str, prompt: str = ARTICLE_PROMPT, timeout: int = 20):
    """Bot-walled page fallback (the politico/cloudflare class): the keyless jina reader renders
    the page server-side and hands back plain text. Only used for auto-hops after _page_read
    fails — user-sent links keep the direct path first."""
    try:
        import requests
        r = requests.get(f"https://r.jina.ai/{url}", timeout=timeout, headers=JINA_HEADERS)
        if not r.ok or len(r.text) < 300:
            return None
        client = _gemini_client()
        if not client:
            return None
        return _gemini_generate(client, [f"{prompt}\n\n{r.text[:PAGE_MAX_CHARS]}"])
    except Exception:
        return None


def _wayback_read(url: str, prompt: str = ARTICLE_PROMPT, timeout: int = 20):
    """Last free rung for bot-walled pages: read the archive.org snapshot if one exists."""
    try:
        import requests
        api = requests.get("http://archive.org/wayback/available", params={"url": url}, timeout=10).json()
        snap = ((api.get("archived_snapshots") or {}).get("closest") or {}).get("url")
        return _page_read(snap, timeout=timeout, prompt=prompt) if snap else None
    except Exception:
        return None


def _page_read(url: str, timeout: int = 25, prompt: str = ARTICLE_PROMPT):
    """Fetch a web page (or PDF) and actually READ it. This is the path that did not exist: articles,
    substacks, papers, docs, PDFs. None on any failure — the caller degrades to a flag."""
    try:
        import requests
        r = requests.get(url, timeout=timeout, stream=True,
                         headers={"User-Agent": PAGE_UA, "Accept-Language": "en-US,en;q=0.9"})
        if not r.ok:
            return None
        ctype = (r.headers.get("content-type") or "").lower()
        body = b""
        for chunk in r.iter_content(65536):
            body += chunk
            if len(body) > PAGE_MAX_BYTES:
                break
        r.close()

        if "application/pdf" in ctype or url.lower().split("?")[0].endswith(".pdf"):
            import tempfile                                   # gemini reads PDFs natively via upload
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
                f.write(body)
                p = f.name
            try:
                what = _gemini_watch(p, prompt)
            finally:
                try:
                    os.remove(p)
                except OSError:
                    pass
            return f"pdf — {what}" if what else None

        if "html" not in ctype and "text" not in ctype and ctype:
            return None                                        # an image/binary: not our job here
        html = body.decode(r.encoding or "utf-8", errors="replace")
        title, text = _extract_page_text(html)
        if len(text) < 200:                                    # js-rendered wall or a stub — don't fake a read
            return None
        client = _gemini_client()
        if not client:
            return None
        what = _gemini_generate(client, [f"{prompt}\n\nTITLE: {title}\n\n{text[:PAGE_MAX_CHARS]}"])
        if not what:
            return None
        return f"{title} — {what}" if title else what
    except Exception:
        return None


def _strip_tag_wall(caption: str) -> str:
    """Drop the trailing hashtag wall; hashtags mid-sentence survive."""
    return re.sub(r"(\s*#\w+)+\s*$", "", caption).strip()


def _ig_read(url: str, timeout: int = 75, prompt: str = DEEP_PROMPT):
    """Instagram: Apify for metadata + the media URL, then Gemini WATCHES the reel. The old caption
    short-circuit was the bug (7/15): captions are the creator's bait ('AI maxxing vs larping - part 3
    #ai'), the reel is the content. The watch is the read; the caption is context. None on any failure
    (auth-walled, deleted, actor trouble, no token)."""
    token = os.environ.get("APIFY_API_TOKEN")
    if not token:
        return None
    try:
        import requests
        r = requests.post(
            f"https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token={token}",
            json={"directUrls": [url.split("?")[0]], "resultsType": "posts", "resultsLimit": 1},
            timeout=timeout)
        items = r.json() if r.ok else []
        it = items[0] if isinstance(items, list) and items else {}
        if not it or it.get("error"):
            return None
        kind = "reel" if (it.get("productType") == "clips" or it.get("type") == "Video") else "post"
        who = it.get("ownerUsername") or ""
        caption = _strip_tag_wall((it.get("caption") or "").replace("\n", " ").strip())
        if len(caption) > 400:
            caption = caption[:400].rsplit(" ", 1)[0] + "…"   # word boundary, never mid-sentence chops
        base = f"instagram {kind}{f' by {who}' if who else ''}"
        # WATCH whenever there's something to watch (short clips only) — never let the caption stand in
        # for the content.
        what = None
        vurl = it.get("videoUrl")
        kids = it.get("childPosts") or []

        if kids:
            # CAROUSEL / SLIDESHOW (7/27). Apify calls these "Sidecar" and the slides live in
            # childPosts — which the old code never looked at. It read displayUrl + images[] as flat
            # pictures, capped at 2, so a 7-slide story became "the first slide". Slides are also not
            # all pictures: each child can be a Video with its OWN audioUrl, and a slideshow's meaning
            # usually depends on the ORDER (setup -> turn -> punchline). So: walk childPosts in order,
            # watch video slides (Gemini hears their audio) and look at image slides, and label each
            # with its position so the reaction can talk about sequence.
            parts = []
            for i, kid in enumerate(kids[:CAROUSEL_MAX], start=1):
                label = f"slide {i}/{len(kids)}"
                kv = kid.get("videoUrl")
                try:
                    if kv:
                        vr = requests.get(kv, timeout=60)
                        if vr.ok and vr.content:
                            import tempfile
                            with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
                                f.write(vr.content); kp = f.name
                            try:
                                seen_kid = _gemini_watch(kp, prompt)
                            finally:
                                try:
                                    os.remove(kp)
                                except OSError:
                                    pass
                            if seen_kid:
                                parts.append(f"{label} (video): {seen_kid}")
                            continue
                    ku = kid.get("displayUrl")
                    if ku:
                        ir = requests.get(ku, timeout=45)
                        if ir.ok and ir.content:
                            seen_kid = read_image(ir.content, ir.headers.get("content-type", "image/jpeg"))
                            if seen_kid:
                                parts.append(f"{label}: {seen_kid}")
                except Exception:
                    pass
            if parts:
                more = f" (+{len(kids) - CAROUSEL_MAX} more slides not read)" if len(kids) > CAROUSEL_MAX else ""
                what = f"{len(kids)}-slide carousel, in order — " + " | ".join(parts) + more

        elif not vurl:
            # single photo post: the picture IS the post, read it like a sent screenshot.
            imgs = [u for u in ([it.get("displayUrl")] + [
                (c.get("displayUrl") if isinstance(c, dict) else c) for c in (it.get("images") or [])
            ]) if u]
            seen = []
            for iu in imgs[:2]:
                try:
                    ir = requests.get(iu, timeout=45)
                    if ir.ok and ir.content:
                        s2 = read_image(ir.content, ir.headers.get("content-type", "image/jpeg"))
                        if s2:
                            seen.append(s2)
                except Exception:
                    pass
            if seen:
                what = " ".join(seen)

        if vurl and float(it.get("videoDuration") or 0) <= 180:
            import tempfile
            vr = requests.get(vurl, timeout=60)
            if vr.ok and vr.content:
                with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
                    f.write(vr.content)
                    p = f.name
                what = _gemini_watch(p, prompt)
                try:
                    os.remove(p)
                except OSError:
                    pass
        bits = [b for b in (what, f'caption: "{caption}"' if caption else "") if b]
        if bits:
            return f"{base} — {' '.join(bits)}"
        return base if who else None
    except Exception:
        return None


def _x_read(url: str, timeout: int = 20):
    """A tweet → author + text. X API bearer if present, else the keyless fxtwitter mirror. None on failure."""
    m = X_RE.search(url)
    art = None if m else X_ARTICLE_RE.search(url)
    if not m and not art:
        return None
    tid = (m or art).group(3)
    if art:
        # PAGE FIRST FOR ARTICLES (8/28). The old order asked fxtwitter first "in case X exposes
        # the same id both ways" — and it does, but what comes back is the TWEET that links to the
        # article, plus a note saying the article is JS-walled. That is truthy, so `if rich:
        # return rich` short-circuited and the page read never ran. Co reported every X Article as
        # unreadable for months while the fetch worked the whole time.
        #
        # An Article IS long-form prose at a URL, so read the URL. X serves the body to a normal
        # browser UA (Googlebot gets 403; PAGE_UA gets 520KB with the text in it), and
        # _extract_page_text pulls ~31k clean characters out of that markup.
        got = _page_read(url, prompt=ARTICLE_PROMPT)
        if got:
            return f"x article — {got}"
        try:
            return _fx_read(tid, timeout=timeout)      # fallback: at least say whose it is
        except Exception:
            return None
    # fxtwitter FIRST (7/24): it carries the media, the quoted tweet and the parent chain in one payload.
    # The bearer path returns 280 chars of text and nothing else, so it is now only the fallback —
    # having a token used to make the read WORSE, which is why tweets with pictures read as text.
    try:
        rich = _fx_read(tid, timeout=timeout)
        if rich:
            return rich
    except Exception:
        pass
    try:
        import requests
        bearer = os.environ.get("X_API_BEARER") or os.environ.get("X_BEARER_TOKEN")
        if bearer:
            r = requests.get(f"https://api.twitter.com/2/tweets/{tid}",
                             params={"tweet.fields": "text", "expansions": "author_id",
                                     "user.fields": "username"},
                             headers={"Authorization": f"Bearer {bearer}"}, timeout=timeout)
            if r.ok:
                d = r.json()
                text = (d.get("data") or {}).get("text", "").replace("\n", " ").strip()
                users = (d.get("includes") or {}).get("users") or [{}]
                who = users[0].get("username", "")
                if text:
                    return f"tweet{f' by @{who}' if who else ''}: {text[:X_TEXT_CAP]}"
    except Exception:
        pass
    return None


def _unshorten(url: str, timeout: int = 12):
    """t.co → the real destination. t.co does NOT answer with an HTTP redirect for many links: it
    returns 200 and a META-REFRESH page (verified 8/4), so a plain allow_redirects resolve comes
    back pointing at itself and the caller concludes there is nothing behind the link. Follow the
    redirect if there is one, else parse the meta refresh. None when it won't resolve — a
    destination is never guessed."""
    try:
        import requests
        r = requests.get(url, timeout=timeout, allow_redirects=True, headers={"User-Agent": PAGE_UA})
        final = r.url or ""
        if final and "t.co/" not in final:
            return final
        m = re.search(r"""URL=([^"'>\s]+)""", (r.text or "")[:4000], re.I)
        if m:
            dest = m.group(1).replace("&amp;", "&").strip()
            return dest if "t.co/" not in dest else None
    except Exception:
        pass
    return None


def _fx_tweet(tid: str, timeout: int = 20):
    import requests
    r = requests.get(f"https://api.fxtwitter.com/status/{tid}", timeout=timeout)
    return ((r.json() or {}).get("tweet") or {}) if r.ok else {}


def _fx_text(t: dict) -> str:
    """The FULL post text. fxtwitter returns `raw_text` untruncated and flags long-form with
    is_note_tweet; the old code took `text` and cut it at 280, so every note tweet and Article
    arrived as its own first paragraph (7/27)."""
    rt = t.get("raw_text")
    raw = (rt.get("text") if isinstance(rt, dict) else rt) or ""   # fxtwitter wraps it in an object
    raw = raw.strip()
    txt = (t.get("text") or "").strip()
    best = raw if len(raw) > len(txt) else txt
    return best.replace("\n", " ").strip()[:X_TEXT_CAP]


def _fx_line(t: dict) -> str:
    who = (t.get("author") or {}).get("screen_name", "")
    text = _fx_text(t)
    kind = "article" if t.get("is_note_tweet") else "tweet"
    if who:
        return f"@{who} ({kind}): {text}" if kind == "article" else f"@{who}: {text}"
    return text


def _x_media_read(t: dict, timeout: int = 60):
    """Watch/see what the tweet actually carries. Photos → vision, video → the watcher. '' when text-only."""
    media = (t.get("media") or {})
    photos = media.get("photos") or []
    videos = media.get("videos") or []
    outs = []
    try:
        import requests
        if videos:
            vurl = videos[0].get("url")
            if vurl and float(videos[0].get("duration") or 0) <= 300:
                import tempfile
                vr = requests.get(vurl, timeout=timeout)
                if vr.ok and vr.content:
                    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
                        f.write(vr.content)
                        p = f.name
                    try:
                        w = _gemini_watch(p, DEEP_PROMPT)
                    finally:
                        try:
                            os.remove(p)
                        except OSError:
                            pass
                    if w:
                        outs.append(f"video: {w}")
        for ph in photos[:2]:
            purl = ph.get("url")
            if not purl:
                continue
            pr = requests.get(purl, timeout=timeout)
            if pr.ok and pr.content:
                seen = read_image(pr.content, pr.headers.get("content-type", "image/jpeg"))
                if seen:
                    outs.append(f"image: {seen}")
    except Exception:
        pass
    return " ".join(outs)


def _fx_read(tid: str, timeout: int = 20, max_parents: int = 5):
    """A tweet WITH its media, its quoted tweet, and the thread above it."""
    t = _fx_tweet(tid, timeout=timeout)
    if not t:
        return None
    bits = [f"tweet {_fx_line(t)}"]

    seen_media = _x_media_read(t, timeout=max(timeout, 60))
    if seen_media:
        bits.append(f"({seen_media})")

    quoted = t.get("quote") or {}
    if quoted:
        bits.append(f"— quoting {_fx_line(quoted)}")
        qm = _x_media_read(quoted, timeout=max(timeout, 60))
        if qm:
            bits.append(f"({qm})")

    # ONE-HOP FOLLOW (8/2, the appliedcompute miss): when a tweet's whole payload is a link
    # ("our CEO with politico on open weights" + URL), the material for a real reaction lives
    # BEHIND the link — without this hop the reply can only label the tweet.
    try:
        rt = t.get("raw_text")
        txt = " ".join(x for x in [t.get("text"), rt.get("text") if isinstance(rt, dict) else rt]
                       if isinstance(x, str))
        # t.co IS the external link (8/4). Excluding it meant the commonest shape on X — a
        # LINK-ONLY tweet, whose entire text is one shortener — could never be followed, so co
        # received an author and a bare t.co and filled the silence by guessing at the content
        # (and the author). Resolve the shortener, then hop as normal; genuinely internal links
        # (media, quoted posts) resolve back to x.com and are dropped after resolution.
        cands = [u.rstrip(".,)…") for u in re.findall(r"https?://[^\s\"'’]+", txt)
                 if not re.search(r"(?:x|twitter)\.com/|pic\.twitter", u)]
        out = None
        for u in cands:
            if "t.co/" in u:
                u = _unshorten(u) or ""
                # An X ARTICLE behind a shortener is the commonest long-form share on X — keep it
                # and route to the article reader; only media/quote self-links get dropped.
                if not u or (re.search(r"(?:x|twitter)\.com/", u) and not X_ARTICLE_RE.search(u)):
                    continue
            if u:
                out = u
                break
        if out and X_ARTICLE_RE.search(out):
            art = _x_read(out)
            if not art:
                # THE ARTICLE LIVES ON THE TWEET PAGE (8/28). The commonest long-form share on X
                # is a tweet linking to an Article, and the /article/<id> URL the card advertises
                # frequently 404s outright ("Article Not Found") in both the /i/ and the
                # /<handle>/ form. X renders the body on the TWEET page instead: the same post
                # that 404s as an article returns ~20k clean characters as a status. So when the
                # article URL fails, read the post co already has an id for.
                got = _page_read(f"https://x.com/i/status/{tid}", prompt=ARTICLE_PROMPT)
                if got:
                    art = f"x article — {got}"
            bits.append(f"— the linked piece: {art}" if art else
                        "— the post links to an X Article that can't be opened from here (JS-walled). "
                        "Say plainly you can't read it and offer a screenshot; NEVER guess at what it says")
        elif out and _fetchable(out):
            hop = _page_read(out, timeout=15) or _reader_read(out) or _wayback_read(out)
            if hop:
                bits.append(f"— the linked piece: {hop}")
            else:
                from urllib.parse import urlparse
                bits.append(f"— links to a {urlparse(out).hostname} piece that's bot-walled; "
                            "web_search is the way to get what's in it")
    except Exception:
        pass

    # walk UP the reply chain: when they send the tail of a thread, the thread is the point.
    chain, cur, author = [], t, (t.get("author") or {}).get("screen_name", "")
    for _ in range(max_parents):
        parent_id = cur.get("replying_to_status")               # fxtwitter's parent-id field
        if not parent_id:
            break
        p = _fx_tweet(str(parent_id), timeout=timeout)
        if not p:
            break
        chain.append(p)
        cur = p
    if chain:
        same = [c for c in chain if (c.get("author") or {}).get("screen_name", "") == author]
        label = "earlier in the thread" if len(same) == len(chain) else "replying to"
        earlier = " | ".join(_fx_line(c) for c in reversed(chain))
        bits.append(f"— {label}: {earlier}")
    out_s = " ".join(bits)
    # CONTENTLESS TWEET, STATED AS SUCH (8/4, the fabricated-Dario incident). A link-only post whose
    # link we could not follow yields "tweet @who: https://t.co/…" — which READS like a successful
    # content read, so the model filled the void: it guessed the author was Dario (he wasn't) and
    # invented the argument. A read that carries no content must SAY it carries no content; the
    # never-invent-media-access law belongs in the data, not only in the prompt.
    body = _fx_text(t)
    if not re.sub(r"https?://\S+", "", body).strip() and "the linked piece:" not in out_s \
            and "(" not in out_s:
        who = (t.get("author") or {}).get("screen_name", "") or "someone"
        return (f"tweet by @{who} whose entire body is a link, and the link couldn't be opened from "
                f"here — so you do NOT know what it says. Say that plainly, name only what you can "
                f"actually see (who posted it), offer to read a screenshot. Never guess the content, "
                f"the author's identity, or the argument.")
    return out_s


# ── the one entry point ──────────────────────────────────────────────────────────────────────────────
def read_links(text, on_defer=None):
    """Compact 'what they shared' string for the journal/reaction, or None if no links. Never raises —
    a link we can't open degrades to a flag, it doesn't break capture."""
    urls = find_urls(text)
    if not urls:
        return None
    reads = []
    for u in urls[:3]:
        # Failure flags carry a WORKAROUND, not a question (7/15): "what's in it?" hands the work back to
        # the person — offer the path that works (a screenshot) and own the miss plainly.
        if IG_RE.search(u):
            got = _ig_read(u)
            reads.append(f"[shared: {got}]" if got
                         else "[shared: an instagram reel that couldn't be opened — own the miss plainly and "
                              "offer: screenshot the key part and you'll read that. never ask 'what's in it']")
            continue
        if YT_RE.search(u):                                     # YouTube: native Gemini first, meta fallback
            if on_defer:
                dur = _yt_duration(u)                           # ~3s probe; a long watch would cost minutes
                if dur > DEFER_SECONDS:
                    # captions are ~15s REGARDLESS of length — the common case answers in ONE reply.
                    # Only a caption-less video earns the background ceremony (7/31: "sending a
                    # youtube video shouldn't feel like the slowest way to transcribe").
                    t = _captions_transcript(u, timeout=18)
                    reads.append(on_defer(u, _ytdlp_meta(u) or "", int(dur // 60), transcript=t))
                    continue
            got = deep_read(u) or _ytdlp_meta(u)
            reads.append(f"[shared: {got}]" if got
                         else "[shared: a youtube video that couldn't be watched right now — say so plainly, "
                              "offer to take another crack later or read a screenshot of the key part]")
            continue
        if X_RE.search(u) or X_ARTICLE_RE.search(u):
            got = _x_read(u)
            reads.append(f"[shared: {got}]" if got
                         else "[shared: a tweet that couldn't be opened — say so plainly and offer to read a "
                              "screenshot of it instead]")
            continue
        if "tiktok.com" in u.lower() and "/photo/" in u:        # photo-mode: a download attempt is doomed —
            got = _tiktok_oembed(u) or _ytdlp_meta(u)           # oEmbed answers in ~1s with the caption
            reads.append(f"[shared: {got}]" if got
                         else "[shared: a tiktok photo post that couldn't be opened — own the miss plainly "
                              "and offer: screenshot a slide and you'll read that. never ask 'what's in it']")
            continue
        if VIDEO_HOST_RE.search(u):                             # tiktok/vimeo/etc: download and watch
            meta = _ytdlp_meta(u)
            if meta and len(meta) >= THIN:
                reads.append(f"[shared: {meta}]")               # caption rich enough to cluster
            else:
                if on_defer:
                    dur = _yt_duration(u)
                    if dur > DEFER_SECONDS:
                        reads.append(on_defer(u, meta or "", int(dur // 60), transcript=None))
                        continue
                deep = deep_read(u)                             # thin → let Gemini watch it
                oe = None if (deep or meta) else ("tiktok.com" in u.lower() and _tiktok_oembed(u)) or None
                reads.append(f"[shared: {deep or meta or oe or LINK_UNREADABLE}]")
            continue
        # everything else is a PAGE: read it. (before 7/24 this fell through yt-dlp and died.)
        page = _page_read(u)
        if page:
            reads.append(f"[shared: {page}]")
            continue
        meta = _ytdlp_meta(u)                                   # some pages are really videos in disguise
        deep = None if (meta and len(meta) >= THIN) else deep_read(u)
        reads.append(f"[shared: {deep or meta}]" if (deep or meta) else
                     "[shared: a page that couldn't be opened — say so plainly and offer to read a "
                     "screenshot of the part that matters. never ask 'what's in it']")
    return " ".join(reads)


# Every flag read_links can emit INSTEAD of a read, plus deferred_watch's placeholder for a video
# co has not watched yet. A caller cannot tell those from a real read by truthiness — the flags are
# deliberately full sentences, because they are written for the model, not for a branch.
#
# WHY THIS EXISTS (9/5): the router's 👀 mark means "co opened this", and it gated on `enrichment`
# being non-empty. That is true of every line below, so a link that failed to open would have been
# marked read — the file's own rule at sendblue_router's content path is that "a 👀 followed by a
# failure reads as gaslighting". test_link_read pins that every failure branch here is covered.
UNREAD_FLAGS = ("couldn't be opened", "couldn't be watched", "too long to watch mid-reply")

# ONE LITERAL, NOT TWO (9/8). The video-link failure in read_links was written inline with a CURLY
# apostrophe while UNREAD_FLAGS carries a straight one, so is_a_real_read called every failed
# tiktok/vimeo/twitch read a SUCCESSFUL one — and the router marks a successful read 👍 "cool, saw
# it". Named here, beside the flag it has to match, so the two cannot drift apart again.
LINK_UNREADABLE = "a link that couldn't be opened"
assert any(f in LINK_UNREADABLE for f in UNREAD_FLAGS), "the failure line must carry a flag"


def is_a_real_read(enrichment: str) -> bool:
    """True when the enrichment carries something co actually read. Conservative on purpose: a
    mixed batch (one link read, one flagged) answers False rather than claim the whole send."""
    e = enrichment or ""
    return bool(e.strip()) and not any(f in e for f in UNREAD_FLAGS)


def _selfcheck() -> None:
    """The 8/7 regression, pinned: a browser User-Agent on the jina call reads as a bot impersonating
    a browser and Cloudflare answers 403 — which FAILS CLOSED, so the bot-wall fallback goes quiet
    instead of loud. Offline (no network, no key): the header dict is the whole failure surface."""
    assert "User-Agent" not in JINA_HEADERS, "browser UA on r.jina.ai → Cloudflare 403 (fails closed)"
    assert JINA_HEADERS.get("Accept") == "text/plain"
    assert PAGE_UA not in str(JINA_HEADERS)
    print("link_read selfcheck OK")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--selfcheck":
        _selfcheck()
        sys.exit(0)
    if args and args[0] == "--media":
        print(read_media_url(args[1]) or "(couldn't read media)")
    elif args and args[0] == "--image":
        with open(args[1], "rb") as f:
            print(read_image(f.read(), "image/png") or "(couldn't read image)")
    else:
        print(read_links(" ".join(args)) or "(no links)")


# ── the transcript rung (7/29, from the founder's real thread) ─────────────────────────────────────
# A gist read loses the details people actually ask about later ("didn't he mention two phones?" —
# he did, and the 23-second skim dropped it). For anything worth deferring, the artifact must be the
# TRANSCRIPT, stored, so follow-ups answer from what was actually said — never "search the title
# and it'll come right up." Ladder: YouTube's own captions (free, exact) → Gemini native audio
# transcription (Google's access, so local caption 429s don't matter) → None (caller falls back).

WATCHED_DIR = os.path.expanduser("~/.co/watched")
_YT_ID_RE = re.compile(r"(?:youtu\.be/|[?&]v=|/shorts/|/embed/)([A-Za-z0-9_-]{11})")


def _video_key(url: str) -> str:
    m = _YT_ID_RE.search(url or "")
    if m:
        return m.group(1)
    return hashlib.sha1((url or "").encode()).hexdigest()[:16]


def watched_path(tenant: str, url: str) -> str:
    d = os.path.join(WATCHED_DIR, tenant)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{_video_key(url)}.txt")


def get_watched(tenant: str, url: str):
    p = watched_path(tenant, url)
    try:
        return open(p).read() if os.path.exists(p) else None
    except OSError:
        return None


def save_watched(tenant: str, url: str, transcript: str) -> None:
    try:
        tmp = watched_path(tenant, url) + ".tmp"
        open(tmp, "w").write(transcript[:200_000])
        os.replace(tmp, watched_path(tenant, url))
    except OSError:
        pass


def _captions_transcript(url: str, timeout: int = 45):
    """Rung 1: YouTube's own auto-captions via yt-dlp. Exact words, zero model cost."""
    import glob as _g
    import tempfile
    try:
        with tempfile.TemporaryDirectory() as td:
            subprocess.run(["yt-dlp", "--no-warnings", "--skip-download", "--write-auto-subs",
                            "--write-subs", "--sub-langs", "en.*", "--sub-format", "vtt",
                            "-o", os.path.join(td, "s"), url],
                           capture_output=True, text=True, timeout=timeout)
            vtts = _g.glob(os.path.join(td, "*.vtt"))
            if not vtts:
                return None
            lines, seen = [], None
            for ln in open(vtts[0], errors="ignore"):
                ln = ln.strip()
                if not ln or "-->" in ln or ln.startswith(("WEBVTT", "Kind:", "Language:", "NOTE")):
                    continue
                ln = re.sub(r"<[^>]+>", "", ln)
                if ln and ln != seen:                     # vtt repeats rolling lines; drop dupes
                    lines.append(ln)
                    seen = ln
            t = " ".join(lines)
            return t if len(t) > 200 else None
    except Exception:
        return None


def _gemini_transcript(url: str):
    """Rung 2: Gemini transcribes the audio natively (proven on a 13-min video: 14k verbatim chars)."""
    client = _gemini_client()
    if not client:
        return None
    try:
        from google.genai import types
        parts = [types.Part(file_data=types.FileData(file_uri=url),
                            video_metadata=types.VideoMetadata(fps=0.2)),
                 types.Part(text="Transcribe the speech in this video as completely as you can, verbatim, "
                                 "with [M:SS] timestamps every ~30 seconds. Speech only.")]
        cfg = types.GenerateContentConfig(media_resolution=types.MediaResolution.MEDIA_RESOLUTION_LOW)
        for model in (GEMINI_MODEL, "gemini-2.5-flash"):
            try:
                r = client.models.generate_content(model=model, contents=types.Content(parts=parts), config=cfg)
                t = (r.text or "").strip()
                if len(t) > 200:
                    return t
            except Exception:
                continue
    except Exception:
        pass
    return None


def yt_transcript(url: str, tenant: str = ""):
    """The full ladder; stores on success when a tenant is given."""
    if tenant:
        got = get_watched(tenant, url)
        if got:
            return got
    t = _captions_transcript(url) or _gemini_transcript(url)
    if t and tenant:
        save_watched(tenant, url, t)
    return t
