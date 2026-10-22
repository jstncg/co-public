#!/usr/bin/env python3
"""Thumbnails — the stream made visible.

The world tab was text about things instead of the things themselves (founder, 8/1: "how
come I don't see any of it... it should feel magical"). A person's captures are IMAGES:
reels, videos, tweets with media, screenshots. This resolves a picture for a captured URL,
caches it locally, and serves it from our own host (so nothing hotlinks, referrer blocks
don't matter, and a dead source doesn't blank the wall).

Ladder, cheapest first — each rung free and keyless:
  youtube   → img.youtube.com/vi/<id>/hqdefault.jpg (always exists)
  x/twitter → api.fxtwitter.com/... → media[0].thumbnail_url (the same reader eyes uses)
  instagram → oEmbed-ish og:image from the public page (often blocked → falls through)
  anything  → the page's og:image / twitter:image
  nothing   → None, and the tile renders as a typographic card (never a broken frame)

Cache: ~/.co/thumbs/<sha1>.jpg, served at /w/<slug>/t/<sha1>.
"""
from __future__ import annotations

import hashlib
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

DIR = os.path.expanduser("~/.co/thumbs")
MAXB = 3_000_000
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/126.0 Safari/537.36")
_YT = re.compile(r"(?:youtu\.be/|[?&]v=|/shorts/|/embed/)([A-Za-z0-9_-]{11})")
_X = re.compile(r"(?:twitter|x)\.com/([^/]+)/status/(\d+)", re.I)


def key_for(url: str) -> str:
    return hashlib.sha1((url or "").split("?")[0].encode()).hexdigest()[:16]


def path_for(url: str) -> str:
    os.makedirs(DIR, exist_ok=True)
    return os.path.join(DIR, key_for(url) + ".jpg")


def cached(url: str) -> str | None:
    p = path_for(url)
    return p if os.path.exists(p) and os.path.getsize(p) > 1200 else None


def path_by_key(k: str) -> str | None:
    p = os.path.join(DIR, re.sub(r"[^0-9a-f]", "", k)[:16] + ".jpg")
    return p if os.path.exists(p) else None


def _get(u: str, timeout: int = 12):
    import requests
    try:
        import link_read
        if hasattr(link_read, "_fetchable") and not link_read._fetchable(u):
            return None                       # SSRF guard: same law as the eyes
    except Exception:
        pass
    try:
        r = requests.get(u, timeout=timeout, headers={"User-Agent": UA}, stream=True)
        if r.status_code != 200:
            return None
        return r
    except Exception:
        return None


def _og_image(page_url: str) -> str | None:
    r = _get(page_url)
    if not r:
        return None
    try:
        head = r.raw.read(200_000, decode_content=True).decode("utf-8", "ignore")
    except Exception:
        return None
    for pat in (r'property=["\']og:image["\'][^>]*content=["\']([^"\']+)',
                r'content=["\']([^"\']+)["\'][^>]*property=["\']og:image',
                r'name=["\']twitter:image["\'][^>]*content=["\']([^"\']+)'):
        m = re.search(pat, head, re.I)
        if m:
            return m.group(1).replace("&amp;", "&")
    return None


def source_image(url: str) -> str | None:
    """The best available image URL for a captured link — no download yet."""
    m = _YT.search(url or "")
    if m:
        return f"https://img.youtube.com/vi/{m.group(1)}/hqdefault.jpg"
    m = _X.search(url or "")
    if m:
        r = _get(f"https://api.fxtwitter.com/{m.group(1)}/status/{m.group(2)}")
        if r:
            try:
                t = (r.json() or {}).get("tweet") or {}
                media = ((t.get("media") or {}).get("all") or [])
                for it in media:
                    for k in ("thumbnail_url", "url"):
                        if it.get(k, "").startswith("http"):
                            return it[k]
                if (t.get("author") or {}).get("avatar_url"):
                    return t["author"]["avatar_url"]
            except Exception:
                pass
        return None
    return _og_image(url)


def fetch(url: str) -> str | None:
    """Resolve + download + cache. Returns the local path, or None (caller renders a card)."""
    hit = cached(url)
    if hit:
        return hit
    src = source_image(url)
    if not src:
        return None
    r = _get(src, timeout=20)
    if not r:
        return None
    try:
        data = r.raw.read(MAXB, decode_content=True)
        if len(data) < 1200:
            return None
        from io import BytesIO

        from PIL import Image
        img = Image.open(BytesIO(data)).convert("RGB")
        img.thumbnail((640, 640))
        img.save(path_for(url), "JPEG", quality=82, optimize=True)
        return path_for(url)
    except Exception:
        return None


def warm(tenant: str, limit: int = 200) -> int:
    """Pre-fetch thumbs for everything they've already sent (idempotent, safe to re-run)."""
    import json
    try:
        j = json.load(open(os.path.expanduser(f"~/.co/journal/{tenant}.json")))
    except OSError:
        return 0
    seen, got = set(), 0
    for e in reversed(j.get("entries") or []):
        for u in re.findall(r"https?://[^\s\]]+", e.get("text") or ""):
            u = u.rstrip(".,)")
            if u in seen:
                continue
            seen.add(u)
            if cached(u):
                continue
            if fetch(u):
                got += 1
            if len(seen) >= limit:
                return got
    return got


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else "dennis"
    print(f"warmed {warm(t)} new thumbnails · cache: {len(os.listdir(DIR)) if os.path.isdir(DIR) else 0}")
