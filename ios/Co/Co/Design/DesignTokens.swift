import SwiftUI
import UIKit

// Derived from design/DESIGN_SYSTEM.md — values copied verbatim, checked by
// CoTests/DesignTokensTests. Change the design doc first, then this file, then the test.

struct CoTone: Equatable {
    let hex: String
    /// The dark-scheme sibling (DS §2.7). nil = same hex both schemes.
    var dark: String? = nil

    var color: Color {
        guard let dark else { return Color(coHex: hex) }
        return Color(UIColor { traits in
            UIColor(Color(coHex: traits.userInterfaceStyle == .dark ? dark : hex))
        })
    }
}

extension Color {
    init(coHex hex: String) {
        let cleaned = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var value: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&value)
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255.0,
            green: Double((value >> 8) & 0xFF) / 255.0,
            blue: Double(value & 0xFF) / 255.0
        )
    }
}

enum CoColor {
    // Primitives (DS §2.2). Never referenced by a view — the semantic tier below is.
    static let grouped = CoTone(hex: "#F2F2F7")
    static let black = CoTone(hex: "#000000")
    static let systemGray = CoTone(hex: "#8E8E93")
    static let systemGray4 = CoTone(hex: "#D1D1D6")
    static let systemGray5 = CoTone(hex: "#E5E5EA")

    /// The page. v0.7.1 (Justin, 8/10): the warm cream went neutral — `#F7F7F7`.
    static let cream = CoTone(hex: "#F7F7F7")

    // Wash-only primitives (DS §2.2): imagery and shadows, never chrome. Every blue
    // in this block was retired 2026-08-10 (Justin: "nuke everything related to the blue"),
    // and v0.7.1 took the warmth out with it — this ramp is pure neutral grey now.
    static let stone = CoTone(hex: "#FCFCFC")
    static let cloud = CoTone(hex: "#F0F0F0")
    static let white = CoTone(hex: "#FFFFFF")
    static let aluminum = CoTone(hex: "#DCDCDC")
    static let aluminumDeep = CoTone(hex: "#C0C0C0")
    static let mist = CoTone(hex: "#E6E6E6", dark: "#2A2A2A")
    static let powder = CoTone(hex: "#D8D8D8")
    static let washedSlate = CoTone(hex: "#ADADAD")  // decorative fills only (DS §2.6)
    static let watercolor = CoTone(hex: "#878787")
    static let steel = CoTone(hex: "#6B6B6B")
    static let steelText = CoTone(hex: "#5A5A5A", dark: "#B0B0B0")  // steel's text-safe sibling
    /// THE black. Not #000 — `#202020` (Justin, 8/10: "use this for all blacks").
    static let ink = CoTone(hex: "#202020")
    static let inkSoft = CoTone(hex: "#2E2E2E")
    static let muted = CoTone(hex: "#6E6E6E")
    static let hairline = CoTone(hex: "#E4E4E4")

    // Category tones (DS §2.5, Apple Health pattern): fill for washes/chips, deep for
    // icon + eyebrow. Never body text, never a room — the blues stay the app's identity.
    static let readFill = CoTone(hex: "#FBE7D9", dark: "#3B2A1C")
    static let readDeep = CoTone(hex: "#A34A1F", dark: "#EE9A62")
    static let watchFill = CoTone(hex: "#FBE3E8", dark: "#3B2229")
    static let watchDeep = CoTone(hex: "#B03A50", dark: "#EE8AA0")
    static let listenFill = CoTone(hex: "#DFF2E5", dark: "#1C3324")
    static let listenDeep = CoTone(hex: "#2E7A4C", dark: "#6FCE93")
    static let eventFill = CoTone(hex: "#FAF0D2", dark: "#37301A")
    static let eventDeep = CoTone(hex: "#8A6A00", dark: "#D8B94E")

    /// Apple Notes' amber. Notepad jurisdiction ONLY (DS §2.5): toolbar glyphs, Done.
    static let notesGold = CoTone(hex: "#C79500", dark: "#E0B33F")

    // Home's page gradient (Justin, 2026-08-27: navy, not pink — white at the top, bluer
    // at the bottom). Wash-only primitives like the ramp above — the shader blends these
    // three, they are never chrome and never text, so the v0.7 no-blue law (which governs
    // chrome) does not reach them.
    static let auroraIce = CoTone(hex: "#E9EEF7")
    static let auroraBlue = CoTone(hex: "#DCE4F4")
    static let auroraNavy = CoTone(hex: "#CBD8EE")

    // Semantic roles (DS §2.3). The ONLY tones that adapt to scheme — washes
    // stay pictures. v0.7 (Justin, 8/10): Notion paper — cream page, WHITE cards, pure-black
    // text, and not one blue anywhere in the app.
    static let appBackground = cream
    static let raisedSurface = CoTone(hex: "#FCFCFC", dark: "#1C1C1E")
    static let contentCard = CoTone(hex: "#FCFCFC", dark: "#1C1C1E")
    static let claritySurface = CoTone(hex: "#FCFCFC", dark: "#1C1C1E")
    /// `#202020`, not #000 (Justin, 8/10) — every black in the app is this one. Spelled out
    /// rather than aliased to `ink`: a wash primitive carries no dark sibling, so aliasing it
    /// silently left dark mode with #202020 text on a black page (test, 8/10).
    static let textPrimary = CoTone(hex: "#202020", dark: "#FFFFFF")
    /// The navy died with v0.7 — titles are the same black as body.
    static let titlePrimary = textPrimary
    /// Darkened 2026-08-11 to clear WCAG AA on the page (DS §2.6): #8E8E93 measured 3.04:1
    /// as body-secondary, which is Apple's systemGray — a primitive Apple itself does not use
    /// as label text. Tertiary took systemGray's place and is large-text-only.
    static let textSecondary = CoTone(hex: "#6F6F73", dark: "#98989F")
    static let textTertiary = CoTone(hex: "#8E8E93", dark: "#6E6E6E")
    static let textOnAccent = white
    static let borderDefault = CoTone(hex: "#E8E8E8", dark: "#2C2C2E")
    static let borderStrong = CoTone(hex: "#D6D6D6", dark: "#3A3A3C")
    /// THE accent is the same `#202020`. No brand blue survives.
    static let accent = action
    static let accentSubtle = CoTone(hex: "#EFEFEF", dark: "#2A2A2A")
    static let accentSecondary = CoTone(hex: "#EFEFEF", dark: "#2C2C2E")
    /// Buttons are `#202020` on paper; dark scheme flips to paper to stay visible.
    static let action = CoTone(hex: "#202020", dark: "#F2F2F7")
    static let actionText = CoTone(hex: "#202020", dark: "#F2F2F7")
    static let metadata = textSecondary

    // The Tasks pills — the only hues left in the app (Justin, 8/10): green is blocked on the
    // member, yellow is co still working, grey is finished and needs no attention.
    static let approvalFill = CoTone(hex: "#D6F2DF", dark: "#1C3324")
    static let approvalText = CoTone(hex: "#14713D", dark: "#6FCE93")
    static let workingFill = CoTone(hex: "#FBF0CE", dark: "#37301A")
    static let workingText = CoTone(hex: "#6F5500", dark: "#D8B94E")
    static let doneFill = CoTone(hex: "#EFEFEF", dark: "#2C2C2E")
    static let doneText = CoTone(hex: "#6B6B6B", dark: "#98989F")
}

enum CoSpacing {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let cardPadding: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
    static let touchTarget: CGFloat = 44
}

/// One scale for every control (Justin, 8/4 — the app had 52/44/30/28pt circles doing the
/// same job). The 44pt touch floor (DS §4.7) comes from `contentShape` insets, not disc size.
enum CoControl {
    /// Circular chrome: close, gear, search, the field's ✕. Native 44pt — 36 read as a toy.
    static let disc: CGFloat = CoSpacing.touchTarget
    /// Circular controls INSIDE a bar: send, voice, cancel, stop.
    static let barDisc: CGFloat = 30
    /// Bare glyph buttons inside a bar: plus, mic.
    static let barGlyph: CGFloat = 28
    /// Search/composer pills. Height stays constant; WIDTH reacts to focus (Justin, 8/4).
    static let bar: CGFloat = CoSpacing.touchTarget
    static let barFocused: CGFloat = 52

    // The glyph ladder (DS §4.7 and §9). Four rungs, nothing between them — the
    // 2026-08-10 audit found 11/12/13/14/15/16/17/19/20/30 all in use, which is the same as
    // having no ranks at all. A glyph's size is what says which rank of control it belongs to.
    /// Disclosure arrows only — the smallest mark the app draws.
    static let chevron: CGFloat = 11
    /// A glyph sitting inside a line of body text: folder, quote mark.
    static let rowIcon: CGFloat = 13
    /// A glyph inside a bar or pill: search, send, the field's ✕.
    static let barIcon: CGFloat = 15
    /// A glyph alone in a circular control: close, settings, back, add.
    static let discIcon: CGFloat = 17

    static func reach(_ visible: CGFloat) -> CGFloat { (CoSpacing.touchTarget - visible) / 2 }
}

/// The one veil under every header. Halved from the package defaults (Justin, 8/7 — the
/// frost read as a band, not a dissolve); both knobs must move together.
enum CoBlur {
    static let headerRadius: CGFloat = 2.5
    static let headerTintTop: Double = 0.35
    static let headerTintMiddle: Double = 0.25
    static let headerFade: CGFloat = 64
    /// The footer's reach, shorter than the header's so the dissolve starts BELOW the footer's
    /// controls rather than above them (Justin, 2026-08-11: "start it a tiny bit lower").
    static let footerFade: CGFloat = 32
}

/// Three rungs, because the app draws three shapes. `sm` 8, `md` 12, `control` 14 and
/// `bubbleAnchor` 6 were deleted 2026-08-11 with zero call sites between them — a six-rung
/// ladder where three are fiction reads as permission to invent a fourth.
enum CoRadius {
    static let card: CGFloat = 18
    static let bubble: CGFloat = 20
    static let sheet: CGFloat = 24
}

/// The one shadow content cards wear (Justin, 2026-08-26: "card shadows so it doesn't look
/// like slop"). Soft and low — separation, not levitation. Chrome stays glass and carries no
/// shadow at all, which is what keeps the two elevations from reading as the same trick twice.
extension View {
    /// Two layers, the way real light works: a tight contact shadow that seats the card on
    /// the page, and a wide ambient one that lifts it. One layer at one radius always reads
    /// as either a smudge or a glow — never as an object.
    func coCardShadow() -> some View {
        shadow(color: CoColor.ink.color.opacity(0.05), radius: 3, x: 0, y: 1)
            .shadow(color: CoColor.ink.color.opacity(0.10), radius: 20, x: 0, y: 8)  // design: DESIGN_SYSTEM.md §1.6
    }

    /// THE content card: `contentCard` fill, hairline, the one shadow, and a matching hit
    /// shape. `dashed` is Profile's unearned slot. One modifier so three card types cannot
    /// drift apart in fill, stroke, or radius.
    func coCard(dashed: Bool = false) -> some View {
        background(CoColor.contentCard.color,
                   in: RoundedRectangle(cornerRadius: CoRadius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: CoRadius.card, style: .continuous)
                .stroke(CoColor.borderDefault.color,
                        style: StrokeStyle(lineWidth: 0.5, dash: dashed ? [4, 4] : [])))
            .coCardShadow()
            .contentShape(RoundedRectangle(cornerRadius: CoRadius.card, style: .continuous))
    }
}

enum CoMotion {
    static let fastDuration: Double = 0.18
    static let standardDuration: Double = 0.24
    static let meaningRevealDuration: Double = 0.7

    static let fast = Animation.timingCurve(0.22, 1, 0.36, 1, duration: fastDuration)
    static let standard = Animation.timingCurve(0.22, 1, 0.36, 1, duration: standardDuration)
    static let meaningReveal = Animation.timingCurve(0.16, 1, 0.3, 1, duration: meaningRevealDuration)
    /// A spring keeps velocity when re-triggered mid-flight; a timing curve restarts cold.
    static let morph = Animation.spring(duration: 0.35, bounce: 0.15)
    /// The one place bounce exceeds `morph`'s 0.15 — the voice orb is elastic, so its
    /// release has to recoil visibly.
    static let elastic = Animation.spring(duration: 0.45, bounce: 0.34)
}

enum CoType {
    static let garamondRegular = "EBGaramond-Regular"
    static let garamondMedium = "EBGaramond-Medium"

    /// Inter is THE app face (Justin, 8/4). SF Symbols stay `.system(...)` — a custom font
    /// strips the glyph's weight axis.
    static let titleFace = "Inter-Bold"

    /// Inter ships four static faces, not a weight axis — anything lighter than medium
    /// lands on Regular (no Inter Light bundled).
    static func face(_ weight: Font.Weight) -> String {
        switch weight {
        case .bold, .heavy, .black: return "Inter-Bold"
        case .semibold: return "Inter-SemiBold"
        case .medium: return "Inter-Medium"
        default: return "Inter-Regular"
        }
    }

    static func inter(_ size: CGFloat, _ weight: Font.Weight = .regular,
                      relativeTo style: Font.TextStyle = .body) -> Font {
        .custom(face(weight), size: size, relativeTo: style)
    }

    static func style(_ style: Font.TextStyle, _ weight: Font.Weight = .regular) -> Font {
        inter(baseSize(style), weight, relativeTo: style)
    }

    /// The system font's default (Large) point size per style, so the Inter swap keeps
    /// identical metrics.
    private static let baseSizes: [Font.TextStyle: CGFloat] = [
        .largeTitle: 34, .title: 28, .title2: 22, .title3: 20, .headline: 17, .body: 17,
        .callout: 16, .subheadline: 15, .footnote: 13, .caption: 12, .caption2: 11,
    ]

    static func baseSize(_ style: Font.TextStyle) -> CGFloat { baseSizes[style] ?? 17 }

    // `screenTitle`, `reflectiveTitle`, `reflectivePrompt`, `reflectiveDisplay` and
    // `reflectiveBody` were deleted 2026-08-11. Four had no call sites at all; the fifth was
    // onboarding's 32pt prompt, which moved onto the ramp (`.title` semibold). `titleFace` now
    // reaches exactly two places, both of them display numerals: the note date and Settings'
    // large title. That is what DS §3.1 always said it was for.

    /// Small-caps section label: Inter 11 Semibold, tracked, uppercased at the call site.
    static let label = inter(11, .semibold, relativeTo: .caption2)
    static let labelTracking: CGFloat = 1.5
}
