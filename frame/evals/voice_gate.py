#!/usr/bin/env python3
"""The voice-model disposition gate — a swapped model ships behind co ONLY through this.

brain.ts law (7/2): providers diverge exactly where the soul lives; agnostic at the
interface, verified at the disposition. This spawns a THROWAWAY engine on :8091 with
CO_VOICE_MODEL set to the candidate, runs voice-channel disposition probes + a
latency measure, and prints a verdict. The live engine is never touched.

    python3 voice_gate.py openrouter/deepseek/deepseek-v4-flash-0731
    python3 voice_gate.py            # harness self-test on the current default model

PASS bar: all probes green AND median ttfb under 1.0s. On PASS, flip is:
    add CO_VOICE_MODEL=<spec> to Secretary-Production/.env, restart the engine.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.request

ROOT = "/Users/main/Projects/Secretary/Secretary-Production"
PI = f"{ROOT}/projects/co/frame/brain"
PORT = 8091
NODE = "/Users/main/.nvm/versions/node/v24.13.0/bin/node"


def _env() -> dict:
    env = dict(os.environ)
    for line in open(f"{ROOT}/.env"):
        m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
        if m:
            env[m.group(1)] = m.group(2)
    env["WITNESS_PORT"] = str(PORT)
    return env


def _turn(msgs: list, stream: bool = False, engine_token: str = "") -> tuple:
    body = {"model": "co", "user": "evalprobe", "channel": "voice", "stream": stream,
            "messages": msgs}
    headers = {"Content-Type": "application/json"}
    if engine_token:
        headers["Authorization"] = f"Bearer {engine_token}"
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/chat/completions",
                                 json.dumps(body).encode(), headers)
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=90) as r:
        if stream:
            first = None
            for raw in r:
                if raw.strip().startswith(b"data:") and b"content" in raw:
                    first = first or (time.time() - t0)
            return "", first or -1
        out = json.load(r)["choices"][0]["message"]["content"]
        return out, time.time() - t0


def run(spec: str | None) -> int:
    env = _env()
    engine_token = env.get("CO_ENGINE_TOKEN", "").strip()
    if spec:
        env["CO_VOICE_MODEL"] = spec
        if spec.startswith("openrouter/") and not env.get("OPENROUTER_API_KEY"):
            print("FAIL: OPENROUTER_API_KEY missing from Secretary-Production/.env — create one "
                  "at openrouter.ai and add it, then rerun.")
            return 2
    proc = subprocess.Popen([NODE, "--experimental-strip-types", "server.ts"],
                            cwd=PI, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(40):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/", timeout=1)
                break
            except Exception:
                time.sleep(0.5)
        ok = True

        out, _ = _turn([{"role": "user", "content": "who are you? one line."}], engine_token=engine_token)
        good = not re.search(r"AI (language )?model|assistant|how can i help", out, re.I) and len(out) < 400
        print(f"{'✓' if good else '✗'} identity holds the persona — {out[:90]!r}")
        ok &= good

        out, _ = _turn([{"role": "user", "content": "should i text her back tonight or let it sit? make the call."}], engine_token=engine_token)
        good = bool(re.match(r"^\s*(let it sit|text|don'?t|yes|no|nah|yep|wait|sit|tonight)", out, re.I))
        print(f"{'✓' if good else '✗'} asked-for-a-call opens with the position — {out[:80]!r}")
        ok &= good

        out, _ = _turn([{"role": "user", "content": "just saw the wildest pitch deck, guy wants to do subscription saunas"}], engine_token=engine_token)
        good = len(out) < 500 and "—" not in out and not re.search(r"^[-•*]", out, re.M)
        print(f"{'✓' if good else '✗'} share gets a short spoken-register reply, no lists/em-dash — {len(out)} chars")
        ok &= good

        ts = []
        for _ in range(3):
            _, t = _turn([{"role": "user", "content": "quick one: coffee before a call, yes or no"}], stream=True, engine_token=engine_token)
            ts.append(t)
        ts.sort()
        med = ts[1]
        print(f"{'✓' if 0 < med < 1.0 else '✗'} median ttfb {med:.2f}s (bar: <1.0s) — runs: {[round(x,2) for x in ts]}")
        ok &= 0 < med < 1.0

        print("\nVERDICT:", "PASS — flip CO_VOICE_MODEL and restart the engine" if ok
              else "FAIL — the candidate does not ship (brain.ts disposition law)")
        return 0 if ok else 1
    finally:
        proc.terminate()


if __name__ == "__main__":
    sys.exit(run(sys.argv[1] if len(sys.argv) > 1 else None))
