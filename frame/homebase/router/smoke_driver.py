#!/usr/bin/env python3
"""Local smoke of the WHOLE co loop — no Sendblue, no webhook, no real messages.

Monkeypatches sendblue_send to print, then pushes simulated inbound payloads through the exact same
_process path a real webhook hits. A throwaway tenant id keeps founder data untouched.

  set -a; source ../../.env; set +a; python3 smoke_driver.py            # canned end-to-end script
  ... smoke_driver.py "+15559990001" "a custom send"                   # one custom send
Engine (:8090) must be up for the conversational/onboarding paths (smoke.sh starts it).
"""
import sys
import time

import sendblue_router as router

SENT = []


def fake_send(to_number: str, content: str) -> bool:
    SENT.append((to_number, content))
    print(f"   Co → {content}")
    return True


router.sendblue_send = fake_send


def inbound(sender: str, text: str, media: list | None = None):
    print(f"\nyou › {text}" + (f"   [+{len(media or [])} attachment]" if media else ""))
    t0 = time.time()
    n_before = len(SENT)
    router._process(sender, text, media or [], t0)
    if len(SENT) == n_before:
        print("   Co → (silence — restraint)")
    print(f"   ({int((time.time() - t0) * 1000)}ms)")


def main():
    if len(sys.argv) >= 3:
        inbound(sys.argv[1], " ".join(sys.argv[2:]))
        return
    handle = "+15559990077"          # throwaway tenant (claims_p15559990077.db)
    print("═" * 70)
    print("SMOKE — brand-new tenant onboarding (guessing game)")
    print("═" * 70)
    inbound(handle, "hey")
    inbound(handle, "ha ok. i'm two years out of school, working in consulting but it's not the thing")
    inbound(handle, "honestly i keep thinking about making short films. 40 ideas in my notes app, zero filmed")
    print("\n" + "═" * 70)
    print("SMOKE — known tenant: content send (tweet), pure thought, question")
    print("═" * 70)
    inbound(handle, "lol https://x.com/jack/status/20")
    inbound(handle, "maybe i should learn colorgrading properly before filming anything")
    inbound(handle, "not tonight")
    print("\n" + "═" * 70)
    print(f"done. {len(SENT)} replies sent (all printed, none real).")


if __name__ == "__main__":
    main()
