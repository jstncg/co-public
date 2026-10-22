#!/usr/bin/env python3
"""The rec grounding gate — GROUNDED FACTS, GENERATED WHY (extracted from viewer/serve.py so the viewer's
recs AND the proactive EXPOSURE lane share ONE gate, and can never drift apart).

Iron law (a rec at a nonexistent source is a credibility disaster — never confabulate):
  · title / author / url come VERBATIM from the fetched result object (Exa). The LLM never writes or
    "cleans up" a fact — it only authors the one .why sentence (the connection to the user's thread).
  · no real, resolving URL + fetched title → no rec. Zero recs is a correct outcome (restraint > filler).
  · a rec is only returned after the fetched title is string-matched in the real fetched body (grounding),
    the url actually resolves (200-3xx), AND an LLM grounding-verifier confirms the page is the canonical
    page of ONE real readable work whose title matches the fetched page title.

EXA degrades gracefully: no key / out of credits / outage → _exa_search returns [] → source_one_rec
returns None → the caller stays silent. Never a hard failure, never a hallucinated source.

  python3 rec_grounding.py "how groups form beliefs"      # try to source one grounded rec for a theme
"""
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def _exa_key() -> str:
    return os.environ.get("EXA_API_KEY", "")


def _complete(system: str, user: str, max_tokens: int) -> str:
    """One completion for the gate (grounding-verifier + why-line), fallback chain ending at the already
    funded Gemini key — so the gate never silently collapses to zero on a primary-provider auth hiccup."""
    try:
        import llm
    except Exception:
        return ""
    specs = []
    for s in llm.phrase_specs() + ["google/gemini-2.5-flash"]:
        if s not in specs:
            specs.append(s)
    return llm.complete_with_fallbacks(specs, system, user, max_tokens)


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _title_in_body(title: str, *bodies) -> bool:
    """Grounding gate: the fetched title must actually appear in the fetched page body/metadata —
    string-matched in the real results, not merely asserted. Tolerant of long/truncated titles."""
    nt = _norm(title)
    if len(nt) < 4:
        return False
    body = _norm(" ".join(bodies))
    probe = nt if len(nt) <= 44 else nt[:44].rsplit(" ", 1)[0]
    return bool(probe) and probe in body


def _titles_agree(a: str, b: str) -> bool:
    """The verifier's work-title and the fetched page-title must be the same title (title↔url↔work
    coherence) — rejects a listicle headline whose 'real work' is buried in the body."""
    na, nb = _norm(a), _norm(b)
    if len(na) < 4 or len(nb) < 4:
        return False
    short, lng = (na, nb) if len(na) <= len(nb) else (nb, na)
    probe = short if len(short) <= 40 else short[:40].rsplit(" ", 1)[0]
    return bool(probe) and probe in lng


def _exa_search(query: str, num: int = 6) -> list:
    """Real fetched results — facts only, straight from Exa. Pulls a short slice of each page's body so the
    grounding gate can string-match the title against actual content. [] on any failure (out of credits/
    outage/no key) → the caller degrades to silence, never a fabricated source."""
    if not _exa_key():
        return []
    try:
        body = json.dumps({"query": query, "numResults": num, "type": "auto",
                           "contents": {"text": {"maxCharacters": 1200},
                                        "summary": {"query": "In one sentence, what is this book or essay about "
                                                    "and who is it for? Do not restate the title."}}}).encode()
        req = urllib.request.Request("https://api.exa.ai/search", data=body,
                                     headers={"x-api-key": _exa_key(), "Content-Type": "application/json"})
        j = json.loads(urllib.request.urlopen(req, timeout=20).read())
        out = []
        for r in (j.get("results") or []):
            title = (r.get("title") or "").strip()
            url = (r.get("url") or "").strip()
            if not title or not url.startswith("http"):
                continue
            out.append({"title": title, "url": url, "author": (r.get("author") or "").strip(),
                        "summary": (r.get("summary") or "").strip(), "text": (r.get("text") or "").strip(),
                        "source": "exa"})
        return out
    except Exception:
        return []


def _fetch_body(url: str) -> str:
    """Pull a slice of the real page so a Gemini-proposed candidate faces the SAME grounding gate as an Exa
    result (title-in-body). '' on any failure → the candidate can't be grounded → dropped."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; co-viewer)"})
        with urllib.request.urlopen(req, timeout=12) as r:
            raw = r.read(60000)
        txt = raw.decode("utf-8", "ignore")
        txt = re.sub(r"(?is)<script.*?</script>|<style.*?</style>", " ", txt)
        txt = re.sub(r"(?s)<[^>]+>", " ", txt)
        return re.sub(r"\s+", " ", txt)[:4000]
    except Exception:
        return ""


def _gemini_candidates(query: str) -> list:
    """Fallback source when Exa is dry (out of credits/outage): ask a search-grounded Gemini for ONE
    specific real work + its canonical URL, then treat it as an UNVERIFIED candidate that must still pass
    the full fetch→title-in-body→resolve→verify gate below. The gate — not the model — is what guarantees
    the source is real, so a hallucinated URL is caught (dead link, or body/title mismatch). [] if no key."""
    try:
        import link_read
        client = link_read._gemini_client()
        if not client:
            return []
        prompt = ("Name ONE specific, real, readable book or single authored essay that someone deep in this "
                  f"theme would not know but should: {query}. Return EXACTLY three lines:\nTITLE: <exact title>\n"
                  "AUTHOR: <author>\nURL: <a canonical page for the work — publisher, author site, or a major "
                  "bookseller/library>. Only a real URL you are confident resolves.")
        out = link_read._gemini_generate(client, [prompt])
        if not out:
            return []
        title = (re.search(r"TITLE:\s*(.+)", out) or [None, ""])[1].strip().strip('"')
        author = (re.search(r"AUTHOR:\s*(.+)", out) or [None, ""])[1].strip().strip('"')
        m = re.search(r"URL:\s*(https?://\S+)", out)
        if not title or not m:
            return []
        url = m.group(1).strip().rstrip(").,")
        body = _fetch_body(url)
        return [{"title": title, "url": url, "author": author, "summary": "", "text": body, "source": "gemini"}]
    except Exception:
        return []


def _url_resolves(url: str) -> bool:
    """Provenance must be real: the stored URL has to actually resolve. (No live URL → no rec.)"""
    if not url.startswith("http"):
        return False
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; co-viewer)"})
        with urllib.request.urlopen(req, timeout=12) as r:
            r.read(64)
            return 200 <= getattr(r, "status", 200) < 400
    except Exception:
        return False


def _verify_work(cand: dict):
    """LLM grounding-verifier (a gate, NOT a fact author). Is THIS PAGE the canonical page of ONE specific,
    real, readable work (a book or a single authored essay), vs a listicle / roundup / archive / a page
    that merely mentions works. Returns (True, work_title) or (False, ''). The work_title only GATES (must
    match the fetched page title); the rendered title still comes verbatim from the fetched result."""
    excerpt = ((cand.get("summary", "") + "\n" + cand.get("text", "")).strip())[:900]
    system = ("You verify a web search result before it is recommended to someone as a book or essay to read. "
              "Decide if THIS PAGE is the canonical page of ONE specific, real, published work — a single book, "
              "or one authored essay/article a person could actually go read. Answer NOT_A_WORK if it is a "
              "listicle, a 'best books about X' roundup, a curated collection, an archive/category/tag page, a "
              "store category, or a page that merely mentions or quotes other works. Reply EXACTLY two lines:\n"
              "VERDICT: WORK or NOT_A_WORK\nTITLE: <the work's exact title as it appears, or ->")
    user = f"PAGE TITLE: {cand.get('title','')}\nURL: {cand.get('url','')}\nEXCERPT:\n{excerpt}"
    out = _complete(system, user, max_tokens=60)
    if not out:
        return (False, "")
    v = re.search(r"VERDICT:\s*(WORK|NOT_A_WORK)", out, re.I)
    if not v or v.group(1).upper() != "WORK":
        return (False, "")
    m = re.search(r"TITLE:\s*(.+)", out)
    return (True, (m.group(1).strip().strip('"') if m else ""))


def rec_blurb(cand: dict) -> str:
    s = cand.get("summary", "") or cand.get("text", "")
    parts = re.split(r"(?i)\bsummary:\s*", s, maxsplit=1)
    s = parts[1] if len(parts) > 1 else s
    s = re.sub(r"(?im)^\s*(title|author|url|details|exact title)\s*:.*$", "", s)
    s = re.sub(r"https?://\S+", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r'(?i)^(the page|this page|the item|this)\b[^.]*?\b(is|describes|is a|being|titled)\b[^.]*?[:.]\s*', "", s)
    s = re.sub(r'(?i)^(this (book|essay|piece|article)|it) (is|describes)\s+', "", s)
    s = re.sub(r"^\s*[-•*]\s*", "", s)
    s = re.sub(r"\s+", " ", s).strip(" -–—:")
    if len(s) > 150:
        s = s[:150].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return s or "Extends the thread you're already pulling on."


def source_one_rec(label: str, dismissed=None, query: str | None = None):
    """Fetch → gate → ONE grounded rec (facts verbatim from the fetched result), or None.
    Gates, cheapest first: real http url · fetched title present in the page body (grounding) ·
    url actually resolves · LLM verifier confirms ONE real readable work whose title matches the page.
    Nothing passes → None (restraint: zero rather than a fabricated 'book')."""
    dismissed = dismissed or set()
    q = query or f"best book or essay about {label} for someone deep in it"
    candidates = _exa_search(q) or _gemini_candidates(q)   # Exa first; Gemini fallback faces the SAME gate
    for cand in candidates:
        title, url = cand["title"], cand["url"]
        if (label, url) in dismissed or not url.startswith("http"):
            continue
        if not _title_in_body(title, cand.get("summary", ""), cand.get("text", "")):
            continue
        if not _url_resolves(url):
            continue
        ok, work_title = _verify_work(cand)
        if not ok or not _titles_agree(work_title, title):
            continue
        return {"title": title, "author": cand.get("author", ""), "blurb": rec_blurb(cand),
                "url": url, "source": cand.get("source", "exa"), "verified": True}
    return None


if __name__ == "__main__":
    theme = " ".join(sys.argv[1:]) or "how groups form beliefs"
    print(f"sourcing one grounded rec for: {theme!r}  (EXA {'ON' if _exa_key() else 'OFF — will stay silent'})")
    print(json.dumps(source_one_rec(theme), indent=2, ensure_ascii=False))
