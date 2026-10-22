#!/usr/bin/env python3
"""THE INVARIANTS — laws checked against REAL production state, not fixtures.

Why this file exists (2026-08-06): rail_eval was 59/59 green on a day five real bugs were
found by hand. A promise was marked kept with nothing sent. Three of four anchors carried
naive datetimes. A tester's timezone was never stored. A typing handler shipped and was
never registered, which is the dead-gate failure of 2026-07-30 recurring exactly.

None of those were catchable by the existing suite, and not because the tests were sloppy.
rail_eval tests ORGANS: build a fixture, call a function, assert the happy path. Every bug
above was one of:

  * a SEAM — anchors stored it right, proactive_tick voided it. Both pass alone.
  * a PROPERTY OF REAL STATE — no fixture is ever naive, so naive never appears.
  * a REACHABILITY failure — the code is correct and never runs.

So this suite inverts the direction. It builds nothing. It opens what production actually
wrote and asks whether that state is legal. A law here is worth more than a unit test
because it holds over every tenant, every day, forever, including for bugs nobody has
thought of yet.

    ./evals/run_eval.sh --invariants      # inside the rail eval
    ./evals/invariants.py                 # standalone, read-only, safe on production

READ-ONLY. It never writes, never sends, never mutates. Tenants are reported by a short
scrubbed handle and content is never printed — a failing law names the law and the count,
never the member's life.
"""
from __future__ import annotations

import datetime as dt
import glob
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FRAME = HERE.parent
CLAIMS = FRAME / "claims"
sys.path.insert(0, str(CLAIMS))

VIOLATIONS: list[tuple[str, str]] = []
CHECKED: list[str] = []


def law(name: str, ok: bool, detail: str = "") -> None:
    CHECKED.append(name)
    if not ok:
        VIOLATIONS.append((name, detail))


def scrub(tenant: str) -> str:
    """A tenant is identified well enough to find, never well enough to dox."""
    return re.sub(r"(\d{4})\d+(\d{2})", r"\1…\2", tenant)


def tenants() -> list[str]:
    """Real graphs only.

    The first cut excluded '5550'/'5551' by substring and let p1555222…, p1555333…, p1555666…
    straight through, so the report counted TEST tenants as members — the same wrong-population
    error as measuring the founder's graph and calling it a member's. 555 is the reserved
    fictional range in full: exclude the block, not two prefixes of it.
    """
    out = []
    for p in glob.glob(os.path.expanduser("~/.co/journal/*.json")):
        t = os.path.basename(p)[:-5]
        if t == "dennis":
            out.append(t)
        elif re.fullmatch(r"p1\d{10}", t) and not t.startswith("p1555"):
            out.append(t)
    return sorted(out)


def claims_db(tenant: str) -> str:
    return str(CLAIMS / ("claims.db" if tenant == "dennis" else f"claims_{tenant}.db"))


def _load(path: str):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


# ---------------------------------------------------------------- the laws

def check_promises(ts: list[str]) -> None:
    """The reliability floor. institution-law: 'reliability precedes magic.'"""
    naive, no_tz, kept_unsent, overdue = [], [], [], []
    now = dt.datetime.now()

    for t in ts:
        db = claims_db(t)
        doc = _load(f"{db}.anchors.json") or {}
        anchors = doc.get("anchors") or []
        if anchors:
            try:
                import tz_dynamic
                if not tz_dynamic.get_tz(db):
                    no_tz.append(t)
            except Exception:
                pass
        for a in anchors:
            fire = str(a.get("fire") or "")
            # LAW: a scheduled instant carries its zone. A bare wall-clock time silently
            # inherits whatever machine fired it — which is how a tester's reminder went
            # off three hours early on 8/6.
            if fire and not re.search(r"(Z|[+-]\d{2}:?\d{2})$", fire):
                naive.append((t, fire))
            # LAW: a REQUESTED reminder marked fired must have actually been sent.
            # `mark_fired(note="composer abstained")` wrote "kept" with nothing delivered.
            if a.get("requested") and a.get("fired") and "abstain" in str(a.get("note") or "").lower():
                kept_unsent.append((t, str(a.get("what") or "")[:40]))
            # LAW: a due promise fires. Long-overdue-and-unfired means the scheduler is dead.
            # An anchor explicitly recorded as MISSED is not evidence of a dead scheduler — it is
            # the audit trail of a promise co already admits it broke (8/30). Only unacknowledged
            # overdue promises mean the machinery stopped.
            if a.get("requested") and not a.get("fired") and not a.get("missed") and fire:
                try:
                    when = dt.datetime.fromisoformat(fire)
                    ref = now if when.tzinfo is None else dt.datetime.now(when.tzinfo)
                    if (ref - when).total_seconds() > 6 * 3600:
                        overdue.append((t, fire))
                except ValueError:
                    pass

    law("promise: every scheduled instant carries a timezone", not naive,
        f"{len(naive)} naive: " + ", ".join(f"{scrub(t)}@{f}" for t, f in naive[:3]))
    law("promise: a requested reminder is never marked kept unsent", not kept_unsent,
        f"{len(kept_unsent)}: " + ", ".join(f"{scrub(t)}:{w!r}" for t, w in kept_unsent[:3]))
    law("promise: no requested reminder is >6h overdue and unfired", not overdue,
        f"{len(overdue)}: " + ", ".join(f"{scrub(t)}@{f}" for t, f in overdue[:3]))
    law("promise: every tenant holding promises has a timezone", not no_tz,
        f"{len(no_tz)}: " + ", ".join(scrub(t) for t in no_tz[:4]))


def check_truth_contracts(ts: list[str]) -> None:
    """goal-v4 §8.2 — the stores may share Postgres; they may not share epistemic rules."""
    canon_in_core, digest_as_user = [], []
    for t in ts:
        db = claims_db(t)
        if os.path.exists(db):
            try:
                c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
                # LAW: co's own product docs are not facts about the member. (8/5: 17 of 20
                # resident lines were co's engineering spec.)
                n = c.execute("select count(*) from claims where COALESCE(evidence,'') "
                              "like '%\"source\": \"canon\"%' and salience is not null").fetchone()[0]
                if n:
                    canon_in_core.append((t, n))
                c.close()
            except sqlite3.Error:
                pass
        # LAW: co's own prose is never replayed as the member's words.
        tr = _load(os.path.expanduser(f"~/.co_{t}_sendblue_transcript.json")) or []
        bad = sum(1 for m in tr if isinstance(m, dict) and m.get("role") == "user"
                  and str(m.get("content") or "").lstrip().startswith("(from our conversations)"))
        if bad:
            digest_as_user.append((t, bad))

    law("truth: canon claims never enter the carried core", not canon_in_core,
        ", ".join(f"{scrub(t)}:{n}" for t, n in canon_in_core[:3]))

    # LAW: a retired belief is dead. Carrying a salience score on it means one forgotten
    # status filter resurrects it into the ranking.
    stale_rank, doc_heavy = [], []
    for t in ts:
        db = claims_db(t)
        if not os.path.exists(db):
            continue
        try:
            c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            n = c.execute("select count(*) from claims where COALESCE(status,'active')='retired' "
                          "and salience is not null").fetchone()[0]
            if n:
                stale_rank.append((t, n))
            # LAW: what co can RECALL about the member is the member.
            #
            # This counted live rows until 8/29 and named the wrong quantity. Row count is not
            # the harm: canon claims sit in the graph on purpose, so the founder can look up
            # what was decided, and 4,292 inert rows hurt nobody. The harm is which of them can
            # come BACK — and the answer was that 4,127 of 4,328 embedded claims were co's own
            # documentation against 201 real ones, so every semantic recall about him was drawn
            # 95% from the engineering spec. Canon is no longer embedded (embed.py) and both
            # readers filter it, so this now measures the pool a recall actually draws from.
            pool = c.execute("select count(*) from claims where COALESCE(status,'active')!='retired' "
                             "and embedding is not null").fetchone()[0]
            canon = c.execute("select count(*) from claims where COALESCE(status,'active')!='retired' "
                              "and embedding is not null and COALESCE(evidence,'') like ?",
                              ('%"source": "canon"%',)).fetchone()[0]
            if pool >= 200 and canon > (pool - canon):
                doc_heavy.append((t, canon, pool - canon))
            c.close()
        except sqlite3.Error:
            pass

    law("truth: retired beliefs carry no salience", not stale_rank,
        ", ".join(f"{scrub(t)}:{n}" for t, n in stale_rank[:3]))

    # LAW: canon belongs to exactly ONE graph — the founder's. co's product documentation
    # is not a fact about a member: it is untrue of them, it drowns their real beliefs in
    # recall, and it hands them co's internal strategy. Checked across EVERY graph on the
    # box, including eval and demo tenants, because a leak anywhere is the same bug.
    founder = os.environ.get("CO_FOUNDER_TENANT", "dennis")
    leaked = []
    for db in glob.glob(str(CLAIMS / "claims*.db")):
        if db.endswith(".co_memory.db"):
            continue
        name = os.path.basename(db)
        t = "dennis" if name == "claims.db" else name[7:-3]
        if t == founder:
            continue
        try:
            c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            n = c.execute("select count(*) from claims where COALESCE(evidence,'') like ?",
                          ('%"source": "canon"%',)).fetchone()[0]
            c.close()
            if n:
                leaked.append((t, n))
        except sqlite3.Error:
            pass
    law("isolation: canon exists only on the founder's graph", not leaked,
        ", ".join(f"{scrub(t)}:{n}" for t, n in leaked[:4]))
    law("truth: semantic recall draws on the member, not co's own docs", not doc_heavy,
        ", ".join(f"{scrub(t)}: {c} canon vs {r} real in the recall pool" for t, c, r in doc_heavy[:3]))

    # LAW: canon never holds a vector-index slot. The read filters in claimstore and co_react
    # are the belt; this is the braces, because the 8/5 fix was a read filter too and two new
    # readers reinstated the bug anyway. Not embedded means not recallable by any future reader.
    embedded_canon = []
    for t in ts:
        db = claims_db(t)
        if not os.path.exists(db):
            continue
        try:
            c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            n = c.execute("select count(*) from claims where embedding is not null "
                          "and COALESCE(evidence,'') like ?", ('%"source": "canon"%',)).fetchone()[0]
            c.close()
            if n:
                embedded_canon.append((t, n))
        except sqlite3.Error:
            pass
    law("truth: co's own docs are never embedded", not embedded_canon,
        ", ".join(f"{scrub(t)}:{n}" for t, n in embedded_canon[:3]))
    law("truth: co's digests never appear as the member's turns", not digest_as_user,
        ", ".join(f"{scrub(t)}:{n}" for t, n in digest_as_user[:3]))


def check_lived(ts: list[str]) -> None:
    """lived.py's laws, checked against what is actually on disk rather than in a fixture."""
    self_endorsed, over_cap = [], []
    try:
        import lived as LV
    except Exception:
        return
    for t in ts:
        try:
            proj = LV._project(t)
        except Exception:
            continue
        for x in proj.values():
            # LAW 4: only the member closes. `endorsed` with no verdict event is co
            # marking its own work successful.
            if x["state"] == "endorsed" and not x.get("verdict"):
                self_endorsed.append(t)
        if len(LV._live(proj)) > LV.MAX_LIVE:
            over_cap.append((t, len(LV._live(proj))))
    law("lived: nothing is endorsed without a member verdict", not self_endorsed,
        ", ".join(scrub(t) for t in self_endorsed[:3]))
    law("lived: live changes stay under the cap", not over_cap,
        ", ".join(f"{scrub(t)}:{n}" for t, n in over_cap[:3]))


def check_reachability() -> None:
    """The dead-gate law (2026-07-30): correct code that never runs is not a feature.

    Every handler the router exposes must be reachable — for webhook-driven paths that
    means the subscription actually exists at the provider. The typing handler shipped on
    8/6 against an unregistered webhook and could never have fired.
    """
    router = (FRAME / "homebase" / "router" / "sendblue_router.py").read_text()
    handled = set(re.findall(r'payload\.get\("(is_typing)"\)', router))
    if "is_typing" in handled:
        want = os.environ.get("CO_EXPECT_TYPING_WEBHOOK", "")
        law("reachable: typing handler has a registered webhook",
            want == "1",
            "handler exists but typing_indicator is not registered with Sendblue "
            "(set CO_EXPECT_TYPING_WEBHOOK=1 once it is)")


def check_areas() -> None:
    """Every top-level source area is described in MAP.md (2026-09-01).

    The audit that produced the map found packages/action-harness — 1,619 lines, 16 passing tests,
    untracked — specifying the same execution boundary frame/claims/actions.py had just rebuilt in
    Python. Two answers to one question, neither aware of the other, because nothing described the
    tree. Same law as claims/TOOLS: a directory that appears without an explanation is cheapest to
    explain on the day it appears.
    """
    repo = FRAME.parent
    try:
        mapped = (repo / "MAP.md").read_text()
    except OSError:
        law("areas: MAP.md exists", False, "MAP.md is missing")
        return
    skip = {"node_modules", "docs", ".agents", ".git", ".githooks", "dist", "build"}
    areas = [d.name for d in repo.iterdir()
             if d.is_dir() and not d.name.startswith(".") and d.name not in skip
             and any(d.rglob(e) for e in ("*.py", "*.ts", "*.tsx", "*.swift"))]
    # `apps/web` describing apps/ is the useful granularity, so a subdirectory mention counts.
    missing = sorted(a for a in areas if f"`{a}/" not in mapped and f"`{a}`" not in mapped)
    law("areas: every source area is described in MAP.md", not missing,
        f"undescribed: {', '.join(missing)} — say what it is and whether it runs")


def check_wired() -> None:
    """Every organ is reachable from something that runs, or declared a tool (2026-09-01).

    The recurring defect in this repo is not dead code, it is unwired code: correct, committed,
    referenced in docs, and never executed. actions.py was imported by nothing while the acting
    layer was called done. The Day 0 lane, the corpus fix, the shape gate and the wake were each
    complete and unreachable at some point in the same week.

    So reachability stops being something you notice by hand. Entrypoints are read from the crontab,
    the reconciler schedule and the launch agents, the import closure is walked from there, and
    anything outside it must be named in claims/TOOLS with a reason. A new organ that nobody calls
    fails here, which is the only moment the cost of it is still zero.
    """
    import json
    import subprocess
    text = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
    try:
        cfg = json.loads((FRAME / "reconciler.json").read_text())
        entries = cfg if isinstance(cfg, list) else (cfg.get("entries") or cfg.get("jobs") or [])
        text += "\n".join(str(e.get("cmd", "")) for e in entries)
    except Exception:
        pass
    agents = Path(os.path.expanduser("~/Library/LaunchAgents"))
    for f in agents.glob("com.dennis.*.plist") if agents.is_dir() else []:
        try:
            text += "\n" + f.read_text()
        except OSError:
            pass

    mods = {f.stem for f in CLAIMS.glob("*.py")}
    src = {m: (CLAIMS / f"{m}.py").read_text(errors="ignore") for m in mods}
    router = FRAME / "homebase" / "router" / "sendblue_router.py"
    src["sendblue_router"] = router.read_text(errors="ignore")

    seen, queue = set(), [m for m in mods if re.search(rf"\b{m}\.py\b", text)] + ["sendblue_router"]
    while queue:
        m = queue.pop()
        if m in seen:
            continue
        seen.add(m)
        for other in mods - seen:
            if re.search(rf"\bimport {other}\b|\bfrom {other} import\b", src.get(m, "")):
                queue.append(other)

    try:
        declared = {ln.split()[0] for ln in (CLAIMS / "TOOLS").read_text().splitlines()
                    if ln.strip() and not ln.startswith("#")}
    except OSError:
        declared = set()
    try:
        parked = {ln.split()[0] for ln in (CLAIMS / "PARKED").read_text().splitlines()
                  if ln.strip() and not ln.startswith("#")}
    except OSError:
        parked = set()
    orphans = sorted(mods - seen - declared - parked)
    law("wired: every organ runs, is a declared tool, or is parked with a reason", not orphans,
        f"{len(orphans)} unreachable and unexplained: " + ", ".join(orphans[:6])
        + " — wire it, or name it in claims/TOOLS or claims/PARKED")
    lying = []
    for f in CLAIMS.glob("*.py"):
        m = re.search(r"^Wired: (LIVE cron[^\n]*)", f.read_text(errors="ignore"), re.M)
        if m and not re.search(rf"\b{f.stem}\.py\b", text):
            lying.append(f"{f.stem} claims {m.group(1)[:34]!r}")
    law("wired: a LIVE cron claim in a docstring is true", not lying, "; ".join(lying[:3]))

    if parked:
        print(f"  \033[33m·\033[0m {len(parked)} organ(s) parked and not running: "
              + ", ".join(sorted(parked)[:6]) + (" …" if len(parked) > 6 else ""))


def check_engine_silence() -> None:
    """An outage that reaches the member as silence is the correct behaviour and exactly why it
    needs counting (2026-09-06).

    Two engine failures that morning reached the founder as no text and a tapback — the right
    member-facing outcome, since an outage must never wear a reply. But nothing counted them, and
    the safer a failure looks the longer it survives. A handful in a day is a flaky provider; a
    wall of them is the product being down while every dashboard stays green.
    """
    log = os.path.expanduser("~/.co/homebase/router/launchd.out")
    if not os.path.exists(log):
        return
    today = dt.datetime.now().strftime("%Y-%m-%d")
    unanswered = served = 0
    try:
        with open(log, errors="ignore") as fh:
            for line in fh:
                if not line.startswith(today):
                    continue
                if "went unanswered" in line:
                    unanswered += 1
                elif "sent via" in line:
                    served += 1
    except OSError:
        return
    law("reachable: the engine answers the turns it is given", unanswered <= 3,
        f"{unanswered} unanswered today, {served} sent — an outage wearing the shape of restraint")


def check_deployed() -> None:
    """A running process is not older than any code it could have loaded (2026-08-31).

    Two days of commits were green in the eval and none were live: the engine had been up since
    8/25 and the router since 8/28. The first cut of this law compared each process only against
    its own entrypoint, which misses the larger half — the router imports ~96 organs from claims/,
    Python caches them on first import, and an organ edited afterwards stays stale in that process
    for as long as it runs. So the comparison is against the newest file in the whole tree the
    process draws from.

    Deliberately conservative. A maintenance script nothing imports will still flag the router as
    stale, and the cost of that is a restart, which is cheap. The cost of the other error is what
    happened on 8/31.
    """
    import subprocess
    trees = {
        8090: [FRAME / "brain"],
        8099: [FRAME / "homebase" / "router", CLAIMS],
    }
    for port, roots in trees.items():
        newest, when = None, 0.0
        for root in roots:
            for f in list(root.glob("*.py")) + list(root.glob("*.ts")):
                try:
                    m = f.stat().st_mtime
                except OSError:
                    continue
                if m > when:
                    newest, when = f, m
        try:
            pid = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                                 capture_output=True, text=True, timeout=10).stdout.split()
            if not pid:
                law(f"deployed: something is listening on {port}", False, "nothing is listening")
                continue
            started = subprocess.run(["ps", "-o", "lstart=", "-p", pid[0]],
                                     capture_output=True, text=True, timeout=10).stdout.strip()
            began = dt.datetime.strptime(started, "%a %b %d %H:%M:%S %Y")
            stale_h = (dt.datetime.fromtimestamp(when) - began).total_seconds() / 3600
            law(f"deployed: :{port} is running the current tree", stale_h <= 0,
                f"{newest.name if newest else '?'} is {stale_h:.1f}h newer than the process "
                f"(started {began:%m/%d %H:%M}) — kickstart it; the watchdog only fires on death")
        except Exception as e:
            law(f"deployed: :{port} freshness is checkable", False, f"{type(e).__name__}: {e}")


def check_attribution() -> None:
    """A claim about the member is about THE MEMBER (2026-08-29).

    co stored "Dan is building a product called 'co-'" at 0.95 with its highest provenance, for
    five days, outranking the true claim at 0.782. Dan Koe is an author whose article the member
    deposited. Nothing retrieved it wrongly — it was WRITTEN wrong, by taking the member's own act
    and pinning it on the loudest name in the context window.

    Correction-tier claims are checked strictly because that tier overrides everything else. The
    wider graph is reported but not enforced: a claim about someone in the member's life is
    legitimate, and the ambiguity is real.
    """
    import attribution
    bad_corrections, foreign = [], []
    for t in tenants():
        db = claims_db(t)
        if not os.path.exists(db):
            continue
        for h in attribution.sweep(db):
            (bad_corrections if h["correction"] else foreign).append((t, h["who"], h["id"]))
    law("truth: no correction claims something about someone else", not bad_corrections,
        ", ".join(f"{scrub(t)}:{w}#{i}" for t, w, i in bad_corrections[:3]))
    if foreign:
        print(f"  \033[33m·\033[0m {len(foreign)} live claim(s) about a third party "
              f"(not a violation; review if any should be the member)")


def check_take() -> None:
    """The take lane (2026-08-28) reopens unprompted prose, which real data closed. Three laws
    keep that reversible, and all three are structural — an env flag can turn the lane on, but
    none of these can be turned off from config.
    """
    src = (CLAIMS / "take.py").read_text()
    router = (FRAME / "homebase" / "router" / "sendblue_router.py").read_text()

    # The writer may not grade itself. The first build asked one call for a take AND a 0-10 score;
    # the same take scored 7 and then 4 on identical input, so the bar was gating on noise.
    law("take: the judge is a separate call from the writer",
        "JUDGE_SYS" in src and "def beats_silence" in src
        and re.search(r"if not beats_silence\(", src) is not None,
        "compose() must clear an independent judge, not a self-reported score")

    # Off for everybody until named. A roster miss here silently opts in every member at once.
    law("take: off by default, per-tenant roster",
        'roster._rostered(tenant, "CO_TAKE_TENANTS")' in src
        and re.search(r"if not rostered\(tenant\)", src) is not None,
        "the lane must be roster-gated and default closed")

    # Measured both ways, or the 8/22 ruling gets reversed on vibes a second time.
    law("take: every send and every refusal reaches the ledger",
        "landed.record(" in router and "landed.hold_out(" in router
        and "def _take_line" in router,
        "sends must be recorded and judge refusals held out, so objective() can settle it")


def check_hygiene() -> None:
    """Config laws that only fail in production, months later, on a new host."""
    bad_models = []
    for p in glob.glob(str(FRAME / "brain" / "*.ts")) + glob.glob(str(CLAIMS / "*.py")):
        if "/archive/" in p or "/benchmark/" in p:
            continue
        try:
            src = Path(p).read_text()
        except OSError:
            continue
        # LAW: a stale model id as a silent fallback is a generation drop waiting for one
        # missing env var. Registry or nothing.
        for m in re.findall(r'\|\|\s*"(claude-[a-z0-9.\-]+)"|\?\?\s*"(gpt-[a-z0-9.\-]+)"', src):
            hit = m[0] or m[1]
            if hit:
                bad_models.append(f"{Path(p).name}:{hit}")
    law("hygiene: no stale model id as a silent fallback", not bad_models,
        f"{len(bad_models)}: " + ", ".join(sorted(set(bad_models))[:4]))


def main(argv: list[str]) -> int:
    ts = tenants()
    print(f"invariants — {len(ts)} real tenant(s), read-only\n")
    check_promises(ts)
    check_truth_contracts(ts)
    check_lived(ts)
    check_reachability()
    check_deployed()
    check_engine_silence()
    check_wired()
    check_areas()
    check_attribution()
    check_take()
    check_hygiene()

    for name in CHECKED:
        bad = next((d for n, d in VIOLATIONS if n == name), None)
        if bad is None:
            print(f"  \033[32m✓\033[0m {name}")
        else:
            print(f"  \033[31m✗\033[0m {name}\n      {bad}")
    print(f"\n{len(CHECKED) - len(VIOLATIONS)} held · {len(VIOLATIONS)} VIOLATED")
    return 1 if VIOLATIONS else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
