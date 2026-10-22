#!/usr/bin/env python3
"""E4 — selective prediction: calibrate the confidence, THEN abstain below a bar.

The held-out finding: the confident-wrongs were at HIGH stated confidence (0.72–0.82) — the stated number is
the lie. So abstaining on stated-conf wouldn't catch them. Instead: fit an isotonic map (E2) stated→calibrated
confidence on all labeled pairs, apply it at answer time, and abstain when CALIBRATED confidence < TAU. That
pulls overconfident frame-guesses down below the bar → honest INSUFFICIENT instead of a comfortable wrong guess.

  doppler run -- /…/python3 calibration_map.py            # fit + persist + validate the abstention tradeoff
Used at inference by run_heldout/run_benchmark via decide(conf).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import calibrate as _cal
from calib_experiments import isotonic_fit, iso_predict, adaptive_ece

HERE = Path(__file__).resolve().parent
MAP_FILE = HERE / "calibration_map.json"
TAU_DEFAULT = 0.45   # abstain when calibrated confidence < TAU (tuned below)


def _all_pairs():
    pairs = []
    for f in sorted(HERE.glob("results*.md")):
        for r in _cal.parse(f.read_text()):
            if r["grade"] in ("0", "0.0", "0.5", "1", "1.0") and r["conf"] is not None:
                pairs.append((r["conf"], float(r["grade"])))
    return pairs


def fit_and_save():
    pairs = _all_pairs()
    xs = [c for c, _ in pairs]
    ys = [g for _, g in pairs]
    sx, fy = isotonic_fit(xs, ys)
    MAP_FILE.write_text(json.dumps({"sx": sx, "fy": fy, "n": len(pairs), "tau": TAU_DEFAULT}))
    return sx, fy, pairs


_MAP = None


def _load():
    global _MAP
    if _MAP is None:
        if MAP_FILE.exists():
            d = json.loads(MAP_FILE.read_text())
            _MAP = (d["sx"], d["fy"], d.get("tau", TAU_DEFAULT))
        else:
            _MAP = ([0.0, 1.0], [0.0, 1.0], TAU_DEFAULT)  # identity until fit
    return _MAP


def calibrate_conf(conf: float) -> float:
    sx, fy, _ = _load()
    return iso_predict(sx, fy, conf)


def decide(conf: float, tau: float = None) -> bool:
    """True = ABSTAIN (calibrated confidence below the bar)."""
    sx, fy, t = _load()
    return calibrate_conf(conf) < (tau if tau is not None else t)


def apply_abstention(answer: str, tau: float = None) -> str:
    """E4 inference hook: parse the [conf: X] the model stated; if calibrated conf is below the bar, replace
    the answer with an honest abstention. Already-INSUFFICIENT answers pass through. Used by the runners +
    (later) the live witness, so it never asserts a frame it can't ground.

    `tau` lets the caller set an ASYMMETRIC bar by evidence level (see synth_calib): a confident-wrong
    interior portrait is the fatal class (strict bar), while a tentative behavioral answer is recoverable
    and useful at moderate accuracy (permissive bar). One global bar either lets the killers through or
    guts coverage — the held-out re-test showed exactly that tradeoff."""
    import re
    if not answer or answer.strip().upper().startswith("INSUFFICIENT"):
        return answer
    m = re.search(r"\[conf:\s*([0-9.]+)\s*\]", answer)
    if not m:
        return answer
    conf = float(m.group(1))
    if decide(conf, tau):
        return f"INSUFFICIENT — calibrated confidence {calibrate_conf(conf):.2f} below bar (stated {conf:.2f}); abstaining rather than guess. [conf: {calibrate_conf(conf):.2f}]"
    return answer


if __name__ == "__main__":
    sx, fy, pairs = fit_and_save()
    n = len(pairs)
    print(f"fit isotonic map on {n} labeled pairs (original + held-out) → {MAP_FILE.name}\n")
    print("  stated → calibrated (sample):")
    for c in (0.3, 0.5, 0.65, 0.75, 0.85, 0.95):
        print(f"    {c:.2f} → {iso_predict(sx, fy, c):.2f}")

    # abstention tradeoff: for each TAU, coverage + accuracy-on-answered + confident-wrong (answered & wrong)
    print("\n  abstention tradeoff (answer only when calibrated ≥ TAU):")
    print("    TAU   coverage   acc@answered   wrong@answered(0-graded)")
    raw_cw = sum(1 for c, g in pairs if c >= 0.7 and g == 0)
    print(f"    (raw, no abstention: coverage 100%, confident-wrong = {raw_cw}/{n})")
    for tau in (0.35, 0.45, 0.55, 0.65):
        answered = [(c, g) for c, g in pairs if iso_predict(sx, fy, c) >= tau]
        if not answered:
            print(f"    {tau:.2f}   0%"); continue
        cov = len(answered) / n
        acc = sum(g for _, g in answered) / len(answered)
        wrong = sum(1 for _, g in answered if g == 0)
        print(f"    {tau:.2f}   {cov*100:4.0f}%      {acc:.0%}            {wrong}/{len(answered)}")
    print("\n  → pick the TAU where wrong@answered≈0 at the best coverage. Wired into answering via decide().")
    print("  caveat: fit includes the contaminated original L5 (held-out alone is n=14); refit after E10 grows labels.")
