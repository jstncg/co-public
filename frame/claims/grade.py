#!/usr/bin/env python3
"""Subject-as-grader — the human is ground truth (UNDERSTANDING_AGENT.md P2).

The carried core is the highest-stakes artifact: one confident-wrong line ("you do that Aidan-Call thing")
destroys trust. No model can verify it — only the subject can. So Dennis grades the would-be core: keep the
real, retire the junk. His verdict (`graded`) overrides the computed salience (the prior). This is what
fixes the alert-misread cluster (20 paraphrases of "possibly works in tech" at 50% conf) the score surfaces.

CLUSTER-AWARE: paraphrase-dupes that dedup (0.90 cosine) missed get grouped (looser ≥0.80) so one verdict
collapses the whole pile — keep the best phrasing, retire the rest. Grading 20 noise-variants = one keystroke.

  doppler run -- /…/python3 grade.py             # interactive: grade the top-salience clusters
  doppler run -- /…/python3 grade.py --stale      # grade the lifecycle-flagged stale high-value beliefs
  doppler run -- /…/python3 grade.py --list        # non-interactive preview of the clusters (no changes)

Per cluster:  [k]eep best (retire the rest) · [b]oost · [d]emote whole · [r]etire whole · ⏎ skip · q quit
"""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "engine"))
from co_engine import ontology as _O
import claimstore  # noqa: E402
import salience as sal  # noqa: E402

TODAY = dt.date.today().isoformat()
CLUSTER_SIM = 0.80   # looser than dedup's 0.90 — group paraphrases dedup left behind


def _embeddings(conn, ids):
    """{id: unit-vector} for the candidate ids that have an embedding. Empty dict if numpy/embeddings absent."""
    try:
        import numpy as np
        out = {}
        q = ",".join("?" * len(ids))
        for cid, emb in conn.execute(f"SELECT id, embedding FROM claims WHERE id IN ({q}) AND embedding IS NOT NULL", ids):
            v = np.frombuffer(emb, dtype=np.float32)
            out[cid] = v / (np.linalg.norm(v) + 1e-9)
        return out
    except Exception:
        return {}


def _cluster(cands, embs):
    """Greedy clustering by cosine ≥ CLUSTER_SIM. cands = [(id, sal, conf, type, level, stmt)], salience-desc.
    Each cluster's head = highest-salience member (cands already sorted)."""
    try:
        import numpy as np
    except Exception:
        return [[c] for c in cands]
    clusters, used = [], set()
    for c in cands:
        if c[0] in used:
            continue
        head, members = c, [c]
        used.add(c[0])
        if c[0] in embs:
            for d in cands:
                if d[0] in used or d[0] not in embs:
                    continue
                if float(embs[c[0]] @ embs[d[0]]) >= CLUSTER_SIM:
                    members.append(d)
                    used.add(d[0])
        clusters.append(members)
    return clusters


def _candidates(conn, stale=False, limit=40):
    sal.recompute(conn)
    if stale:
        rows = claimstore.stale_claims(conn, TODAY, min_conf=0.5, limit=limit)  # (age, conf, stmt)
        ids = []
        for _age, _conf, stmt in rows:
            r = conn.execute("SELECT id, salience, confidence, type, level, statement FROM claims "
                             "WHERE statement=? AND COALESCE(status,'active')!='retired'", (stmt,)).fetchone()
            if r:
                ids.append(r)
        return ids
    return conn.execute(
        "SELECT id, salience, confidence, type, level, statement FROM claims "
        "WHERE COALESCE(status,'active')!='retired' AND graded IS NULL AND salience IS NOT NULL "
        "ORDER BY salience DESC LIMIT ?", (limit,)).fetchall()


def _retire(conn, cid):
    _O.retire(conn, [cid], TODAY, commit=False)


def _set_grade(conn, cid, g):
    conn.execute("UPDATE claims SET graded=?, last_verified=? WHERE id=?", (g, TODAY, cid))


def main():
    stale = "--stale" in sys.argv
    preview = "--list" in sys.argv
    conn = claimstore.connect()
    cands = _candidates(conn, stale=stale)
    if not cands:
        print("nothing to grade — core is clean." if not stale else "no stale high-value beliefs.")
        return
    embs = _embeddings(conn, [c[0] for c in cands])
    clusters = _cluster(cands, embs)
    print(f"{'STALE re-verify' if stale else 'CARRIED-CORE'} grading — {len(cands)} claims in {len(clusters)} clusters\n")

    interactive = sys.stdin.isatty() and not preview
    for i, members in enumerate(clusters, 1):
        head = members[0]
        cid, s, conf, t, lv, stmt = head
        print(f"[{i}/{len(clusters)}] {s:.2f}sal/{conf:.0%}conf ({t}/{lv})  {stmt}")
        if len(members) > 1:
            print(f"      + {len(members)-1} paraphrase-variant(s): " + " | ".join(m[5][:42] for m in members[1:4]) +
                  (" …" if len(members) > 4 else ""))
        if not interactive:
            continue
        choice = input("      [k]eep best / [b]oost / [d]emote all / [r]etire all / ⏎skip / q: ").strip().lower()
        if choice == "q":
            break
        elif choice in ("k", "b"):
            _set_grade(conn, cid, "boost" if choice == "b" else "keep")
            for m in members[1:]:
                _retire(conn, m[0])   # keep the best phrasing, retire the paraphrases
        elif choice == "d":
            for m in members:
                _set_grade(conn, m[0], "demote")
        elif choice == "r":
            for m in members:
                _retire(conn, m[0])
        conn.commit()

    n = sal.recompute(conn)
    print(f"\n🎚️  re-scored {n} active claims after grading." +
          ("" if interactive else "  (preview only — no changes written; run without --list to grade)"))


if __name__ == "__main__":
    main()
