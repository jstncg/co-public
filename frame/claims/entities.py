#!/usr/bin/env python3
"""Entities — the things in their world, each carrying why it matters (8/25).

The join needs two halves: the world moving, and a reason to care. This organ owns the
second half. Every person, company, product, and place that shows up in the member's own
material becomes a watched entity with its RECEIPT attached — the thing they actually said
or sent that makes it theirs. Without the receipt a join message is surveillance; with it,
it's a friend saying "the guy you screenshotted in june just raised."

Mined nightly into ~/.co/entities/<tenant>.json. Rotating: the sweep checks the stalest
few each day, so a watched set of forty costs a handful of searches a day, not forty.

    python3 entities.py <tenant>          # mine and print the set
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

OUT_DIR = os.path.expanduser("~/.co/entities")
MAX_ENTITIES = 40
KINDS = ("person", "company", "product", "place", "event")

MINE_SYS = """From this person's own messages, extract the ENTITIES in their world: specific
people, companies, products, places, and events they mentioned or saved. Only real named things
someone could look up — never topics, never concepts, never generic categories.

EXCLUDE anything that merely APPEARED in something they sent: a face in a screenshot, a name
quoted inside an article, a brand in the background. The entity must be something THEY are
engaged with — sent deliberately, discussed, compared, pursued, or meeting. When in doubt, leave
it out; a watched thing they don't care about is worse than a missed one.

For each, write the RECEIPT: the concrete reason it is theirs, in their own terms, under 12
words, from the material itself ("sent his thread twice", "comparing it against the a7",
"meeting them thursday"). No receipt, no entity.

At most 12. Reply ONLY JSON:
{"entities": [{"name": "...", "kind": "person|company|product|place|event", "why": "..."}]}"""


def _path(tenant: str) -> str:
    os.makedirs(OUT_DIR, exist_ok=True)
    return os.path.join(OUT_DIR, f"{tenant}.json")


def load(tenant: str) -> dict:
    try:
        return json.load(open(_path(tenant)))
    except Exception:
        return {"entities": []}


def save(tenant: str, st: dict) -> None:
    json.dump(st, open(_path(tenant), "w"), ensure_ascii=False)


def _material(tenant: str) -> str:
    """Their own words only, through the one door (journal.member_material). Reading the raw
    stores here is what let a pasted article become a watched entity: a face in a screenshot
    and a chargeback spammer both entered this member's world that way (8/25)."""
    import journal
    return "\n".join(journal.member_material(tenant, limit=120))


def mine(tenant: str) -> int:
    """Fresh material → new entities, merged. An entity already known keeps its first receipt
    but refreshes its recency — the reason it matters is usually the reason it first landed."""
    import llm
    mat = _material(tenant)
    if len(mat) < 200:
        return 0
    got = llm.ask_json(llm.json_specs(), MINE_SYS, mat[-18000:], max_tokens=1600) or {}
    st = load(tenant)
    by_name = {e["name"].lower(): e for e in st["entities"]}
    dropped = set(st.get("dropped") or [])
    today = dt.date.today().isoformat()
    added = 0
    for raw in (got.get("entities") or []):
        name = str(raw.get("name") or "").strip()[:70]
        kind = str(raw.get("kind") or "").strip()
        why = str(raw.get("why") or "").strip()[:110]
        if not name or not why or kind not in KINDS:
            continue
        key = name.lower()
        if key in dropped:
            continue                      # they said no; the nightly mine does not overrule them
        if key in by_name:
            by_name[key]["seen"] = today
            by_name[key]["mentions"] = by_name[key].get("mentions", 1) + 1
            continue
        ent = {"name": name, "kind": kind, "why": why, "seen": today,
               "first": today, "mentions": 1, "checked": ""}
        st["entities"].append(ent)
        by_name[key] = ent
        added += 1
    # keep the set bounded by recency then weight — a world has a working size
    st["entities"].sort(key=lambda x: (x.get("seen", ""), x.get("mentions", 0)), reverse=True)
    st["entities"] = st["entities"][:MAX_ENTITIES]
    save(tenant, st)
    return added


def drop(tenant: str, name: str) -> bool:
    """The member's half: this is not my world, stop watching it. Dropped names are REMEMBERED,
    because mine() runs nightly over the same material and would resurrect it by morning —
    a correction that undoes itself is not a correction. co has no authority here; only the
    member drops, the same way only the member closes a list item."""
    key = (name or "").strip().lower()
    if not key:
        return False
    st = load(tenant)
    st["dropped"] = sorted({*(st.get("dropped") or []), key})[:400]
    before = len(st["entities"])
    st["entities"] = [e for e in st["entities"] if e.get("name", "").lower() != key]
    save(tenant, st)
    return len(st["entities"]) < before


def due(tenant: str, n: int = 6) -> list[dict]:
    """The stalest few — rotation is what keeps a 40-entity world cheap to watch."""
    st = load(tenant)
    ents = [e for e in st["entities"] if e.get("name")]
    ents.sort(key=lambda x: (x.get("checked", ""), -x.get("mentions", 0)))
    return ents[:n]


MAX_MISSES = 3


def mark_checked(tenant: str, name: str, moved: bool = False) -> None:
    """A watched thing that never moves and was only ever mentioned once is noise: it costs a
    search a day forever. Three silent checks and it leaves the set (self-cleaning beats
    hand-curation, and the mine will re-add it if they bring it up again)."""
    st = load(tenant)
    keep = []
    for e2 in st["entities"]:
        if e2["name"].lower() == name.lower():
            e2["checked"] = dt.date.today().isoformat()
            e2["misses"] = 0 if moved else e2.get("misses", 0) + 1
            if e2["misses"] >= MAX_MISSES and e2.get("mentions", 1) <= 1:
                continue
        keep.append(e2)
    st["entities"] = keep
    save(tenant, st)


if __name__ == "__main__":
    t = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CO_FOUNDER_TENANT", "dennis")
    print(f"{t}: +{mine(t)} new")
    for e in load(t)["entities"][:20]:
        print(f"  [{e['kind'][:7]:7s}] {e['name'][:34]:34s} — {e['why'][:60]}")
