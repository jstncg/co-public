# Saga App Screens wireframe — what carries over (pulled 2026-07-23)

Source: claude.ai/design project `77be40ef…` → `saga-app-screens-wireframe.html` (saved
beside this file). Saga-era interaction wireframe, adopted as **foundational reference**
per Justin. Skin (warm paper `#f0eee9`, ink-900 fills) is superseded by Cloud Instrument;
structure survives where MASTER.md hasn't overruled it.

## Adopted into design/ (canonical)

- **Chat bubbles**: max-width 78%; radius 20 with a 6pt corner on the anchored side
  (user `20/20/6/20` bottom-right, kyo `20/20/20/6` bottom-left) — directional tail via
  corner radius, no drawn tails. Centered day/time labels ("Today 9:12 PM") as thread
  separators.
- **Composer**: rounded field + circular `arrow.up` send, 38–44pt. → COMPONENTS.md
- **Option rows ≥44pt** everywhere options appear.
- **Options-bubble** (kyo bubble containing tappable options at full bubble width, then a
  follow-up option set): v0.2 chat pattern, matches MASTER "tappable options instead of
  walls of text".
- **Life daily-review card anatomy** (v0.2 build target): eyebrow label + serif screen
  title + "n of m" progress; card = photo top (~58%) with time-chip overlay, question
  below (serif ~21pt), option grid / open-text row; next card peeks behind
  (`translateY(16) scale(0.94) opacity(0.65)`); answered state → quiet check + "swipe
  right to keep this memory" + right-edge glow; swipe physics with drag.
- **Memories anatomy** (v0.2 build target): 2-col arc grid (square cover, title, meta
  like "42 memories · May – Aug" / "noticed by kyo"); arc detail = cover (editable),
  serif title + rename, count/date meta, segmented Weeks / Months / Chapters adaptive
  timeline, 3-col tiles mixing photos, pull-quote text tiles, and type icons.

## Superseded (do not adopt)

- Floating circular Camera/Memories corner buttons + bottom Add/hold-to-talk/keyboard
  cluster → replaced by MASTER §8 three-tab shell (Home viewfinder / Life / Memories).
- Voice-first hold-to-talk as the primary input → chat bar + camera are primary in v0.x;
  voice mode is later.
- Warm paper palette, ink-900-as-accent, Lucide icons → Cloud Instrument palette, steel/
  watercolor accents, SF Symbols.
- "Saga" naming and copy register (title-case sentences, "Tell Saga…") → kyo voice
  (lowercase, quieter).
