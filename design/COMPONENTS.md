# kyo — component inventory

> Part of the [design source of truth](README.md). Every component belongs to exactly one
> class. Class A must never be rebuilt; Class C must justify its existence with a product
> reason. States and values reference [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md); material
> recipes reference [TEXTURE.md](TEXTURE.md).
>
> **v0.2 note (2026-08-02, the Tiimo reset):** glass recipes in this file are superseded —
> chrome is flat white via the `kyoChrome*` helpers (DESIGN_SYSTEM §5). Class C geometry
> (the 56pt bar, hit areas, icon sizes) still binds.

## Class A — Native iOS 26 (use the system control, full stop)

| Component | SwiftUI | kyo notes |
|---|---|---|
| Navigation bar / stack | `NavigationStack` + toolbar APIs | system materials, standard titles |
| Toolbar | `.toolbar` | |
| Search | `.searchable` | Memories archive search (v0.2) |
| Sheet | `.sheet` + detents | native radius/grabber |
| Alert / confirmation | `.alert`, `.confirmationDialog` | copy in kyo's voice, structure native |
| Menu / context menu | `Menu`, `.contextMenu` | sparse; no dashboard chrome |
| Toggle / slider / picker | `Toggle`, `Slider`, `Picker` | |
| Text field / editor | `TextField`, `TextEditor` | native keyboard behavior untouched |
| Photo picker | `PhotosPicker` | zero-permission import path |
| Share sheet | `ShareLink` | |
| Keyboard avoidance / scroll | system | never reimplemented |

## Class B — Native + kyo configuration

| Component | Base | Configuration |
|---|---|---|
| Primary action button | `Button` + `KyoButtonStyle(.primary)` | `action` steel fill, `textOnAccent`, radius 14, height ≥44, interactive material accent (TEXTURE.md §3), pressed scale 0.97 @ `fast` |
| Secondary button | `Button` + `KyoButtonStyle(.secondary)` | `claritySurface` fill, `textPrimary`, 1px `borderDefault`, same geometry/accent |
| Tertiary button | `Button` (plain) | `action`-colored text link, no underline until press |
| Chat composer rail | `TextField` in bottom bar | native field treatment; send button = circular primary w/ `arrow.up`; disabled send = `stone` fill + `borderStrong` icon (the ONE disabled-icon rule — visible-but-clearly-off; general disabled text stays `aluminum`) |
| Kyo search config | `.searchable` | prompt copy in kyo voice |
| Sheet with kyo content | `.sheet` | content well uses `claritySurface` + card grammar |
| Toolbar over imagery | `.toolbar` + system material | only where legibility requires |
| Conversation bubbles | custom layout, native physics | see Class C `MessageBubble` — the *list* uses native `ScrollView` behavior, bubble is the only drawn part |

**Shared control states** (buttons/inputs):
- Disabled: `stone` fill, `aluminum` text/icon, no accent material
- Focus (inputs): 2px `accent` ring, `fast` fade-in
- Destructive: `ink` text + explicit copy first; red only when truly necessary
- Pressed: scale 0.97, `fast`, accent highlight dims slightly

## Class C — Custom kyo components (each has a reason to exist)

| Component | Reason | v0.1? | Spec |
|---|---|---|---|
| `KyoCard` | the product's heartbeat surface | ✔ (primitive only) | `raisedSurface` fill (or `contentCard`), 1px `borderDefault`, radius 18, `paperLift`, padding 20 |
| `MessageBubble` | chat is a person, not a console | ✔ | user: `steel` fill + white text, right-aligned; kyo: `contentCard` white + 1px `borderDefault` + `ink` text, left (the ladder's white step — cloud-on-stone lacked separation on device, 2026-07-23); radius 20 with 6pt anchored corner at group end; internal padding 16 horizontal / 12 vertical; max width ~78% via 72pt far-side gap; grouped spacing 3pt intra / 10pt inter; no drawn tails; no per-message avatars |
| `TypingIndicator` | presence without spectacle | ✔ | three 6pt `muted` dots (washedSlate measured <3:1 — decorative-only law, DS §8) in a kyo-side white bubble + hairline, `MessageBubble`'s 16/12 internal padding, 0.9s gentle opacity loop; no "kyo is thinking…" text |
| `EditorialEmptyState` | stubs must feel authored, not missing | ✔ | `reflectiveTitle` line + one `subheadline` `textSecondary` sentence, centered upper-third, generous whitespace; optional faint `accentSubtle` wash ≤10% |
| `BrandedLoading` | waiting is a brand moment | ✔ (minimal) | K monogram at 40pt, slow opacity breathe (1.2s), on `appBackground`; no spinners on brand surfaces (system spinners fine inside native controls) |
| `EveningCard` | the ritual object — the product's heartbeat | ✔ v0.2 | `contentCard` white, radius `card` 18, 1px `borderDefault`, `cardFloat` shadow; watercolor wash accent masked to the card's top band (`accentSubtle` ≤20%, always clear of text — DS §5 sanctions material on evening cards); a card is one item from the day carrying a ladder of 1–4 rungs, each a deeper question than the last — prompt in `reflectivePrompt` 22 is the CURRENT rung's; rung dots appear below the prompt whenever a card has more than one rung, filled up to the current index; answer affordances key off the current rung's `kind`, not the card's: `yes_no` = two option rows, `choice` = 2-col grid of 2–4 options, `scale` = tappable 1–10 number row, `open` = text field + send; every non-`open` rung keeps a "Say it your way" tertiary (switches to open input); a "Later" tertiary always posts a per-rung skip (recorded server-side, never replied to) and advances the ladder — two skips inside one item retire it, same as answering the last rung; option rows ≥44pt, `KyoButtonStyle(.secondary)`, selected = `mist` fill + 1px `accent` edge; next card peeks behind (`translateY(16) scale(0.94) opacity(0.65)`); advance to the next rung (or, on retirement, the next item) at `standard` motion; card reveal at `meaningReveal`; answered state = quiet check, never celebration |
| `ArchiveCard` / arcs | library, not feed | v0.2 | provenance line, paper-mat imagery |
| `VoiceNoteBubble` | waveform as content | ✔ | `powder` surface (its one sanctioned surface use); play/pause 30pt white circle, 44-bar peak waveform (played `steel`, rest `ink` 35%), mono-digit duration, drag-to-scrub while playing; anchored-corner grammar AND 16/12 internal padding shared with `MessageBubble` |
| `MediaFragment` | photos/reels inline as objects | v0.2 (photo thumb ships in chat v0.1 as plain rounded image, radius 12) | paper-mat treatment later |
| `ProfileCard` | onboarding time capsule | v0.3 | vellum back, shareable |
| `ShareArtifact` | wrapped-style synthesis | later | |
| `KyoTabBar` | Names the destinations and their glyphs. The BAR is the native iOS 26 `TabView` (2026-08-04): three hand-built glass capsules all read as painted pills, because `.glassEffect` on a view the system does not know is a tab bar never gets a tab bar's treatment | ✔ | `TabView` + `Tab`, never a hand-composed shell; the system owns the material, the selection pill, minimize-on-scroll and the bottom edge effect; `Tab(role: .search)` is what draws Kyo's face in the detached circle, and selecting it is an ACTION (opens the chat, hands selection back), not a destination; the mascot reaches the bar as a rendered `UIImage` with `.alwaysOriginal` — a SwiftUI view handed to `Tab`'s label icon is dropped, and SwiftUI's `.renderingMode` does not survive into the bar; tint is the kyo blue, never `#007AFF` |

Banned everywhere (design guide): assistant avatars beside messages, "AI typing"
spectacle, gradient AI bubbles, sparkles, model selectors, prompt libraries, token
counters, technical status chrome, badges/streaks, red-dot guilt.

## Iconography

SF Symbols for every ordinary action (camera, photo import, mic, send `arrow.up`, back,
close, more, search, share, play, settings, chevrons, add, check). Custom glyphs only
when no suitable symbol exists AND the concept is uniquely kyo AND it can match SF optical
weight — none qualify in v0.1. Tab symbols: Chat `message`, Life `rectangle.stack`,
Memories `books.vertical` (filled variants when selected, system behavior).
