"""co_engine — THE engine. One importable package for every organ in the family.

This is the consolidation seam (kyo's engine_bridge pattern, promoted to the real thing).
The law, effective 2026-07-29:

  1. NEW code imports organs through `co_engine`, never by path-hacking into frame/claims.
  2. Organs migrate INTO this package file-by-file; while an organ still lives in
     frame/claims, this package resolves it from there (the lazy loader below), so callers
     never change when the file moves.
  3. kyo-side code reaches the same organs through its engine_bridge pointed here —
     one engine, two products, zero forked organs.

Native modules (already migrated): ontology, reconciler.
Resolved from frame/claims until their migration: everything in _FRAME_ORGANS.
"""
from __future__ import annotations

import importlib
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_FRAME_CLAIMS = os.path.abspath(os.path.join(_HERE, "..", "..", "frame", "claims"))

# Organs still living in frame/claims — the migration queue, resolved lazily so importing
# co_engine costs nothing and a missing optional dep in one organ can't break another.
_FRAME_ORGANS = {
    "find_engine", "watch_engine", "episode_engine", "research_engine", "deferred_watch",
    "journal", "anchors", "link_read", "co_react", "daily_text", "proactive_tick",
    "forget", "export_data", "shadow_review", "weave", "session_compact", "anthro",
    "tz_dynamic", "disposition", "llm", "return_engine",
}

__all__ = ["ontology", "reconciler"] + sorted(_FRAME_ORGANS)


def __getattr__(name: str):
    if name in ("ontology", "reconciler"):
        return importlib.import_module(f".{name}", __name__)
    if name in _FRAME_ORGANS:
        if _FRAME_CLAIMS not in sys.path:
            sys.path.insert(0, _FRAME_CLAIMS)
        mod = importlib.import_module(name)
        setattr(sys.modules[__name__], name, mod)
        return mod
    raise AttributeError(f"module 'co_engine' has no organ '{name}'")
