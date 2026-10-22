#!/usr/bin/env python3
"""Embeddings for the claim store — dedup + semantic recall (SUBSTRATE_PLAN Flaw #4).

The dense graph (13.7k claims from 45k emails) has heavy NEAR-duplication ("Uses Uber" said 5 ways) —
exact-string UNIQUE can't catch it — and keyword recall misses semantically-related claims. Embeddings
fix both: cosine-dedup collapses the duplicates; semantic recall finds claims by meaning, not keyword.

Model: voyage-4-lite (1024d) — the current Voyage generation as of 2026 (voyage-3-lite is previous-gen).
Storage: a float32 blob column on the claim row. At ~14k short claims, brute-force numpy cosine is ms —
no sqlite-vec needed (that's for millions).

  doppler run -- /…/python3 embed.py          # embed all un-embedded claims
  doppler run -- /…/python3 embed.py dedup     # then collapse near-duplicates
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "engine"))
from co_engine import ontology as _O
from claimstore import connect

_CANON = '%"source": "canon"%'   # doc-derived: never embedded, never semantically recalled

MODEL = "voyage-4-lite"   # current Voyage gen (2026); voyage-3-lite is previous-gen
DIM = 1024


def voyage(texts, input_type="document"):
    key = os.environ["VOYAGE_API_KEY"]
    req = urllib.request.Request(
        "https://api.voyageai.com/v1/embeddings",
        data=json.dumps({"input": texts, "model": MODEL, "input_type": input_type}).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    r = json.loads(urllib.request.urlopen(req, timeout=60).read())
    return [d["embedding"] for d in r["data"]]


def embed_all(conn, batch=128):
    conn.execute("UPDATE claims SET status=status")  # noop to ensure table is writable
    # kyo 8bd9f9b, ported: a forgotten claim's embedding was NULLed by the cascade ON PURPOSE —
    # re-embedding it would ship the forgotten text right back to the embedder. Retired stays dropped.
    # CANON IS NOT EMBEDDED (2026-08-29). The embedding is the retrieval surface, so embedding
    # co's own product documentation put it INTO semantic recall: 4,127 of the founder's 4,328
    # embedded live claims were docs, 201 were him. Every recall_semantic() call was answering
    # "who is this person" out of the engineering spec at 20:1 odds.
    #
    # 8/5 fixed the same class at READ time in memory.ts and the note on that fix says why this
    # one is here instead: a read filter leaves the rows sitting there, and any new reader that
    # forgets the clause reinstates the bug. Two Python readers (claimstore.recall_semantic and
    # co_react) did exactly that, for three weeks. Canon stays in the graph and stays keyword-
    # findable; it just stops competing with the member for the vector index.
    rows = conn.execute("SELECT id, statement FROM claims WHERE embedding IS NULL "
                        "AND COALESCE(status,'active') != 'retired' "
                        "AND COALESCE(evidence,'') NOT LIKE ?", (_CANON,)).fetchall()
    print(f"embedding {len(rows)} un-embedded claims via {MODEL}...")
    t0, done = time.time(), 0
    for i in range(0, len(rows), batch):
        chunk = rows[i:i+batch]
        vecs = voyage([s for _, s in chunk])
        for (cid, _), v in zip(chunk, vecs):
            conn.execute("UPDATE claims SET embedding=? WHERE id=?",
                         (np.asarray(v, dtype=np.float32).tobytes(), cid))
        conn.commit()
        done += len(chunk)
        print(f"  {done}/{len(rows)}  ({done/max(time.time()-t0,0.01):.0f}/s)")
    return done


def _matrix(conn, where="embedding IS NOT NULL AND COALESCE(status,'active')!='retired'"):
    rows = conn.execute(f"SELECT id, type, statement, confidence, embedding FROM claims WHERE {where}").fetchall()
    ids = [r[0] for r in rows]
    meta = {r[0]: (r[1], r[2], r[3]) for r in rows}
    M = np.array([np.frombuffer(r[4], dtype=np.float32) for r in rows]) if rows else np.zeros((0, DIM))
    M = M / (np.linalg.norm(M, axis=1, keepdims=True) + 1e-9)   # L2 normalize → dot = cosine
    return ids, meta, M


def dedup(conn, threshold=0.90):
    """Collapse near-duplicate claims (same type, cosine ≥ threshold) into the highest-confidence one:
    union evidence, retire the rest. Beliefs consolidate instead of fragmenting."""
    ids, meta, M = _matrix(conn)
    if len(ids) < 2:
        return 0
    sims = M @ M.T
    merged, retired = set(), 0
    order = sorted(range(len(ids)), key=lambda i: -meta[ids[i]][2])   # high-confidence first = the keeper
    for i in order:
        if ids[i] in merged:
            continue
        for j in range(len(ids)):
            if i == j or ids[j] in merged:
                continue
            if meta[ids[i]][0] != meta[ids[j]][0]:    # only merge same type
                continue
            if sims[i, j] >= threshold:
                # merge j into i: union evidence, retire j
                ev_i = json.loads(conn.execute("SELECT evidence FROM claims WHERE id=?", (ids[i],)).fetchone()[0])
                ev_j = json.loads(conn.execute("SELECT evidence FROM claims WHERE id=?", (ids[j],)).fetchone()[0])
                seen = {json.dumps(e, sort_keys=True): e for e in ev_i + ev_j}
                conn.execute("UPDATE claims SET evidence=? WHERE id=?", (json.dumps(list(seen.values())), ids[i]))
                _O.retire(conn, [ids[j]], commit=False)       # merged away: dead and unranked
                merged.add(ids[j])
                retired += 1
    conn.commit()
    return retired


if __name__ == "__main__":
    conn = connect()
    if len(sys.argv) > 1 and sys.argv[1] == "dedup":
        before = conn.execute("SELECT count(*) FROM claims WHERE COALESCE(status,'active')!='retired'").fetchone()[0]
        n = dedup(conn)
        after = conn.execute("SELECT count(*) FROM claims WHERE COALESCE(status,'active')!='retired'").fetchone()[0]
        print(f"🧹 dedup: retired {n} near-duplicates → {before} active → {after} active")
    else:
        embed_all(conn)
        print("done. run `embed.py dedup` to collapse near-duplicates.")
