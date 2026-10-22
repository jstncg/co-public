# design/ — the kyo design source of truth

> **STATUS: SOURCE OF TRUTH for everything visual.** App code follows these files; UI that
> conflicts with them is a bug, the same law `docs/kyo/MASTER.md` holds for product
> behavior. Owner: Justin Cheng. Established 2026-07-23.

## What lives here

| File | What it decides |
|---|---|
| [BRAND.md](BRAND.md) | Who kyo is visually: essence, the two-layer law, identity marks, imagery, voice-in-UI |
| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | The buildable system: color, type, spacing, radius, elevation, materials, motion, accessibility |
| [COMPONENTS.md](COMPONENTS.md) | Component inventory in three classes with SwiftUI mappings and states |
| [TEXTURE.md](TEXTURE.md) | The material-accent system: where texture lives, exact recipes, fallbacks |
| `reference/` | Immutable inputs: moodboards, brand-book/playbook extracts (history, not law) |

## The one-sentence system

**Expressive kyo content lives inside a familiar native iOS interaction shell.**
Controls and navigation are Apple's (Liquid Glass, SF Symbols, SF type). Meaning — cards,
reflections, archive covers, the profile card — carries kyo's material language (paper,
watercolor, vellum, aluminum, EB Garamond). The chrome stays calm so the meaning can land.

## Source precedence (how these files were derived, and how conflicts resolve)

1. Justin's latest written correction (always wins)
2. These files (`design/`)
3. `reference/` inputs, in their own order: `kyo design guide.md` → `kyo background.md`
   (≈ MASTER.md) → the two moodboards → handoff v02 → tokens v02 → brand-book/playbook PDFs

Conflicts and deviations resolved during derivation, recorded so they never reopen:

- **Cloud is `#EFF2F6`** (tokens + handoff + CSS seed agree; one brand-book page's
  `#EEF2F6` is a typo).
- **In-app UI typography is SF (system), not Inter.** The design guide outranks the tokens
  file. Inter exists only on web/editorial surfaces. EB Garamond only at meaning moments.
- **Button height 40 → ≥44pt** (handoff said 40; iOS touch-target floor wins).
- **`hairline #D5DDE6` is THE border token** for cards/controls (the handoff's
  `#D6DDE4` aluminum-as-border reading loses to the tokens file's dedicated hairline).
- **kyo chat bubble = white + hairline, not cloud** (cloud-on-stone measured 1.01:1 in
  simulator review 2026-07-23 — imperceptible; the ladder's white step restores depth).
- **No graph pillar anywhere**, including brand illustration (Justin's correction in the
  playbook transcript outranks the brand book's five-pillar list).

## How code consumes this

`ios/Kyo/Kyo/Design/DesignTokens.swift` is hand-derived from DESIGN_SYSTEM.md — hexes,
scales, and durations copied verbatim, checked by `KyoTests/DesignTokensTests.swift`.
Change the system here first, then the Swift file, then the test. Never invent a value in
Swift that this folder doesn't define.
