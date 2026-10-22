# kyo — design system (iOS product layer)

> Part of the [design source of truth](README.md). The buildable system behind every
> screen. `DesignTokens.swift` copies these values verbatim.
>
> **v0.3 (2026-08-02 evening): blues restored, App Store/Fitness shell.** Justin: "use
> original kyo blues and liquid glass," canvas `#FDFDFD`. What survives from v0.2: the
> serif large-title band, the Health category tones (Plan's taxonomy), Apple Notes 1:1
> for the notepad. Shell: a glass three-tab bar at the bottom — Home / Plan / Profile,
> icon over label — plus the notepad circle. Home opens App Store-search style: big
> serif "Home", the glass "Search or ask Kyo" field under it, which lifts the iMessage
> search overlay. Home = always the feed; Profile = the archive in Apple Fitness's
> summary shape. Glass carries a light tint (§5) so bars stay visible on the canvas.
>
> **v0.x ships light appearance only.** The app pins `UIUserInterfaceStyle = Light`.

## 1. Color

### 1.1 Primitives

v0.4 (2026-08-03, Justin): Apple-native chrome. The UI wears stock iOS light mode —
white/grey surfaces, black/grey text — but the highlight color is the KYO blue, never
Apple's base `#007AFF` (Justin, 2026-08-03): `steelText` is THE accent, `mist` its
subtle fill. The other washed blues survive ONLY inside imagery washes (§1.5).

| Token | Hex | Notes |
|---|---|---|
| `grouped` | `#F2F2F7` | systemGroupedBackground — the canvas |
| `white` | `#FFFFFF` | cards |
| `black` | `#000000` | label |
| `systemGray` | `#8E8E93` | secondary text |
| `systemGray4` | `#D1D1D6` | strong borders |
| `systemGray5` | `#E5E5EA` | separators, card strokes |
| `steelText` | `#4E6B85` | THE accent — the kyo blue |
| `mist` | `#D7E3EE` | selected fills, tag chips |

Wash-only primitives (feed imagery via §1.5, plus shadows off `ink` — never chrome):

| Token | Hex | Token | Hex |
|---|---|---|---|
| `stone` | `#FDFDFD` | `washedSlate` | `#9FB3C6` |
| `cloud` | `#EFF2F6` | `watercolor` | `#6E8FAF` |
| `aluminum` | `#D6DDE4` | `steel` | `#587895` |
| `aluminumDeep` | `#B8C1CC` | `steelText` | `#4E6B85` |
| `mist` | `#D7E3EE` | `ink` | `#11161C` |
| `powder` | `#C9DCEA` | `inkSoft` | `#1F242B` |
| `muted` | `#5F6B76` | `hairline` | `#D5DDE6` |

### 1.1b Category tones (Apple Health pattern)

Five pastel pairs. The fill is the wash/chip, the deep is its icon + small-caps label —
never body text, never backgrounds for long copy.

| Category | Fill | Deep | Use |
|---|---|---|---|
| `act` | mist (accent family) | steelText | the one thing to try today |
| `read` | `#FBE7D9` | `#A34A1F` | articles, essays, books |
| `watch` | `#FBE3E8` | `#B03A50` | videos, films |
| `listen` | `#DFF2E5` | `#2E7A4C` | podcasts, music |
| `event` | `#FAF0D2` | `#8A6A00` | events, places, people |

One special-jurisdiction token: `notesGold #C79500` — Apple Notes' amber, used ONLY
inside the notepad (toolbar icons, Done), where the surface is a 1:1 Notes recreation.

### 1.5 Imagery placeholders (the shader wash)

Stand-in imagery (feed media, row thumbs) renders through `Design/WashShader.metal`:
three tones from the palettes above breathing into each other, plus film grain so the
ramps never band. Deterministic per item id, static, never animated. **This is the one
surface exempt from one-blue-per-element** — a wash stands in for a photograph, and
photographs are not UI. Palettes mix the blues with the category tones and are defined
in `FeedWash.palettes`; glyphs over a wash are white @ 85%.

### 1.2 Semantic roles (what code uses)

| Semantic | Primitive | Job |
|---|---|---|
| `appBackground` | grouped | app shell / default background |
| `raisedSurface` | grouped | wells, panels, inactive rails |
| `contentCard` | white | highest-clarity nested surface (1px stroke) |
| `claritySurface` | white | inputs, sheets content wells |
| `textPrimary` | black | body and titles |
| `textSecondary` | systemGray | captions, secondary body |
| `textOnAccent` | white | text on accent fills |
| `borderDefault` | systemGray5 | separators, card strokes |
| `borderStrong` | systemGray4 | pressed edges, inactive rail outlines |
| `accent` | ink | THE signal: selected tab, focus, active states |
| `accentSubtle` | mist | gentle fields, selected washes (palette; unused in UI) |
| `accentSecondary` | systemGray5 | tag fills, secondary washes |
| `action` | ink | primary button fills |
| `actionText` | ink | accent TEXT on light surfaces: links, labels |
| `metadata` | systemGray | metadata/caption text |

> **The kyo blue retired (2026-08-06).** The brand blue no longer acts as the accent —
> "kill steel blue entirely; the only steelblue should be the kyo mascot." `accent`,
> `action` and `actionText` all resolve to **ink** (#11161C / dark #F2F2F7): selection,
> focus, tabs, links, decoration and primary fills read black. The blue survives in exactly
> two places — the mascot (`powder` → `watercolor` blob) and the chat (`messageBlue`,
> iMessage's own blue). Photo-placeholder washes still drift through `steel`/`watercolor`.
> `steelText` (#4E6B85) remains in the palette as the mascot's blue, no longer a role.

**Dark mode (v0.5, 2026-08-03).** The switch lives in Profile → Settings (gear) and forces
one scheme app-wide; there is no system-follow. Semantic roles carry a dark hex, taken from
Apple's dark grouped palette: `appBackground` #000000, `raisedSurface` / `contentCard` /
`claritySurface` #1C1C1E, `textPrimary` #FFFFFF, `textSecondary` / `metadata` #98989F,
`borderDefault` / `accentSecondary` #2C2C2E, `borderStrong` #3A3A3C, `accent` / `action` /
`actionText` #F2F2F7 (ink's paper sibling — never Apple's #0A84FF), `accentSubtle`
#243240 (mist's dark). Category tones adapt too: fills darken to
muted rooms (read #3B2A1C, watch #3B2229, listen #1C3324, event #37301A, mist #243240) and
deeps brighten one step to stay text-safe (read #EE9A62, watch #EE8AA0, listen #6FCE93,
event #D8B94E, steelText #93B2CE, notesGold #E0B33F). Wash primitives stay single-hex in
both schemes: feed imagery reads as pictures, not chrome.

### 1.3 Surface ladder

At least three paper layers before the accent enters any major composition:

1. App shell: `grouped`
2. Elevated cards: `white`
3. Nested cards: `white` + 1px `systemGray5` border
4. Selected/active: `mist` wash or `steelText` signal
5. Critical foreground: `black`

### 1.4 Usage laws

- Blue is meaning (memory, selection, focus, decisive action) — never ambient
  decoration. **One blue per element — no gradients between blues** (Justin,
  2026-08-01, reaffirmed with the v0.3 revert). The only sanctioned gradients are
  colorless light (the aluminum inner edge) and they may never read as a hue.
- Category tones are eyebrows and chips, never rooms: a pastel fill may hold an icon or
  a highlighted card, never a screen region.
- Aluminum frames (borders, rules, edges) — never fills the room.
- Ink never becomes a large field.
- Excluded permanently: ember/orange as UI chrome, warm cream/paper surfaces, neon,
  saturated accents beyond the category set, visible grid texture.

## 2. Typography

Two families in the binary, strict jurisdictions — system sans for everything, one
distinctive sans for identity. Serif retired 2026-08-03 (Justin: "move away from serif
completely"); the title family is under audition and lives behind ONE token, `titleFace`
in DesignTokens.swift — swap it there and every title in the app follows. Currently
Inter Bold; tried and passed on: EB Garamond, SF Rounded, Nunito Sans (stays bundled
for quick re-tries). Queued: Manrope.

| Family | Jurisdiction |
|---|---|
| **SF (system)** | everything supporting: body, metadata, captions, controls, buttons, forms, menus, tab labels, alerts |
| **the title face (`titleFace`, auditioning — now Inter Bold)** | **titles only**: screen titles, section titles, card headlines, wordmark |
| **EB Garamond** | retired from every surface; files stay bundled (DesignTokensTests loads them) until the audition settles |

### 2.1 iOS roles (SF via Dynamic Type text styles)

**The SF scale is closed.** Six sizes, each a Dynamic Type text style — never a
hardcoded `.system(size:)` for running text.

| Style | pt | Use |
|---|---|---|
| `.caption` | 12 | small labels and helper text |
| `.subheadline` | 15 | secondary body, metadata prose, compact controls |
| `.body` | 17 | the default |
| `.title3` | 20 | titles and bigger elements — do not overuse |
| `.title` | 28 | titles, sparingly |
| `.largeTitle` | 34 | screen-title band (the title face via `screenTitle`) |

Weights stay within Regular–Semibold; Bold is rare emphasis. One custom role:

| Role | Spec | Use |
|---|---|---|
| `label` | SF 11pt Semibold, tracking +0.14em (**1.5pt**), uppercase | small-caps eyebrows, section labels, tags, tab labels |

### 2.2 Title roles (`titleFace`, scaled relative to Dynamic Type)

| Role | Spec | Use |
|---|---|---|
| `screenTitle` | `titleFace` 34pt, relativeTo `.largeTitle` | THE large-title band: screen titles (Apple News / Health pattern) |
| `reflectiveTitle` | `titleFace` 28pt | section titles, card-level meaning statements |
| `reflectivePrompt` | `titleFace` 22pt | card headlines, hero headlines |
| `reflectiveDisplay` | `titleFace` 40pt | rare hero moments |
| `reflectiveBody` | plain SF 18pt | short reflective passages inside cards (was serif; follows the split now) |

**The title rule:** titles wear the title face, supporting text is SF. Everything under a
title (body, metadata, captions, controls) stays SF. Exception: the notepad is a 1:1 Apple
Notes recreation and is ALL SF, including its date lines.

Rules: never below 17pt; never for controls, labels, metadata, or long utility text.

### 2.3 UI copy (binding)

Do not add subtitles, helper text, or descriptive copy beneath headings, labels, cards, or
settings by default. Prefer one concise, self-explanatory heading or label. Only add
supporting copy when Justin explicitly asks for it or when it is necessary to prevent
misunderstanding or error, and never use it to restate the heading.

## 3. Spacing & radius

**Spacing scale (pt), 4-base:** `4, 8, 12, 16, 20, 24, 32, 44`. Card internal padding 16.
Screen horizontal margin 16 (native default) or 20 for editorial content.

**Usage rules (binding):** tap targets ≥ 44×44 with a real hit region; button padding
12–16; screen edge margin 16; inside cards 16; vertical rhythm 8 / 12 / 16. Respect
safe areas.

**Radius:** `sm 8` (tags, small controls) · `md 12` (photo thumbnails, board tiles) ·
`control 14` (buttons, inputs) · `card 18` · `bubble 20` (anchored corner 6) ·
`sheet 24` (system sheets keep native radius).

## 4. Elevation & depth

Paper floating just above stone — not app-card shadows.

| Token | Value | Use |
|---|---|---|
| `paperLift` | y 8, blur 28, ink @ 6% | resting cards |
| `cardFloat` | y 10, blur 32, ink @ 7% | pickable/pressed cards |
| `modalElevation` | y 22, blur 70, ink @ 13% | modal/overlay surfaces |

Rules: prefer 1px `hairline` borders over shadows in dense UI; banned: heavy drop
shadows, dark glows, glassmorphism, neumorphism.

## 5. Materials law

- **Liquid Glass** (native iOS 26): restored 2026-08-02 evening — approved and
  encouraged for the functional layer: the tab bar, the notepad circle, the search
  field, floating controls, keyboard toolbars, sheets. Always via the `kyoGlass*`
  helpers / system APIs — never a hand-rolled blur recipe. Never applied to content:
  cards, letters, photos, reading surfaces.
- **Glass is tinted light** (Justin, 2026-08-02): white @ ~55% on bars and controls —
  the app is light-only on a near-white canvas, and untinted glass disappears there.
- **The header veil** (`CoBlur`): one progressive blur under every page head — Home, Archive,
  Profile pools and the chat's own copy of it. Radius **2.5**, tint **0.35** at the very top
  easing to **0.25** at the head's centre, cleared **64pt** below it. Halved from the package
  defaults (radius 5, 70%/50%) on Justin's ask, 2026-08-07: at full strength the frost read as
  a band across the top of the page instead of the page dissolving into it. Both knobs move
  together — the tint is most of what the eye reads as "blur" here. ONE treatment per edge:
  where this veil is on, the system's scroll edge effect is off (`scrollEdgeEffectHidden`).
- Every textured component requires a clean, non-textured fallback (TEXTURE.md §5).

## 6. Motion

Motion is attention arriving, never UI showing off.

| Token | Duration | Curve | Use |
|---|---|---|---|
| `fast` | 180ms | cubic-bezier(0.22, 1, 0.36, 1) | controls, presses, small reveals |
| `standard` | 240ms | cubic-bezier(0.22, 1, 0.36, 1) | dropdowns, state swaps |
| `meaningReveal` | 700ms | cubic-bezier(0.16, 1, 0.3, 1) | insight/card reveals |
| `morph` | 350ms | spring, bounce 0.15 | **interruptible** state morphs only |
| `elastic` | 450ms | spring, bounce 0.34 | release of a *stretched* element (voice orb) |

SwiftUI mapping: `fastDuration` 0.18 / `standardDuration` 0.24 as
`Animation.timingCurve(0.22, 1, 0.36, 1, duration:)`; `meaningRevealDuration` 0.7 as
`.timingCurve(0.16, 1, 0.3, 1, duration: 0.7)`; `morph` is
`Animation.spring(duration: 0.35, bounce: 0.15)`; `elastic` is
`Animation.spring(duration: 0.45, bounce: 0.34)`.

**Name motion with the vocabulary in ANIMATION_VOCABULARY.md** (Emil Kowalski /
animations.dev, adopted 2026-08-04). Rubber-banding, squash & stretch, morph, stagger,
continuity transition — the words are binding for every code comment, review, and spec.

Rules: ease-out family only for enters; exits at least as fast as enters; pressed
controls scale to 0.97 with `fast`; no bounces except `morph` and `elastic`; keyboard-initiated
actions never animate; native transitions stay native. Reduced Motion replaces spatial
movement with opacity — every custom animation has that variant.

## 7. Haptics & sound

- Capture: light tick (`.impact(.light)`).
- Card answered: soft confirmation (`.impact(.soft)`); no celebratory animation.
- Insight arrives: silent. kyo is not needy.
- No custom sounds anywhere in v0.x.

## 8. Accessibility floor

- Body text: `ink` on the papers (≥ 15:1). Secondary: `muted` (≈5:1).
  **`washedSlate` is never text and never a sole state signal.** Decorative fills only.
- Accent-family text on the papers uses `steelText #4F48B0`; raw `watercolor` as text
  is reserved for ≥18pt / ≥14pt-bold moments.
- Category deeps are certified for their 11pt semibold eyebrows on white; category
  fills never carry text smaller than that.
- `notesGold` matches Apple's own Notes-accent contrast (below AA for small text) and
  is therefore glyphs + the bold Done only, never running text.
- Active/selected states never rely on color alone: pair with a dark label, a 1px
  edge, or a filled control.
- Touch targets ≥ 44×44pt. Dynamic Type: SF roles are system text styles; reflective
  roles scale via `relativeTo:`; the 11pt `label` is deliberately fixed-size. Layouts
  must survive accessibility sizes (test at AX1).

## 9. Onboarding (the app's own language)

The onboarding flow (`OnboardingTheme` in `OnboardingFlow.swift`) speaks the same visual
language as the rest of the app: `OnboardingTheme` is a thin alias layer over `KyoColor` /
`KyoType`, never a second palette.

- Backdrop: full-bleed `kyoWash` shader (§1.5) over `stone`, blending `white` / `mist` /
  `powder` with film grain — the feed's imagery language as a canvas, never flat black.
- Text: `textPrimary` / `textSecondary`, EB Garamond throughout (title = Medium,
  body = Regular), centered.
- Accent: `accent` (watercolor) for selection states, the progress capsule, and the
  primary CTA (`textOnAccent` label). No onboarding-only hues.
- Pill questions: exactly four liquid-glass pills per question, pick one; selected =
  25% accent glass tint + `actionText` label.

### 1.6 The monochrome shell (v0.7, 2026-08-14 — the Home/Tasks redesign, PR #11)

The new shell retires the blue-wash chrome for a grayscale field; color survives only in
status pills and imagery washes. Values below are the source of truth for
`DesignTokens.swift` as of this section's date.

Neutral field: `cream` #F7F7F7 · `stone` #FCFCFC · `cloud` #F0F0F0 · `mist` #E6E6E6 ·
`powder` #D8D8D8 · `hairline` #E4E4E4 · `aluminum` #DCDCDC · `aluminumDeep` #C0C0C0 ·
`washedSlate` #ADADAD · `watercolor` #878787 · `steel` #6B6B6B · `steelText` #5A5A5A ·
`muted` #6E6E6E · `ink` #202020 · `inkSoft` #2E2E2E

Home's aurora (2026-08-26 — the shelf redesign): the page gradient is the wash shader over
three pastel fields, wash-only primitives like the ramp above — never chrome, never text.
A white veil covers the upper half and thins downward, so the top reads paper and the
colour gathers at the bottom. 2026-08-27: the field turned from pink to navy — the v0.7
no-blue law governs chrome, and the aurora is imagery:
`auroraIce` #E9EEF7 · `auroraBlue` #DCE4F4 · `auroraNavy` #CBD8EE

The aurora is the page field for Home, Archive and Profile (2026-08-27), so the three
destinations read as one place.

The shelf redesign also returns ONE shadow: `coCardShadow()`, two layers (ink 5% r3 y1
contact + ink 10% r20 y8 ambient), worn by top-level content cards on those pages — Home's
shelf cards, Archive's rooms and board tiles, Profile's fact cards. §5.1's retirement
still holds for chrome — glass separates itself, and no other surface may shadow.

Semantic roles: `raisedSurface` / `contentCard` / `claritySurface` #FCFCFC ·
`textPrimary` / `titlePrimary` #202020 · `textSecondary` #6F6F73 · `borderDefault` #E8E8E8 ·
`borderStrong` #D6D6D6 · `accentSubtle` / `accentSecondary` #EFEFEF ·
`action` / `actionText` #202020

Task status pills (the only color on Tasks): `approvalFill` #D6F2DF with
`approvalText` #14713D · `workingFill` #FBF0CE with `workingText` #6F5500 ·
`doneFill` #EFEFEF with `doneText` #6B6B6B

Controls: `barFocused` 52 (the focused search/composer pill height; rest height stays
the 44 floor from §3).
