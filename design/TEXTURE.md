# kyo — the texture & material accent system

> Part of the [design source of truth](README.md). Decided by Justin 2026-07-23:
> **surfaces stay clean and native; interactive elements carry a minimal, unique material
> accent.** Not ambient washes; not signature-moments-only. This file is the exact recipe.

## 1. Doctrine

1. Backgrounds, lists, bars, and reading surfaces are clean color — no texture.
2. **Interaction carries the material.** Buttons, the shutter, focus/selection outlines,
   and send controls get one consistent accent: *watercolor light inside an aluminum
   edge*. It should read as "precisely machined, softly clouded" at arm's length — felt
   more than seen.
3. **No gradients in the blues** (Justin's call 2026-08-01, supersedes the original
   blue-family-neighbors rule). A blue element is one flat blue — the darker blue (`steel`)
   or a lighter one (`watercolor`/`mist`/`powder`). Fills, washes, and photo placeholders
   are flat. The only gradient left in the app is colorless light: the aluminum inner
   edge's white→ink highlight, which must never read as a hue.
4. Meaning moments (evening cards, archive covers, profile card — v0.2+) may use the full
   material palette per DESIGN_SYSTEM §5. Chat bubbles are content, not controls: **clean**.
5. When in doubt, remove the accessory (the Chanel rule). One material voice, everywhere,
   is the brand; six effects is a theme park.

## 2. Where the accent lives (complete list)

| Element | Accent |
|---|---|
| Primary button (incl. circular send) | FLAT steel fill + aluminum inner edge (the watercolor-light overlay was deleted 2026-08-01 — it was a gradient on a blue) |
| Secondary button | FLAT white fill + hairline border + inner edge (the mist breath was deleted 2026-08-01, same reason) |
| Capture shutter | white disc + inner edge highlight; pressed scale 0.94 (see COMPONENTS — the one 0.97-rule exception) |
| Input focus | 2px `accent` ring, `fast` fade |
| Selection (chips/options, v0.2 cards) | `mist` wash + 1px `watercolor` edge |
| Tab selection | system tint `accent` only — the OS owns the tab bar, no custom accent |
| Editorial empty states | none — the `accentSubtle` background wash was deleted 2026-08-01; a blue fading to clear is a gradient in a blue. Stub states are plain `appBackground` and let the type carry them |

Everything else: **never** — nav/tab/toolbars (system-owned), viewfinder, bubbles, body
text surfaces, alerts, sheets' chrome.

## 3. The recipe (KyoInteractiveMaterial)

Layered, top to bottom, on a control of radius 14:

1. **Flat fill** — `steel` on primary, `white` on secondary. No overlay, no ramp. (Layer 1
   used to be a "watercolor light" gradient; it was deleted 2026-08-01 under §1.3.)
2. **Aluminum inner edge** — inset top 1px white @ 65%, inset bottom 1px ink @ 5%
   (`aluminumInnerEdge` token)
3. **Border** — light fills only: 1px `hairline`
4. **Pressed** — scale 0.97 @ `fast`; overlay opacity ×0.6; highlight edge dims

Implementation: pure SwiftUI (flat fills + `overlay` strokes) inside
`KyoButtonStyle`. **v0.1 ships zero Metal shaders** — the recipe doesn't need one. The
paper-grain `.colorEffect` shader (port of Paper's grain GLSL) is v0.2, for card surfaces
only, behind the same fallback flag.

## 4. Paper-shaders sourcing (reference, v0.2+)

`@paper-design/shaders` (open-source GLSL) is the catalog; effects are specs to port, not
dependencies. Shortlist to port to Metal when their surfaces exist: fine grain (cards),
watercolor/smoke drift (evening-card backs, `meaningReveal` pacing), liquid-metal sheen
(NEVER on controls — brand imagery only). Each port: `.colorEffect`/`.layerEffect`, capped
to the opacity ranges in DESIGN_SYSTEM §5, `reducedMotion` variant, fallback required.

## 5. Fallback (non-negotiable)

`KyoMaterial.enabled` global switch:
- OFF → flat fills, hairline borders, focus rings intact. Nothing communicates *only*
  through texture.
- Auto-OFF when system Increase Contrast or Reduce Transparency is on.
- Debug toggle in the dev settings panel (v0.1) to eyeball both modes.
