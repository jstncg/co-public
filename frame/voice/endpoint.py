#!/usr/bin/env python3
"""The witness as an OpenAI-compatible endpoint — the engine as a service (the connective tissue).

This is what makes the voice worker (and the app, and any client) use OUR brain instead of a generic model.
It speaks /v1/chat/completions, so LiveKit's openai.LLM (or anything OpenAI-compatible) just points at it.
Per LIVEKIT_ARCH: the carried-core is RESIDENT and recall runs SERVER-SIDE in the inference pass (low TTFT —
no tool round-trip), so the brain "knows you" without blowing the voice latency budget.

  doppler run -- /…/python3 endpoint.py        # serves on :8088  → set WITNESS_LLM_URL=http://localhost:8088/v1
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "claims"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bridge"))
import claimstore
import donna_warm                       # the full agentic witness (tools: web_search, email, calendar, recall, remember, actions)
from donna_warm import make_client

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse
import uvicorn

PERSONA = (
    "You are Donna — the user's thought partner and closest friend, who knows them deeply and is anchored "
    "OUTSIDE their frame (the only place the truth about them is visible). This is their journal aloud / a "
    "call. Talk like a person: warm, dry, short, real opinions, push back. You KNOW them (use it — 'you do "
    "that thing where…') and you WON'T flatter them. When they avoid something, name it. Never 'my records "
    "show'; never agree just to be nice. Be right about them, and care.")

app = FastAPI()
_CORE = {}   # tenant → {"text","at"} — NEVER share a core across tenants (the interior is the data)


def tenant_of(body: dict, request) -> str:
    """Tenant identity: OpenAI 'user' field, or X-Donna-Tenant header, else the default tenant.
    Everything downstream (core, recall, brain path) keys off this — user #2 must never be served
    user #1's interior."""
    t = (body.get("user") or request.headers.get("x-donna-tenant") or claimstore.DEFAULT_TENANT)
    return str(t).strip().lower() or claimstore.DEFAULT_TENANT


def carried_core(tenant: str) -> str:
    """Resident deep model — top-salience beliefs from THIS tenant's store, refreshed every few minutes."""
    c = _CORE.setdefault(tenant, {"text": "", "at": 0.0})
    if time.time() - c["at"] < 300 and c["text"]:
        return c["text"]
    try:
        rows = claimstore.connect(tenant).execute(
            "SELECT statement, level FROM claims WHERE COALESCE(status,'active')!='retired' "
            "AND COALESCE(graded,'')!='demote' ORDER BY COALESCE(salience,0.4) DESC LIMIT 22").fetchall()
        c["text"] = "\n".join(f"- {s}{' (tentative)' if lv == 'frame' else ''}" for s, lv in rows)
        c["at"] = time.time()
    except Exception:
        pass
    return c["text"]


def _last_user(messages):
    for m in reversed(messages):
        if m.get("role") == "user":
            c = m.get("content")
            return c if isinstance(c, str) else " ".join(b.get("text", "") for b in c if isinstance(b, dict))
    return ""


def system_prompt(messages, tenant: str) -> str:
    core = carried_core(tenant)
    recall = ""
    try:
        recall = claimstore.recall_semantic(claimstore.connect(tenant), _last_user(messages), limit=8)
    except Exception:
        pass
    if not core:   # cold start — a new tenant's witness is honest about being early, never borrowed
        return (f"{PERSONA}\n\nYou are EARLY with this person — you don't deeply know them yet. Be honest "
                "about that; never pretend to knowledge you don't have. Your job right now is to listen "
                "well, ask the one sharp question, and remember. The knowing comes from these conversations.")
    return (f"{PERSONA}\n\nCORE SELF (who they are — carried, always true):\n{core}"
            + (f"\n\n[relevant to what they just said]\n{recall}" if recall else ""))


def _to_anthropic(messages):
    return [{"role": ("assistant" if m.get("role") == "assistant" else "user"),
             "content": (m["content"] if isinstance(m["content"], str)
                         else " ".join(b.get("text", "") for b in m["content"] if isinstance(b, dict)))}
            for m in messages if m.get("role") in ("user", "assistant") and m.get("content")]


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": "witness", "object": "model", "owned_by": "frame"}]}


@app.post("/v1/chat/completions")
async def chat(request: Request):
    """Tenant-forked brain, OpenAI-compatible.

    DEFAULT tenant (the founder) → donna_warm's FULL agentic brain: tool loop (web_search/email/
    calendar/recall/remember/draft-actions) server-side, his vault + belief graph. Anyone else →
    the witness persona on THEIR OWN claim store: cold-start honest, no default-tenant vault, no
    email/calendar tools (those are wired to the founder's accounts). The fork is the privacy
    boundary — the agentic path must never run for a non-default tenant."""
    body = await request.json()
    messages = body.get("messages", [])
    stream = body.get("stream", False)
    tenant = tenant_of(body, request)
    convo = [{"role": m["role"], "content": m["content"]} for m in messages
             if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)]
    user_text = convo.pop()["content"] if convo and convo[-1]["role"] == "user" else _last_user(messages)
    client = make_client()
    cid = f"chatcmpl-{int(time.time())}"

    if tenant == claimstore.DEFAULT_TENANT:
        reply = await donna_warm.respond(client, convo, user_text)   # the agentic loop (his tools + vault)
    else:
        sysp = system_prompt(messages, tenant)                       # their store only — witness path
        r = await client.messages.create(model="claude-sonnet-4-6", system=sysp, max_tokens=600,
                                         messages=convo + [{"role": "user", "content": user_text}])
        reply = "".join(b.text for b in r.content if b.type == "text").strip()

    if stream:
        async def gen():
            chunk = {"id": cid, "object": "chat.completion.chunk", "model": "witness",
                     "choices": [{"index": 0, "delta": {"content": reply}}]}
            yield f"data: {json.dumps(chunk)}\n\n"
            done = {"id": cid, "object": "chat.completion.chunk", "model": "witness",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
            yield f"data: {json.dumps(done)}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream")
    return JSONResponse({"id": cid, "object": "chat.completion", "model": "witness",
                         "choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}]})


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(sys.argv[1]) if len(sys.argv) > 1 else 8088, log_level="warning")
