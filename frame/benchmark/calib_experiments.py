#!/usr/bin/env python3
"""E1 + E2 of CALIBRATION_PLAN.md — reliability baseline + post-hoc calibration map.

E1: reliability diagram, adaptive-bin ECE, overconfidence, confident-wrong, per-tier, risk-coverage.
E2: leave-one-out isotonic regression (PAV) + Platt (1D logistic) conf→accuracy maps; LOOCV ECE before/after.
No sklearn — PAV + logistic hand-rolled. n is small (~43), so LOOCV is the only honest estimate.

  doppler run -- /…/python3 calib_experiments.py [results-YYYY-MM-DD.md]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import calibrate  # reuse the parser

HERE = Path(__file__).resolve().parent


def adaptive_ece(pairs, k=5):
    """Equal-count binning ECE (raw equal-width ECE is unstable at small n)."""
    if not pairs:
        return 0.0, []
    p = sorted(pairs, key=lambda t: t[0])
    n = len(p)
    bins, ece = [], 0.0
    for b in range(k):
        lo = b * n // k
        hi = (b + 1) * n // k
        chunk = p[lo:hi]
        if not chunk:
            continue
        mc = sum(c for c, _ in chunk) / len(chunk)
        ma = sum(g for _, g in chunk) / len(chunk)
        ece += len(chunk) / n * abs(mc - ma)
        bins.append((mc, ma, len(chunk)))
    return ece, bins


def isotonic_fit(xs, ys):
    """PAV: returns (sorted_x, fitted_y) monotone non-decreasing."""
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    sx = [xs[i] for i in order]
    sy = [ys[i] for i in order]
    vals, wts, cnts = [], [], []
    for y in sy:
        vals.append(y); wts.append(1.0); cnts.append(1)
        while len(vals) > 1 and vals[-2] > vals[-1]:
            nv = (vals[-2] * wts[-2] + vals[-1] * wts[-1]) / (wts[-2] + wts[-1])
            nw = wts[-2] + wts[-1]; nc = cnts[-2] + cnts[-1]
            vals.pop(); wts.pop(); cnts.pop()
            vals[-1] = nv; wts[-1] = nw; cnts[-1] = nc
    fitted = []
    for v, c in zip(vals, cnts):
        fitted += [v] * c
    return sx, fitted


def iso_predict(sx, fy, x):
    """Linear-interpolate the fitted monotone step function at x (clamped)."""
    if x <= sx[0]:
        return fy[0]
    if x >= sx[-1]:
        return fy[-1]
    for i in range(1, len(sx)):
        if x <= sx[i]:
            if sx[i] == sx[i - 1]:
                return fy[i]
            t = (x - sx[i - 1]) / (sx[i] - sx[i - 1])
            return fy[i - 1] + t * (fy[i] - fy[i - 1])
    return fy[-1]


def platt_fit(xs, ys, iters=2000, lr=0.5):
    """1D logistic y≈sigmoid(a*x+b) via gradient descent (ys in [0,1])."""
    import math
    a, b = 0.0, 0.0
    n = len(xs)
    for _ in range(iters):
        ga = gb = 0.0
        for x, y in zip(xs, ys):
            z = a * x + b
            p = 1 / (1 + math.exp(-max(-30, min(30, z))))
            ga += (p - y) * x
            gb += (p - y)
        a -= lr * ga / n
        b -= lr * gb / n
    return a, b


def platt_predict(ab, x):
    import math
    a, b = ab
    return 1 / (1 + math.exp(-max(-30, min(30, a * x + b))))


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else sorted(HERE.glob("results-*.md"))[-1]
    recs = [r for r in calibrate.parse(path.read_text()) if r["grade"] in ("0", "0.0", "0.5", "1", "1.0") and r["conf"] is not None]
    pairs = [(r["conf"], float(r["grade"])) for r in recs]
    print(f"=== E1+E2 on {path.name} — n={len(pairs)} labeled (conf,grade) pairs ===\n")

    # ---------- E1: reliability baseline ----------
    ece, bins = adaptive_ece(pairs)
    over = sum(c - g for c, g in pairs) / len(pairs)
    cw = sum(1 for c, g in pairs if c >= 0.7 and g == 0)
    print("E1 — RELIABILITY BASELINE (raw, self-reported confidence)")
    print("  conf-bin (equal-count)   avg-conf  accuracy   gap   n")
    for mc, ma, nb in bins:
        print(f"    {mc:.2f}                    {mc:.2f}     {ma:.2f}    {mc-ma:+.2f}   {nb}")
    print(f"  adaptive-bin ECE = {ece:.3f}   overconfidence = {over:+.3f}   confident-wrong = {cw}/{len(pairs)}")
    # per-tier
    print("  per-tier ECE:")
    for lvl in ["L1", "L2", "L3", "L4", "L5"]:
        tp = [(r["conf"], float(r["grade"])) for r in recs if r["level"] == lvl]
        if tp:
            te, _ = adaptive_ece(tp, k=3)
            acc = sum(g for _, g in tp) / len(tp)
            print(f"    {lvl}: ECE {te:.3f}  acc {acc:.0%}  (n={len(tp)})")
    # clean (uncontaminated) view: facts only
    facts = [(r["conf"], float(r["grade"])) for r in recs if r["level"] in ("L1", "L2")]
    fe, _ = adaptive_ece(facts)
    print(f"  CLEAN (L1+L2, non-circular) ECE = {fe:.3f}  (n={len(facts)})")
    # risk-coverage
    print("  risk-coverage (answer only the most-confident X%):")
    ps = sorted(pairs, key=lambda t: -t[0])
    for cov in (1.0, 0.8, 0.6, 0.4, 0.2):
        k = max(1, int(len(ps) * cov))
        acc = sum(g for _, g in ps[:k]) / k
        print(f"    coverage {cov*100:3.0f}%  →  accuracy {acc:.0%}")

    # ---------- E2: post-hoc calibration map (LOOCV) ----------
    print("\nE2 — POST-HOC CALIBRATION MAP (leave-one-out)")
    iso_cal, platt_cal = [], []
    for i in range(len(pairs)):
        train = pairs[:i] + pairs[i + 1:]
        xs = [c for c, _ in train]; ys = [g for _, g in train]
        sx, fy = isotonic_fit(xs, ys)
        iso_cal.append((iso_predict(sx, fy, pairs[i][0]), pairs[i][1]))
        ab = platt_fit(xs, ys)
        platt_cal.append((platt_predict(ab, pairs[i][0]), pairs[i][1]))
    iso_ece, _ = adaptive_ece(iso_cal)
    platt_ece, _ = adaptive_ece(platt_cal)
    iso_over = sum(c - g for c, g in iso_cal) / len(iso_cal)
    print(f"  raw ECE            = {ece:.3f}")
    print(f"  isotonic (LOOCV)   = {iso_ece:.3f}   overconf {iso_over:+.3f}")
    print(f"  Platt    (LOOCV)   = {platt_ece:.3f}")
    print(f"\n  verdict: {'✅ map helps — raw scores are rank-informative' if min(iso_ece,platt_ece) < ece-0.03 else '⚠️ map barely helps — confidence is closer to noise (need E3/E5)'}")
    print("  caveat: n is small; LOOCV is the honest estimate but a deployment map needs E10 (more labels).")


if __name__ == "__main__":
    main()
