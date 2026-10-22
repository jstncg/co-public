#!/usr/bin/env python3
"""Per-tenant media store for the viewer's photo cards.

Content-addressed image bytes under ~/.co/media/<tenant>/<id>.<ext>, served by the viewer's
token-guarded /v/<token>/media/<name> route. The router (which we do NOT touch here) currently reads
image bytes transiently and discards them; when it later persists via save(), the photo cards light up
with real <img>. Until then a tenant with no stored bytes renders EXIF-caption tiles — no broken images.

Standalone stdlib; safe to import from serve.py or (later) the router.
"""
import hashlib
import re
from pathlib import Path

ROOT = Path("~/.co/media").expanduser()

# name → content-type (only image kinds the tiles render)
MIME = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif",
        "webp": "image/webp", "heic": "image/heic"}
_SAFE = re.compile(r"^[A-Za-z0-9._-]+$")


def _dir(tenant: str) -> Path:
    return ROOT / re.sub(r"[^a-z0-9_+\-]", "_", (tenant or "").strip().lower())


def save(tenant: str, data: bytes, ext: str = "jpg") -> str:
    """Persist bytes (content-addressed) → the stored name. Idempotent on identical bytes."""
    ext = (ext or "jpg").lower().lstrip(".")
    if ext == "jpeg":
        ext = "jpg"
    if ext not in MIME:
        ext = "jpg"
    d = _dir(tenant)
    d.mkdir(parents=True, exist_ok=True)
    name = f"{hashlib.sha256(data).hexdigest()[:20]}.{ext}"
    p = d / name
    if not p.exists():
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(p)
    return name


def resolve(tenant: str, name: str):
    """Stored path for a media name, or None. Traversal-safe: name must be a bare filename that resolves
    strictly inside the tenant's own directory."""
    if not name or not _SAFE.match(name) or "/" in name or ".." in name:
        return None
    d = _dir(tenant).resolve()
    p = (d / name).resolve()
    if p.parent != d or not p.is_file():
        return None
    return p


def content_type(name: str) -> str:
    return MIME.get(name.rsplit(".", 1)[-1].lower(), "application/octet-stream")


def list_media(tenant: str) -> list:
    """Stored image names for a tenant, newest first (mtime). Empty when nothing persisted yet."""
    d = _dir(tenant)
    if not d.is_dir():
        return []
    files = [p for p in d.iterdir() if p.is_file() and p.suffix.lstrip(".").lower() in MIME]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [p.name for p in files]
