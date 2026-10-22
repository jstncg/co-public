#!/usr/bin/env python3
"""The proactive tick — event-driven outreach, work-with-receipts only, all day, heavily gated.

Wired: RETIRED 2026-09-06. Removed from cron at the runtime cutover — initiative now belongs to
packages/runtime (inquiries, scouts, attention arbitration). Kept for its composition logic and for
rollback; nothing schedules it. Its record is why: 13 unprompted sends in 45 days scoring -2.65 on
landed.py's own objective, one lane speaking, zero acts.

Cron every 15 min through the waking day. Per tenant, IN ORDER:
  skip flag ("not tonight") → quiet hours (their tz, 09:00-21:30) → the SHARED callback budget (one
  proactive resurface/day across every surface — an anchor firing today makes tonight's daily text yield
  automatically, because daily_text checks the same budget) → due anchors (the 2:45 "how'd the pitch go")
  → deferred-watch recovery → watch results → the READ-RECEIPT gate (last outbound sitting unread →
  organic waits its turn) → the RETURN (recall of the member's own material, dated, never generated).

VOICE RUNGS RETIRED 8/22 (founder-usage-analysis): muse, second opinion, reflection, absence — the
unprompted-insight register — for every tenant, founder included. 147 of co's 150 messages answered
no question; the founder's weekly sends collapsed 68→2. Unrequested prose taxes depositing.

The composer ABSTAINS when it has nothing worth a text; a due anchor with no good line just gets marked
so it never fires late and stale. Every send lands in the conversation transcript (record_outbound — the
engine must own its own words).

  python3 proactive_tick.py            # stage-only: prints what WOULD send
  python3 proactive_tick.py --send     # real sends (allowlist-gated)
"""
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

QUIET_START, QUIET_END = dt.time(21, 30), dt.time(9, 0)   # their local time

# Read receipts (7/15): if the last thing we sent is sitting unread, organic proactivity waits its turn.
# Missing data (plan/handset doesn't report reads) → gate stays open. Requested reminders are exempt.
# ".co", with the dot — the writer (router's _note_outbound_status) writes ~/.co/; this
# read ~/co/ since 7/15, the file never existed there, and the read-receipt gate never
# once ran (8/9 audit: the definitive silent no-op).
OUTBOUND_STATUS_PATH = Path.home() / ".co" / "outbound_status.json"
UNREAD_HOLD_HOURS = 20


def _outbound_read_ok(phone: str | None) -> bool:
    if not phone:
        return True
    try:
        st = json.loads(OUTBOUND_STATUS_PATH.read_text()) if OUTBOUND_STATUS_PATH.exists() else {}
    except (json.JSONDecodeError, OSError):
        return True
    rec = st.get(re.sub(r"[^\d+]", "", phone))
    if not rec:
        return True
    age_h = (dt.datetime.now().timestamp() - rec.get("ts", 0)) / 3600
    return "READ" in rec.get("status", "") or age_h > UNREAD_HOLD_HOURS

COMPOSE_SYS = """You are Co, texting FIRST, unprompted, because a specific thing just happened in this
person's life (below). Write the ONE short text a sharp friend who remembered would send. Their words for
the thing, not a paraphrase. Casual, lowercase-leaning, 5-15 words. A question only if it's the natural
shape ("how'd the pitch go"). NEVER 'just checking in', never 'hope it went well!', never assistant-speak,
no emoji unless it genuinely fits.
If there is no natural text here — the thing is too vague, or anything you'd write feels like a reach —
return exactly ABSTAIN. Abstaining is success, not failure.
Return ONLY the text (or ABSTAIN)."""


def _compose(kind: str, payload: str) -> str | None:
    import disposition
    import llm
    out = llm.complete_with_fallbacks(llm.phrase_specs(), COMPOSE_SYS,
                                      f"WHAT HAPPENED ({kind}):\n{payload}", max_tokens=60)
    t = (out or "").strip().strip('"')
    if not t or "ABSTAIN" in t.upper() or len(t) > 200:
        return None
    t = re.sub(r"\s*—\s*", ". ", t)                    # de-tic: em-dash → period (the humanizer law)
    return None if disposition.violations(t, max_chars=200) else t


def tick(db: Path, send: bool) -> str:
    import anchors
    import co_react
    import daily_text
    import tz_dynamic

    claims_db = str(db)
    tenant = daily_text._tenant_of_db(db)
    mem = f"{claims_db}.co_memory.db"

    # the gates, cheapest first
    if daily_text._skipped_today(db):                  # the shared <db>.skip "not tonight" flag
        return f"[hold] {tenant:<14} — skip flag set"
    now = tz_dynamic.now_in(claims_db)
    if now.time() >= QUIET_START or now.time() < QUIET_END:
        return f"[hold] {tenant:<14} — quiet hours ({now.strftime('%H:%M')} local)"

    # THE REPLY-DEBT GATE (8/4, from the Sony pile-on): the last word in the conversation is
    # THEIRS and recent → co owes a reply, and NOTHING proactive may jump the queue — not a
    # watch fire, not a reminder. A kept promise delivered while ignoring their open message
    # reads as exactly what it is: not listening. Everything holds one beat; the debt clears
    # (chosen silence also clears it — [SILENCE] records an assistant turn), then promises
    # fire on the next tick, minutes late and in the right order.
    try:
        import json as _json
        # THE CONVERSATION lives in the router's transcript (both roles). claims.db.transcript.json
        # is the journal's CAPTURE FEED — user turns only, by design — so reading it here meant the
        # last turn was ALWAYS theirs and the gate over-blocked every proactive send for two hours
        # after any message (8/4: shipped against the wrong file, caught by the gift-rate scorer).
        tp = os.path.expanduser(f"~/.co_{tenant}_sendblue_transcript.json")
        turns = _json.load(open(tp)) if os.path.exists(tp) else []
        last = turns[-1] if turns else {}
        if last.get("role") == "user" and last.get("ts"):
            import datetime as _dt
            age = (_dt.datetime.now() - _dt.datetime.fromisoformat(last["ts"])).total_seconds()
            if 0 <= age < 2 * 3600:
                return f"[hold] {tenant:<14} — reply debt ({int(age // 60)}m): their message is unanswered"
    except Exception:
        pass

    budget_spent = co_react.callback_used_today(mem)

    # 1) due anchors — the whole point. An explicitly REQUESTED reminder is a kept promise, not an
    # interruption: it fires even when the daily budget is spent (it still marks it, so organic
    # proactivity yields afterward). Everything organic respects the budget.
    for a in anchors.due(claims_db, now):
        if budget_spent and not a.get("requested"):
            continue
        if a.get("research_id"):
            # a commissioned report: the findings were stored at commission; compose from them
            import research_engine
            text = research_engine.deliver(tenant, a["research_id"])
        else:
            kind = "requested reminder (they explicitly asked to be pinged)" if a.get("requested") else a["kind"]
            text = _compose(kind, f"{a['what']} (was {a['when'][:16]}; they said: \"{a['quote']}\")")
        if not text and a.get("requested"):
            # A REQUESTED reminder is a promise, and a promise may not be voided by an empty
            # model return. Marking it fired with no send wrote "kept" into the ledger while the
            # member got nothing — and `fired` is terminal, so it could never retry or repair.
            # (8/6: this is exactly how a tester's reminder disappeared.)
            #
            # The promise needs no model: they already said what they wanted. Render it
            # deterministically (goal-v4 §6.4 — exact promises use a versioned renderer so their
            # meaning cannot be paraphrased or delayed by an LLM) and send that.
            text = (a.get("what") or "").strip() or (a.get("quote") or "").strip()
            if text:
                print(f"  (composer abstained on a REQUESTED anchor — sending it plainly: {text[:70]!r})",
                      file=sys.stderr)
            else:
                print("  (requested anchor has no renderable text — leaving it DUE rather than "
                      "marking a promise kept)", file=sys.stderr)
                continue        # deliberately not mark_fired: unsent is not delivered
        if not text:
            anchors.mark_fired(claims_db, a, note="composer abstained")   # organic: silence is fine
            continue
        if not send:
            return f"[stage] {tenant:<14} anchor:{a['what'][:24]!r} → {text!r}"
        phone = daily_text.tenant_phone(tenant, daily_text._cfg(db))
        if not (phone and daily_text._allowlisted(phone)):
            return f"[hold] {tenant:<14} — anchor due but no allowlisted phone"
        if daily_text._sendblue(phone, text):
            anchors.mark_fired(claims_db, a)
            daily_text.record_outbound(tenant, text)   # the engine must own its own words
            co_react.mark_callback("anchor", mem)      # spends THE budget → tonight's daily text yields
            if a.get("research_id"):
                try:
                    import work
                    work.log(tenant, "researched", f"delivered the report: {a['what'].replace('research report: ', '')[:80]}",
                             why="commissioned, searched same-day, composed from stored findings")
                except Exception:
                    pass
            return f"[SENT] {tenant:<14} anchor:{a['what'][:24]!r} → {text!r}"
        return f"[fail] {tenant:<14} — sendblue failed (anchor stays due)"

    # 1a-bis) DEFERRED WATCHES, crash recovery — a long video co promised to watch whose watcher
    # died mid-run (process restart). Asked-class: they sent the video, the read is a kept promise,
    # so it bypasses the budget (quiet hours already held above). The live path is a router thread;
    # this rung only exists so a restart can't eat a promise.
    try:
        import deferred_watch
        phone = daily_text.tenant_phone(tenant, daily_text._cfg(db))
        # Not allowlist-gated (8/10): recovery of a made promise is a reply co owes — holding it
        # turns "back in a bit" into permanent silence.
        if phone:
            ran = deferred_watch.sweep(tenant,
                                       send=lambda m: daily_text._sendblue(phone, m),
                                       record=lambda m: daily_text.record_outbound(tenant, m))
            if ran:
                return f"[SENT] {tenant:<14} deferred watch recovered ({ran})"
    except Exception as e:
        print(f"  (deferred-watch sweep error: {e})", file=sys.stderr)

    # 1b) WATCHES — the mandate verb (docs/watch-architecture.md). A watch is a REQUESTED promise
    # about the world, anchor-class: the user explicitly asked to be told, so a fire is a kept
    # promise, not an interruption — it sends even when the organic budget is spent (same law as
    # requested reminders above), but still marks the budget so organic rungs yield. One fire per
    # tick; checks are cheap (date watches are free; url/search only past their cadence).
    try:
        import watch_engine
        for wid in watch_engine.due(tenant):
            # class split (the recommendation law): watches the user ASKED for are kept promises and
            # fire past the budget; watches the SCOUT invented are offers — they wait for budget like
            # every other organic send, and we skip BEFORE check() so the change isn't consumed
            # silently while it waits.
            # exposure fires are ALERTS (world colliding with a live plan) — like asked watches they
            # bypass the organic budget; only scout offers wait in line.
            if budget_spent and watch_engine.origin_of(tenant, wid) == "scout":
                continue
            line = watch_engine.check(tenant, wid)
            if not line:
                continue
            if not send:
                return f"[stage] {tenant:<14} watch:{wid} → {line[:70]!r}"
            phone = daily_text.tenant_phone(tenant, daily_text._cfg(db))
            if not (phone and daily_text._allowlisted(phone)):
                return f"[hold] {tenant:<14} — watch fired but no allowlisted phone"
            if daily_text._sendblue(phone, line):
                daily_text.record_outbound(tenant, line)
                co_react.mark_callback("watch", mem)
                try:
                    import work
                    work.log(tenant, "checked", f"a watch fired: {line[:90]}",
                             why="standing watch, checked on the tick, fired on material change")
                except Exception:
                    pass
                return f"[SENT] {tenant:<14} watch:{wid} → {line[:70]!r}"
    except Exception as e:
        print(f"  (watch rung error: {e})", file=sys.stderr)

    # THE LIST's dispatch rung (8/22): silent by construction — routes open items to organs,
    # flips finished research to done-by-co. No send, so it runs regardless of budget/receipts.
    try:
        import list_dispatch
        moved = list_dispatch.run_tenant(tenant)
        if moved:
            print(f"  (list: {', '.join(moved)})")
    except Exception as e:
        print(f"  (list dispatch error: {e})", file=sys.stderr)

    # THE MEETING READ (8/25): the first moment-attached lane. Everything below composes into a
    # message that attaches to nothing in their day; this one fires 90 minutes before a meeting
    # that is already on their calendar, because a read about someone is worth something then and
    # nothing at 9am. It is NOT requested, so it respects the organic budget — but it sits above
    # the organic lanes, because a read before a real meeting outranks any find. Its organ holds
    # the rest: roster gate, lead window, one a day, motivation receipts, burn on delivery.
    try:
        import moment
        if not budget_spent and moment.rostered(tenant):
            reads = moment.fresh(tenant)
            if reads:
                r = reads[0]
                if not send:
                    return f"[stage] {tenant:<14} read:{r['name']}"
                phone = daily_text.tenant_phone(tenant, daily_text._cfg(db))
                if not (phone and daily_text._allowlisted(phone)):
                    return f"[hold] {tenant:<14} — read due but no allowlisted phone"
                if daily_text._sendblue(phone, r["text"]):
                    moment.commit(tenant)
                    daily_text.record_outbound(tenant, r["text"])
                    co_react.mark_callback("read", mem)
                    return f"[SENT] {tenant:<14} read:{r['name']}"
    except Exception as e:
        print(f"  (meeting read error: {e})", file=sys.stderr)

    # THE DAILY FINDS (8/23, founder standing request): the morning world-sweep against their
    # live wants. A standing ask is a kept promise — budget-exempt like anchors; its own organ
    # holds every other law (roster gate, morning window, once daily, liveness, burned URLs).
    try:
        import daily_finds
        df = daily_finds.run_tenant(tenant, send=send)
        if df.startswith("[SENT]"):
            co_react.mark_callback("daily_finds", mem)
            return f"{df[:6]} {tenant:<14} daily finds delivered"
        if not df.startswith(("[skip]", "[hold]")):
            print(f"  (finds: {df})")
    except Exception as e:
        print(f"  (daily finds error: {e})", file=sys.stderr)

    # THE CHECK-BACK (8/24): closing a loop outranks opening one, so outcomes ask before the
    # propose lane proposes. One a day, evening only, never re-asked — and the answer is the
    # ground truth every other organ compounds on.
    try:
        import outcomes
        oc = outcomes.run_tenant(tenant, send=send and not budget_spent)
        if oc.startswith("[SENT]"):
            co_react.mark_callback("checkback", mem)
            return f"[SENT] {tenant:<14} check-back → {oc[:80]}"
        if not oc.startswith(("[skip]", "[hold]", "[idle]")):
            print(f"  (outcome: {oc})")
    except Exception as e:
        print(f"  (outcome loop error: {e})", file=sys.stderr)

    # CONVERSION (8/25) takes the evening slot ONLY when outcomes had nothing to close:
    # intake becomes growth in the same one-question-a-day budget, never on top of it.
    try:
        import conversion
        q = conversion.question(tenant)
        if q and send and not budget_spent:
            phone_c = daily_text.tenant_phone(tenant, daily_text._cfg(db))
            if phone_c and daily_text._allowlisted(phone_c) and daily_text._sendblue(phone_c, q["text"]):
                daily_text.record_outbound(tenant, q["text"])
                conversion.mark_used(tenant, q["key"])   # spent only after it landed
                co_react.mark_callback("conversion", mem)
                return f"[SENT] {tenant:<14} {q['kind']} → {q['text'][:70]!r}"
        elif q:
            print(f"  (conversion: {q['kind']} → {q['text'][:70]!r})")
    except Exception as e:
        print(f"  (conversion error: {e})", file=sys.stderr)

    # THE PROPOSE LANE (8/24, the wedge's core mechanic): sweeps yesterday's verdicts every
    # tick; composes at most one judged proposal in the evening window. Sends via the gated
    # proactive door; a send spends the shared callback budget like any interruption.
    try:
        import propose_lane
        pl = propose_lane.run_tenant(tenant, send=send and not budget_spent)
        if pl.startswith("[SENT]"):
            co_react.mark_callback("propose", mem)
            return f"[SENT] {tenant:<14} proposal → {pl[:80]}"
        if not pl.startswith(("[skip]", "[hold]")):
            print(f"  (propose: {pl})")
    except Exception as e:
        print(f"  (propose lane error: {e})", file=sys.stderr)

    # The nightly self-study (8/23-24), once a day per tenant: landed turns become exemplars,
    # the thread's stats accrue toward trigger baselines, and the running bits stay current.
    try:
        _ex_flag = os.path.expanduser(f"~/.co/exemplars/.mined_{tenant}_{dt.date.today().isoformat()}")
        if not os.path.exists(_ex_flag):
            import assumptions
            import becoming
            import bits
            import entities
            import exemplars
            import trigger_baselines
            exemplars.mine(tenant)
            trigger_baselines.accrue(tenant)
            bits.mine(tenant)
            entities.mine(tenant)          # the join's half of the world
            becoming.build(tenant)         # the target self, refreshed weekly
            assumptions.mine(tenant)
            assumptions.hunt(tenant)
            os.makedirs(os.path.dirname(_ex_flag), exist_ok=True)
            open(_ex_flag, "w").close()
    except Exception as e:
        print(f"  (self-study error: {e})", file=sys.stderr)

    # Google eyes (8/24, founder-linked accounts only): the day cache refreshes every tick;
    # the inbox guard sweeps once a day. Both read-only; the guard's flags ride the brief.
    if tenant == os.environ.get("CO_FOUNDER_TENANT", "dennis"):
        try:
            import gcal
            if gcal.accounts_for(tenant):
                gcal.sync(tenant)
                _gd_flag = os.path.expanduser(f"~/.co/guard/.swept_{dt.date.today().isoformat()}")
                if not os.path.exists(_gd_flag):
                    import gmail_guard
                    gmail_guard.sweep(tenant)
                    os.makedirs(os.path.dirname(_gd_flag), exist_ok=True)
                    open(_gd_flag, "w").close()
        except Exception as e:
            print(f"  (google eyes error: {e})", file=sys.stderr)

    if budget_spent:
        return f"[hold] {tenant:<14} — proactive budget spent today"

    # MID-SENTENCE (8/28). Every interruption law before this guessed at the moment — quiet
    # hours, a daily budget, a read receipt from twenty hours ago. The typing webhook is the
    # actual state of the person on the other end, so co simply does not talk over them.
    try:
        import presence
        if presence.typing(tenant):
            return f"[hold] {tenant:<14} — they are mid-sentence"
    except Exception:
        pass
    phone = daily_text.tenant_phone(tenant, daily_text._cfg(db))
    if not _outbound_read_ok(phone):
        return f"[hold] {tenant:<14} — last outbound still unread (organic waits its turn)"

    # VOICE RUNGS RETIRED (8/22, founder-usage-analysis): muse, second opinion, reflection, and
    # absence — the unprompted-insight register — are gone for EVERY tenant, founder included.
    # 21 days of the founder's own thread: 147 of co's 150 messages answered no question, and his
    # weekly sends collapsed 68→2. Unrequested prose taxes depositing; taxed behavior stops.
    # What survives above is work with receipts (anchors, deferred-watch recovery, watches); what
    # survives below is the RETURN — recall of the member's own material, dated, never generated.

    # The register dial (modes.py, 8/4): delivery-only tenants get deliveries (anchors, watches,
    # research, wake, unasked — all ran above or on their own rails) but never the conversation-
    # shaped return below — it expects a reaction. For Lance's cohort that's exactly the
    # creditor-text he declined. Silence past this line is the product working.
    try:
        import modes as _modes
        if _modes.get(tenant) == "delivery":
            return f"[hold] {tenant:<14} — delivery-only: conversation rungs skipped"
    except Exception:
        pass

    # 2a) THE RETURN — unprompted recall of something HE sent, triggered by something else he sent.
    # Moved here on 7/27 from the reply path, where it was blocking every message ~18s to produce
    # something nobody asked for. Unprompted recall is an interruption, so it lives with the other
    # interruptions: same budget, same quiet hours, same read-receipt gate. It sits ABOVE reflection
    # because it is grounded in his own material with a date on it, rather than generated — the
    # cheapest possible thing to be right about, and the whole payback thesis.
    try:
        import find_engine
        import journal as _j
        _e = (_j._load(tenant).get("entries") or [])
        _last = (_e[-1].get("text") if _e else "") or ""
        if _last.strip():
            res = find_engine.recall(tenant, _last, mode="proactive")
            if res:
                body = (res.get("answer") or "").strip()
                if body:
                    if not send:
                        return f"[stage] {tenant:<14} return:{res.get('kind')} → {body[:70]!r}"
                    if phone and daily_text._allowlisted(phone) and daily_text._sendblue(phone, body):
                        daily_text.record_outbound(tenant, body)
                        co_react.mark_callback("return", mem)
                        return f"[SENT] {tenant:<14} return → {body[:70]!r}"
    except Exception as e:
        print(f"  (return rung error: {e})", file=sys.stderr)

    # (reflection and absence rungs retired 8/22 with the other voice rungs — see above)
    return f"[idle] {tenant:<14} — nothing due"


def main():
    send = "--send" in sys.argv
    import daily_text
    print(f"proactive tick {'SEND' if send else 'stage-only'} — {dt.datetime.now().isoformat(timespec='seconds')}")
    for db in daily_text.all_tenant_dbs():
        try:
            print(" " + tick(db, send))
        except Exception as e:
            print(f" [err]  {db.name}: {e}")


_LOCK_PATH = os.path.expanduser("~/.co/proactive_tick.lock")

def _acquire_lock():
    """One tick at a time (system-review finding #3): watch checks can outlast the 15-min cron
    interval, and two concurrent ticks both read budget_spent=false -> double sends. flock is
    advisory, process-scoped, and freed automatically on exit/crash."""
    import fcntl
    fh = open(_LOCK_PATH, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fh
    except OSError:
        return None

if __name__ == "__main__":
    _lock = _acquire_lock()
    if _lock is None:
        print("tick already running — skipped (flock)")
        raise SystemExit(0)
    main()
