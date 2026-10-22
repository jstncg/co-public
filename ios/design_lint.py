#!/usr/bin/env python3
"""The app's mechanical design layer — the only automated check over ios/Co.

`design/DESIGN_SYSTEM.md` is the source of truth for everything visual, but until this file
existed nothing connected it to the Swift. `DesignTokensTests.swift` is a third hand-typed copy
of the same numbers: edit the doc alone and NOTHING fails. This closes the provenance half of
that hole and catches the drift classes a build cannot see.

Nine rules, chosen by the same test Vercel's design linter uses: can code identify the
failure without rendering, without likely false positives, and with a concrete fix? Anything
that needs a rendered surface or product context stays judgment. Rules that grow too many
exceptions belong back there too.

Escape hatch: a trailing `// design: <source>` comment suppresses a finding on that line, and
deliberately requires a citation. "This one is fine" is not a suppression; "the spec fixes
this geometry, DESIGN_SYSTEM.md:451" is. The cited file must still EXIST in design/ — five
docs were deleted on 2026-08-11 and a citation to one of them is a suppression pointing at
nothing (rule/citation-resolves).

Pure stdlib, no deps, no network. Run standalone or via ios/run-sim.sh:

    python3 ios/design_lint.py [--quiet]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "ios" / "Co" / "Co"
DESIGN = ROOT / "design"
TOKENS = APP / "Design" / "DesignTokens.swift"

# design/DESIGN_SYSTEM.md §4.1 — the 4-base scale. 20 came off it 2026-08-11: its only caller
# was the Tasks row gap, which is `xl` 24 now, matching Home.
SPACING_SCALE = {0, 4, 8, 12, 16, 24, 32, 44}

# A suppression must carry a REAL citation: a design/ file and a line. The first version
# accepted `// design: <anything>`, so `// design: idk` silenced a rule — an escape hatch that
# takes any excuse is just a disabled rule with extra steps. `check_citations` then proves the
# cited file exists, because a citation to a deleted doc is the same excuse in a suit.
# A section anchor (`DESIGN_SYSTEM.md §5.4`) is accepted alongside a line number, and is the
# better citation: §5.4 still means §5.4 after someone inserts a paragraph, while :553 quietly
# starts pointing at a different rule.
SUPPRESS = re.compile(r"//\s*design:\s*([A-Za-z_]+\.md)\s*(?::\d+|§\d+(?:\.\d+)?[a-z]?)")

# Padding AND stack spacing. Frames stay out on purpose (see check_spacing), but a `VStack(
# spacing: 3)` is the same rhythm decision a `.padding(3)` is, and leaving it unlinted is how
# 1/2/3/10pt gaps accumulated next to a 4-base scale.
PADDING = re.compile(r"\.padding\(\s*(?:\.\w+\s*,\s*)?(\d+(?:\.\d+)?)\s*\)"
                     r"|\bspacing:\s*(\d+(?:\.\d+)?)\s*[,)]")
RAW_COLOR = re.compile(r"Color\(\s*(?:\.\w+\s*,\s*)?red:|#[0-9A-Fa-f]{6}")
# Chrome strings only. Message CONTENT is co's lowercase register and never appears as a
# literal — it arrives from the server — so every literal here is chrome by construction.
#
# The lookbehind is load-bearing: without it `circleButton("chevron.left")` matched on the tail
# of its own helper name and every SF Symbol in the app read as a lowercase UI string. Six
# false findings in one file, which is how a lint stops being read.
#
# `label:` is included and `title:` is NOT: a label argument is always chrome, while `title:`
# is how every model in the app names member content (`Note(title: "frameworks thinking")`),
# and a member's own lowercase page title is not a chrome violation.
UI_STRING = re.compile(
    r'(?<![A-Za-z_])(?:Text|Label|Button|navigationTitle|accessibilityLabel|accessibilityHint'
    r'|label:|placeholder:)'
    r'\(?\s*"([^"\\]{2,})"')
BADGE = re.compile(r"\.badge\b")
STATIC_LET = re.compile(r"^\s*static let (\w+)")
# `// comment` but not the `//` inside a URL. A hex named in a comment is documentation, not a
# painted colour, and flagging it taught the reader to skim past rule/no-raw-color.
COMMENT = re.compile(r"(?<!:)//.*$")
# DESIGN_SYSTEM.md §2.2's table rows: | `token` | #HEX | … — the doc names the primitive tier,
# so the doc is what the rule reads. Hard-coding the list here would make the lint a fourth
# copy of the token table.
PRIMITIVE_ROW = re.compile(r"^\|\s*`(\w+)`\s*\|")


class Finding:
    def __init__(self, rule: str, path: Path, line: int, detail: str, fix: str):
        self.rule, self.path, self.line, self.detail, self.fix = rule, path, line, detail, fix

    def __str__(self) -> str:
        rel = self.path.relative_to(ROOT)
        return (f"{rel}:{self.line}\n"
                f"  rule/{self.rule}: {self.detail}\n"
                f"  fix: {self.fix}")


def swift_files() -> list:
    """Fixtures are stand-in MEMBER content — note bodies, task titles, the words someone
    typed. They are not chrome and no chrome rule applies to them."""
    return sorted(p for p in APP.rglob("*.swift") if p.parent.name != "Fixtures")


def _lines(path: Path) -> list:
    """(lineno, text) for lines without a `// design:` citation."""
    out = []
    for i, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not SUPPRESS.search(raw):
            out.append((i, raw))
    return out


def check_spacing(findings: list) -> None:
    """Padding and stack spacing — NOT .frame(). Component specs fix frame geometry explicitly
    (the 68/58pt shutter, the 6pt typing dots, the 30pt play circle), so linting frames would be
    all false positive and the rule would die of exceptions."""
    for path in swift_files():
        for n, text in _lines(path):
            for m in PADDING.finditer(text):
                value = float(m.group(1) or m.group(2))
                if value in SPACING_SCALE:
                    continue
                nearest = min(SPACING_SCALE, key=lambda s: abs(s - value))
                findings.append(Finding(
                    "spacing-4-base", path, n,
                    f"padding {m.group(1)} is off the 4-base scale (DESIGN_SYSTEM.md §4.1)",
                    f"use {nearest}, or cite the spec that fixes it: // design: DESIGN_SYSTEM.md:NN"))


def check_raw_color(findings: list) -> None:
    for path in swift_files():
        if path == TOKENS:
            continue  # the one file allowed to name a hex — it IS the token table
        for n, text in _lines(path):
            if RAW_COLOR.search(COMMENT.sub("", text)):
                findings.append(Finding(
                    "no-raw-color", path, n,
                    "raw hex or Color(red:…) outside DesignTokens.swift",
                    "use a CoColor token; add it to DESIGN_SYSTEM.md §2 first if it is new"))


def _design_corpus() -> str:
    return "\n".join(p.read_text(encoding="utf-8") for p in sorted(DESIGN.glob("*.md")))


def check_token_source(findings: list) -> None:
    """The only mechanical link between design/ and the code. Every token must trace to
    design/ — otherwise the Swift file has quietly become the source of truth and
    DESIGN_SYSTEM.md §0.3 ("never invent a value in Swift that this file does not define") is
    fiction.

    Blind spot worth naming: this reads `DesignTokens.swift` alone. Component-tier tokens that
    live beside their component (`CoTabMetrics`) are governed by the doc's §4.7 table and by
    `TabBarGeometryTests`, not by this rule.

    Matched by VALUE, not by name, wherever the token has one: the docs state numbers and
    hexes, while `xs`/`xxl`/`bubbleAnchor` are Swift-side naming conventions the docs have no
    reason to carry. Name-matching produced false positives on all of those and, worse, a
    false NEGATIVE on `morph` — "morph" is a substring of "neumorphism", which appears in
    DESIGN_SYSTEM.md's banned-effects line. Word boundaries and value matching, or the rule
    lies in both directions."""
    corpus = _design_corpus()
    # Font families are pinned by DesignTokensTests (they load or they don't); aliases are
    # assignments to other tokens, already sourced by whatever they point at.
    exempt = {"garamondRegular", "garamondMedium"}
    for n, text in _lines(TOKENS):
        m = STATIC_LET.match(text)
        if not m:
            continue
        name = m.group(1)
        if name in exempt:
            continue
        hexes = re.findall(r'hex:\s*"(#[0-9A-Fa-f]{6})"', text)
        if hexes:
            missing = [h for h in hexes if h.lower() not in corpus.lower()]
            if not missing:
                continue
            detail = f"`{name}` = {missing[0]} appears in no design/ doc"
        else:
            nums = re.findall(r"=\s*(-?\d+(?:\.\d+)?)\s*$", text)
            if nums and re.search(rf"(?<![\d.]){re.escape(nums[0])}(?![\d.])", corpus):
                continue
            if not nums and re.search(rf"\b{re.escape(name)}\b", corpus):
                continue          # a named role (fast, standard, meaningReveal, label)
            if nums:
                detail = f"`{name}` = {nums[0]} appears in no design/ doc"
            else:
                detail = f"`{name}` is named in no design/ doc — invented in Swift"
        findings.append(Finding(
            "token-has-source", TOKENS, n, detail,
            "add it to the owning design/ doc first, then this file, then DesignTokensTests"))


def _primitives() -> set:
    """The names in DESIGN_SYSTEM.md §2.2 — the primitive tier, read from the doc that owns it.
    A hard-coded list here would make the lint a FOURTH copy of the token table."""
    doc = (DESIGN / "DESIGN_SYSTEM.md").read_text(encoding="utf-8")
    parts = doc.split("### 1.1 Primitives", 1)
    if len(parts) < 2:
        return set()
    # The tier no longer lives in one table: v0.7 moved the neutral ramp into §1.6's prose
    # (`name` #HEX runs). Harvest both shapes across §1, bounded at §2 — a parser wed to one
    # layout is how this function silently returned set() for two weeks.
    # Table rows only from §1.1's own subsection — the semantic and category tables in the
    # later subsections share the row shape and must not be harvested as primitives.
    own = parts[1].split("###", 1)[0]
    names = {m.group(1) for m in map(PRIMITIVE_ROW.match, own.splitlines()) if m}
    # v0.7 restated the neutral ramp as §1.6 prose. Only the run between "Neutral field:"
    # and "Semantic roles:" is primitive tier — the semantic run right after it uses the
    # same `name` #hex shape and must NOT land in this set, or every view flags.
    # §1.6 was appended out of numeric order (it sits far below ## 2), so the ramp is
    # searched in the WHOLE doc — its two anchor phrases are unique.
    ramp = re.search(r"Neutral field:(.*?)Semantic roles:", doc, re.S)
    if ramp:
        names |= set(re.findall(r"`(\w+)` #[0-9A-Fa-f]{6}", ramp.group(1)))
    return names


def check_primitive_in_view(findings: list) -> None:
    """DESIGN_SYSTEM.md §1: "A view must never reference a primitive." That law was prose only
    until now, and prose does not fail a build — `CoColor.white` was standing in for
    `textOnAccent` in three files, which is exactly the coupling the two tiers exist to prevent.

    Wash imagery is the sanctioned exception (§5.4): a wash stands in for a photograph, so it
    reaches the ramp directly. It cites the line that says so, like any other exception."""
    names = _primitives()
    if not names:
        return
    pattern = re.compile(r"CoColor\.(" + "|".join(sorted(names)) + r")\b")
    for path in swift_files():
        if path == TOKENS:
            continue
        for n, text in _lines(path):
            m = pattern.search(COMMENT.sub("", text))
            if m:
                findings.append(Finding(
                    "no-primitive-in-view", path, n,
                    f"`CoColor.{m.group(1)}` is a primitive (§2.2), reached from a view",
                    "use the semantic token that means it (§2.3), or cite the wash "
                    "exemption: // design: DESIGN_SYSTEM.md:NN"))


def check_citations(findings: list) -> None:
    """A citation to a deleted doc is an excuse in a suit. Five design docs were merged into
    DESIGN_SYSTEM.md on 2026-08-11, and every suppression pointing at one of them silently kept
    suppressing."""
    live = {p.name for p in DESIGN.glob("*.md")}
    for path in swift_files():
        for i, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            m = SUPPRESS.search(raw)
            if m and m.group(1) not in live:
                findings.append(Finding(
                    "citation-resolves", path, i,
                    f"suppression cites {m.group(1)}, which no longer exists in design/",
                    f"re-point it at the section of DESIGN_SYSTEM.md that now carries the rule, "
                    f"or drop the suppression and fix the line"))


def check_sentence_case(findings: list) -> None:
    """DESIGN_SYSTEM.md §10, Justin's call 2026-07-24: ALL app UI text uses sentence
    capitalization — even copy written in co's voice. The lowercase texting register
    survives ONLY in message content, which is never a literal in this codebase."""
    for path in swift_files():
        for n, text in _lines(path):
            for m in UI_STRING.finditer(text):
                s = m.group(1).strip()
                if not s or not s[0].isalpha():
                    continue
                if s.isupper():
                    continue  # the small-caps label role, uppercased at the call site
                if s[0].islower():
                    findings.append(Finding(
                        "sentence-case-ui-text", path, n,
                        f"UI string starts lowercase: {s[:48]!r}",
                        "capitalize the first letter — chrome is sentence case even in kyo's "
                        "voice (DESIGN_SYSTEM.md §10)"))


def check_no_shadow(findings: list) -> None:
    """DESIGN_SYSTEM.md §5.1 — drop shadows were retired 2026-08-11 with `coFloating()`. Glass
    carries its own separation and a shadow under it draws the lift twice; content cards
    separate by surface colour and a hairline. The voice orb's glow is light EMISSION, not
    elevation, and cites the line that says so."""
    for path in swift_files():
        for n, text in _lines(path):
            if re.search(r"\.shadow\(", COMMENT.sub("", text)):
                findings.append(Finding(
                    "no-shadow", path, n,
                    "drop shadow — retired with `coFloating()` (DESIGN_SYSTEM.md §5.1)",
                    "delete it: glass separates itself, and content separates by "
                    "`contentCard` + `borderDefault`"))


def check_no_badge(findings: list) -> None:
    """DESIGN_SYSTEM.md §9.5 — no badges on tabs, ever. The no-guilt law wearing a UI costume;
    its conversational twin is rule/no-guilt-ping."""
    for path in swift_files():
        for n, text in _lines(path):
            if BADGE.search(text):
                findings.append(Finding(
                    "no-tab-badge", path, n,
                    "badge modifier — red-dot guilt is banned (DESIGN_SYSTEM.md §9.5)",
                    "delete it; there is no sanctioned badge in this app"))


# Justin, 2026-08-27: "tell the LLM it has to pass cyclomatic complexity lint and it will
# write simpler code." SwiftLint's default budget (10), counted SwiftLint's way: one for the
# function, one per decision point — if/guard/while/for/catch, each && and ||, each switch
# arm. `body` and other computed views stay out: a ViewBuilder's ifs are layout, not logic,
# and counting them would push real logic INTO helpers just to hide it from the meter.
COMPLEXITY_MAX = 10
FUNC_DECL = re.compile(
    r"^\s*(?:@\w+(?:\([^)]*\))?\s+)*"
    r"(?:(?:public|private|internal|fileprivate|open|static|final|override|mutating|"
    r"nonisolated|convenience|required|class)\s+)*"
    r"(?:func\s+(\w+|`\w+`)|(init)\??)\s*[(<]")
BRANCH_TOKEN = re.compile(r"\bif\s|\bguard\s|\bwhile\s|\bfor\s+\w|\bcatch\b|&&|\|\|")
SWITCH_ARM = re.compile(r"^\s*(?:case\s+.+|default)\s*:")
STRING_LITERAL = re.compile(r'"(?:[^"\\]|\\.)*"')


def check_complexity(findings: list) -> None:
    """Cyclomatic complexity per function, innermost-wins for nested funcs. A function that
    needs more than ten paths is three functions wearing one name."""
    for path in swift_files():
        stack = []  # [name, decl_line, depth_before, count]
        depth = 0
        for n, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            # Comments, then string literals: `#if DEBUG` is a compiler directive, not a
            # branch, and "if you want to catch up" is copy, not control flow.
            line = COMMENT.sub("", raw)
            if line.lstrip().startswith("#"):
                continue
            line = STRING_LITERAL.sub('""', line)
            m = FUNC_DECL.search(line)
            if m:
                stack.append([m.group(1) or "init", n, depth, 1, False])
            if stack:
                stack[-1][3] += len(BRANCH_TOKEN.findall(line))
                if SWITCH_ARM.match(line):
                    stack[-1][3] += 1
            depth += line.count("{") - line.count("}")
            if stack and depth > stack[-1][2]:
                stack[-1][4] = True   # the body's opening brace has been seen
            # A frame closes when its body has OPENED and depth returns to the decl's level.
            # One that never opens (a protocol requirement, a signature still unfolding across
            # lines) pops silently when the surrounding scope closes beneath it — a phantom
            # count of 1 must not reach the parent or the findings.
            while stack and depth <= stack[-1][2]:
                name, decl, _, count, opened = stack.pop()
                if not opened:
                    continue
                # a nested function's paths are also paths of its parent's mental model
                if stack:
                    stack[-1][3] += count - 1
                if count > COMPLEXITY_MAX:
                    findings.append(Finding(
                        "complexity", path, decl,
                        f"`{name}` has cyclomatic complexity {count} (max {COMPLEXITY_MAX})",
                        "split it: name the branches as helpers, or replace the ladder "
                        "with a table"))


CHECKS = (check_spacing, check_raw_color, check_token_source, check_primitive_in_view,
          check_citations, check_sentence_case, check_no_badge, check_no_shadow,
          check_complexity)


def selftest() -> int:
    """Each rule must FIRE on a known-bad line and stay quiet on a known-good one. A lint
    that has only ever been run against a clean tree is untested, and green-because-blind is
    the failure that bites three sessions later."""
    cases = [
        (PADDING, ".padding(.horizontal, 15)", ".padding(.horizontal, CoSpacing.l)"),
        (PADDING, "VStack(spacing: 3) {", "VStack(spacing: CoSpacing.xs) {"),
        (RAW_COLOR, "Color(red: 0.2, green: 0.3, blue: 0.4)", "CoColor.steel.color"),
        (RAW_COLOR, 'let c = "#A1B2C3"', "CoColor.hairline"),
        (BADGE, ".badge(3)", '.accessibilityLabel("Chat")'),
        (re.compile(r"\.shadow\("), ".shadow(color: .black, radius: 4)", ".glassEffect(.regular)"),
        (SUPPRESS, "x  // design: DESIGN_SYSTEM.md:50", "x  // just a comment"),
        # the escape hatch must not accept an excuse in place of a citation
        (SUPPRESS, "x  // design: DESIGN_SYSTEM.md §4.4b", "x  // design: this one is fine"),
        (SUPPRESS, "x  // design: DESIGN_SYSTEM.md §5.4", "x  // design: n/a"),
    ]
    for pattern, bad, good in cases:
        assert pattern.search(bad), f"{pattern.pattern!r} missed {bad!r}"
        assert not pattern.search(good), f"{pattern.pattern!r} false-positived on {good!r}"

    # UI_STRING only EXTRACTS; the case rule is the predicate below it. Testing the regex
    # against "Show me your day" was the first version of this selftest and it asserted the
    # wrong thing — the regex is supposed to match both, the verdict differs.
    def cased_bad(literal: str) -> bool:
        m = UI_STRING.search(literal)
        if not m:
            return False
        s = m.group(1).strip()
        return bool(s) and s[0].isalpha() and not s.isupper() and s[0].islower()

    assert cased_bad('Text("show me your day")')
    assert not cased_bad('Text("Show me your day")')
    assert not cased_bad('Text("EVENING REVIEW")'), "the small-caps label role is not a leak"
    assert not cased_bad('Text("\\(n)")'), "interpolation is not a literal"
    assert not cased_bad('Text("+ ")'), "non-alpha openers are not case violations"
    # A helper whose NAME ends in Button/Text/Label is not a UI string call site. Without the
    # lookbehind this matched the SF Symbol argument and buried the two real findings.
    assert not cased_bad('circleButton("chevron.left", label: "Back") { }')
    assert not cased_bad('coText("doc.text.magnifyingglass")')
    # …but a label: argument IS chrome, which is where onboarding's lowercase copy hid.
    assert cased_bad('OnbPrimaryButton(label: "that\'s me", isEnabled: true)')

    # A hex NAMED in a comment is documentation; a hex PAINTED is a violation.
    assert not RAW_COLOR.search(COMMENT.sub("", "// invisible on a #1C1C1E card"))
    assert RAW_COLOR.search(COMMENT.sub("", 'let c = "#1C1C1E"  // the card'))
    assert RAW_COLOR.search(COMMENT.sub("", 'URL("https://x.co")\nColor(red: 1, green: 0, blue: 0)'))

    # The primitive rule reads the doc's own §2.2 table, so it cannot drift from it.
    prims = _primitives()
    assert {"cream", "ink", "white", "washedSlate"} <= prims, prims
    assert not {"appBackground", "textPrimary", "Token"} & prims, "semantic tier is not primitive"

    # A citation must resolve to a doc that still exists. (COMPONENTS.md was the example
    # until 2026-08-27, when the satellite docs returned to design/ — a ghost name keeps
    # the assert honest without pinning the doc set.)
    assert SUPPRESS.search("x // design: GHOST.md:50").group(1) == "GHOST.md"
    assert "GHOST.md" not in {p.name for p in DESIGN.glob("*.md")}

    # Off-scale detection, including the decimal case.
    assert 15 not in SPACING_SCALE and 16 in SPACING_SCALE
    assert float(PADDING.search(".padding(.top, 2.5)").group(1)) not in SPACING_SCALE

    # token-has-source must match by value/word-boundary, never by substring: "morph" lives
    # inside "neumorphism" in DESIGN_SYSTEM.md's banned-effects line, and a naive `in` test
    # silently passed an invented token for months.
    assert not re.search(r"\bmorph\b", "glassmorphism excess, neumorphism.")
    assert re.search(r"\bmorph\b", "| `morph` | 350ms | spring |")
    # and a value match must not accept a substring of a longer number
    assert not re.search(r"(?<![\d.])44(?![\d.])", "duration 0.44")
    assert re.search(r"(?<![\d.])44(?![\d.])", "Touch targets >= 44x44pt")

    # complexity: the decl regex must catch funcs and inits, not words containing "func";
    # the branch tokens must not fire inside identifiers.
    assert FUNC_DECL.search("    private static func home(from world: World) {")
    assert FUNC_DECL.search("init(api: any CoAPI) {")
    assert not FUNC_DECL.search("// a defunct function")
    assert len(BRANCH_TOKEN.findall("if a && b || c { while x { } }")) == 4
    assert not BRANCH_TOKEN.search("gift.uniform(catchall)")
    assert SWITCH_ARM.match("        case .invite: return 1")
    assert SWITCH_ARM.match("        default:")
    assert not SWITCH_ARM.match("    case invite"), "an enum declaration is not a branch"
    assert STRING_LITERAL.sub('""', 'Text("if you want, for a while")') == 'Text("")', \
        "copy is not control flow"
    assert not BRANCH_TOKEN.search(STRING_LITERAL.sub('""', 'e = "try it, if you like"'))

    print(f"design_lint selftest: OK — {len(CHECKS)} rules, "
          f"{len(cases)} pattern pairs, boundary cases")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if not APP.is_dir():
        print(f"design_lint: {APP} not found", file=sys.stderr)
        return 2
    quiet = "--quiet" in sys.argv
    findings: list = []
    for check in CHECKS:
        check(findings)
    if not findings:
        if not quiet:
            print(f"design_lint: clean — {len(CHECKS)} rules over "
                  f"{len(swift_files())} swift files")
        return 0
    by_rule: dict = {}
    for f in findings:
        by_rule.setdefault(f.rule, []).append(f)
    print(f"design_lint: {len(findings)} finding(s) across {len(by_rule)} rule(s)\n")
    for rule in sorted(by_rule):
        for f in by_rule[rule]:
            print(f)
        print()
    print("design/ is the source of truth. Change the doc first, then the Swift, then the "
          "test.\nSuppress a sourced exception inline: // design: DESIGN_SYSTEM.md:50")
    return 1


if __name__ == "__main__":
    sys.exit(main())
