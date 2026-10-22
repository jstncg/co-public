#!/usr/bin/env python3
"""One tiny completion helper with full provider swappability (7/2) — the python twin of the engine's
role-based model config. Spec format: "provider/model-id".

  anthropic/claude-sonnet-4-6     CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY
  openai/gpt-5.5                  OPENAI_API_KEY
  openrouter/<anything>           OPENROUTER_API_KEY (OpenAI-compatible — the universal escape hatch)
  google/gemini-2.5-flash         GEMINI_API_KEY / GOOGLE_API_KEY

Role envs (parsed by the callers): CO_PHRASE_MODEL (co_react's line, daily/unasked composers),
CO_EYES_MODEL (link_read's media reads — google-only in practice), CO_MODEL_FALLBACKS (comma list).
A swap is only trusted after the eval gate: cd claims && CO_BRAIN_MODEL=<spec> python3 co_eval.py
"""
import json
import os
import re
import sys


def have_anthropic() -> bool:
    """True when an Anthropic credential exists.

    The two organs that PROMPT-CACHE — find_engine's gate and the ASK — stay on Anthropic whenever
    this is true, because the cached corpus block is most of the reason the gate is cheap enough to
    run on every inbound message, and no other provider here has an equivalent. When it is false
    those organs route through `complete_with_fallbacks` instead of dying, which is the whole point:
    a machine holding only a Gemini key can then run the entire chain (Justin, 2026-08-13 — no OAuth
    access, and a PR nobody can test is not a PR).

    Deliberately a credential check, not a try/except around the call. Catching the failure would
    also swallow a real outage and silently downgrade Dennis's live rail to a worse model without
    anyone noticing; the presence of a key is a fact, and facts are what a fallback should branch on."""
    return bool(os.getenv("CLAUDE_CODE_OAUTH_TOKEN") or os.getenv("ANTHROPIC_API_KEY"))


def json_specs() -> list:
    """The chain for STRUCTURED calls: classifiers, compilers, judges. Kept separate from
    `phrase_specs` because those write co's actual words and this output never reaches the member,
    so it can run on a cheaper or entirely different model without touching the voice."""
    primary = os.getenv("CO_JSON_MODEL") or "anthropic/claude-haiku-4-5"
    fallbacks = os.getenv("CO_MODEL_FALLBACKS", "anthropic/claude-haiku-4-5")
    out = []
    for spec in [primary] + fallbacks.split(","):
        spec = spec.strip()
        if spec and spec not in out:
            out.append(spec)
    return out


def ask_json(specs: list, system: str, user_content: str, max_tokens: int = 400):
    """`complete_with_fallbacks` plus the parse every caller was writing by hand: the first JSON
    object in the reply. Returns None when the chain produced nothing parseable.

    None is not {}. A caller must be able to tell "the model said nothing usable" from "the model
    considered it and the answer is empty" — collapsing those is the exact bug that kept recall dark
    in production for weeks (find_engine `_gate`, 7/27)."""
    txt = complete_with_fallbacks(specs, system, user_content, max_tokens)
    if not txt:
        return None
    m = re.search(r"\{.*\}", txt, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    # SALVAGE (8/25): a list answer cut off by max_tokens leaves unbalanced JSON, and the
    # whole reply was being thrown away — entity mining returned zero for exactly this reason,
    # silently. Trim to the last COMPLETE element and close the structure. Partial beats none
    # for list-shaped answers; anything still unparseable stays None (the honest empty).
    head = txt[txt.find("{"):] if "{" in txt else ""
    if not head:
        return None
    cut = max(head.rfind("},"), head.rfind("} ,"), head.rfind("}\n"))
    if cut > 0:
        for closing in ("}]}", "}]}}", "}}"):
            try:
                return json.loads(head[:cut + 1] + closing[1:])
            except json.JSONDecodeError:
                continue
    return None


def parse_spec(spec: str, default=("anthropic", "claude-sonnet-4-6")):
    spec = (spec or "").strip()
    if "/" in spec:
        p, m = spec.split("/", 1)
        if p and m:
            return p.strip(), m.strip()
    if spec:                                   # bare model id → assume anthropic (legacy)
        return default[0], spec
    return default


def phrase_specs() -> list:
    """The line-phrasing chain: CO_PHRASE_MODEL (or legacy CO_PHRASE_MODEL) + CO_MODEL_FALLBACKS."""
    primary = os.getenv("CO_PHRASE_MODEL") or os.getenv("CO_PHRASE_MODEL") or "anthropic/claude-sonnet-4-6"
    fallbacks = os.getenv("CO_MODEL_FALLBACKS", "anthropic/claude-haiku-4-5")
    out = []
    for spec in [primary] + fallbacks.split(","):
        spec = spec.strip()
        if spec and spec not in out:
            out.append(spec)
    return out


def complete(spec: str, system: str, user_content: str, max_tokens: int = 200, timeout: int = 60) -> str:
    """One completion. Returns "" on any failure (callers run their own fallback chain)."""
    provider, model = parse_spec(spec)
    try:
        if provider == "anthropic":
            from anthropic import Anthropic
            tok = os.getenv("CLAUDE_CODE_OAUTH_TOKEN", "")
            client = (Anthropic(auth_token=tok, default_headers={"anthropic-beta": "oauth-2025-04-20"})
                      if tok else Anthropic())
            r = client.messages.create(model=model, system=system, max_tokens=max_tokens,
                                       messages=[{"role": "user", "content": user_content}])
            return "".join(b.text for b in r.content if b.type == "text").strip()
        if provider in ("openai", "openrouter"):
            import requests
            base = "https://openrouter.ai/api/v1" if provider == "openrouter" else "https://api.openai.com/v1"
            key = os.getenv("OPENROUTER_API_KEY" if provider == "openrouter" else "OPENAI_API_KEY", "")
            if not key:
                return ""
            r = requests.post(f"{base}/chat/completions", timeout=timeout,
                              headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                              json={"model": model, "max_tokens": max_tokens,
                                    "messages": [{"role": "system", "content": system},
                                                 {"role": "user", "content": user_content}]})
            r.raise_for_status()
            return (r.json()["choices"][0]["message"]["content"] or "").strip()
        if provider == "google":
            import requests
            key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY", "")
            if not key:
                return ""
            r = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
                timeout=timeout, headers={"Content-Type": "application/json"},
                json={"system_instruction": {"parts": [{"text": system}]},
                      "contents": [{"parts": [{"text": user_content}]}],
                      # thinking OFF: gemini-2.5-flash thinks by default and the thoughts consume the
                      # output budget — a 20-token utility call returns EMPTY otherwise (bit us 7/2)
                      "generationConfig": {"maxOutputTokens": max_tokens,
                                           "thinkingConfig": {"thinkingBudget": 0}}})
            r.raise_for_status()
            parts = ((r.json().get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
            return "".join(p.get("text", "") for p in parts).strip()
    except Exception as e:
        if "rate_limit" not in str(e):
            print(f"  (llm {spec}: {str(e)[:120]})", file=sys.stderr)
    return ""


def complete_with_fallbacks(specs: list, system: str, user_content: str, max_tokens: int = 200) -> str:
    for spec in specs:
        out = complete(spec, system, user_content, max_tokens)
        if out:
            return out
    return ""


if __name__ == "__main__":
    spec = sys.argv[1] if len(sys.argv) > 1 else "anthropic/claude-haiku-4-5"
    print(complete(spec, "reply with exactly: ok", "ping", 10) or "(failed)")
