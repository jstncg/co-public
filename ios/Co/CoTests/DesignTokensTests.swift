import XCTest
@testable import Co

// design/DESIGN_SYSTEM.md is the source of truth; these tests pin the Swift copy to it.
final class DesignTokensTests: XCTestCase {
    func testPrimitiveHexesMatchDesignSystem() {
        // v0.7 (2026-08-10): Notion paper. Every wash primitive went warm-neutral so the
        // imagery carries no hue either — see `testNoBlueSurvivesAnywhere`.
        XCTAssertEqual(CoColor.grouped.hex, "#F2F2F7")
        XCTAssertEqual(CoColor.black.hex, "#000000")
        XCTAssertEqual(CoColor.systemGray.hex, "#8E8E93")
        XCTAssertEqual(CoColor.systemGray4.hex, "#D1D1D6")
        XCTAssertEqual(CoColor.systemGray5.hex, "#E5E5EA")
        XCTAssertEqual(CoColor.cream.hex, "#F7F7F7")
        XCTAssertEqual(CoColor.stone.hex, "#FCFCFC")
        XCTAssertEqual(CoColor.cloud.hex, "#F0F0F0")
        XCTAssertEqual(CoColor.white.hex, "#FFFFFF")
        XCTAssertEqual(CoColor.aluminum.hex, "#DCDCDC")
        XCTAssertEqual(CoColor.aluminumDeep.hex, "#C0C0C0")
        XCTAssertEqual(CoColor.mist.hex, "#E6E6E6")
        XCTAssertEqual(CoColor.powder.hex, "#D8D8D8")
        XCTAssertEqual(CoColor.washedSlate.hex, "#ADADAD")
        XCTAssertEqual(CoColor.watercolor.hex, "#878787")
        XCTAssertEqual(CoColor.steel.hex, "#6B6B6B")
        XCTAssertEqual(CoColor.ink.hex, "#202020")
        XCTAssertEqual(CoColor.inkSoft.hex, "#2E2E2E")
        XCTAssertEqual(CoColor.muted.hex, "#6E6E6E")
        XCTAssertEqual(CoColor.hairline.hex, "#E4E4E4")
        // Home's aurora (2026-08-26): the shelf page's shader triple, wash-only.
        XCTAssertEqual(CoColor.auroraIce.hex, "#E9EEF7")
        XCTAssertEqual(CoColor.auroraBlue.hex, "#DCE4F4")
        XCTAssertEqual(CoColor.auroraNavy.hex, "#CBD8EE")
    }

    /// The v0.7 guard (Justin, 2026-08-10: "nuke everything related to the blue, completely
    /// remove it all"). A tone is blue when its blue channel leads red by a visible margin —
    /// this fails the moment someone reintroduces one, which prose in the design doc cannot.
    func testNoBlueSurvivesAnywhere() {
        let tones: [(String, CoTone)] = [
            ("cream", .init(hex: CoColor.cream.hex)), ("cloud", CoColor.cloud),
            ("aluminum", CoColor.aluminum), ("aluminumDeep", CoColor.aluminumDeep),
            ("mist", CoColor.mist), ("powder", CoColor.powder),
            ("washedSlate", CoColor.washedSlate), ("watercolor", CoColor.watercolor),
            ("steel", CoColor.steel), ("steelText", CoColor.steelText),
            ("ink", CoColor.ink), ("inkSoft", CoColor.inkSoft), ("muted", CoColor.muted),
            ("hairline", CoColor.hairline), ("appBackground", CoColor.appBackground),
            ("contentCard", CoColor.contentCard), ("textPrimary", CoColor.textPrimary),
            ("titlePrimary", CoColor.titlePrimary), ("accent", CoColor.accent),
            ("accentSubtle", CoColor.accentSubtle),
            ("accentSecondary", CoColor.accentSecondary), ("action", CoColor.action),
            ("borderDefault", CoColor.borderDefault), ("borderStrong", CoColor.borderStrong),
        ]
        for (name, tone) in tones {
            let value = UInt32(tone.hex.dropFirst(), radix: 16) ?? 0
            let red = Int((value >> 16) & 0xFF)
            let blue = Int(value & 0xFF)
            XCTAssertLessThanOrEqual(blue - red, 4, "\(name) (\(tone.hex)) reads blue")
        }
    }

    func testCategoryTonesMatchDesignSystem() {
        // DS §1.1b — Apple Health pattern: fill + text-safe deep per category.
        XCTAssertEqual(CoColor.readFill.hex, "#FBE7D9")
        XCTAssertEqual(CoColor.readDeep.hex, "#A34A1F")
        XCTAssertEqual(CoColor.watchFill.hex, "#FBE3E8")
        XCTAssertEqual(CoColor.watchDeep.hex, "#B03A50")
        XCTAssertEqual(CoColor.listenFill.hex, "#DFF2E5")
        XCTAssertEqual(CoColor.listenDeep.hex, "#2E7A4C")
        XCTAssertEqual(CoColor.eventFill.hex, "#FAF0D2")
        XCTAssertEqual(CoColor.eventDeep.hex, "#8A6A00")
        XCTAssertEqual(CoColor.notesGold.hex, "#C79500")
        // v0.5 dark siblings: fills darken to rooms, deeps brighten to stay text-safe.
        XCTAssertEqual(CoColor.readFill.dark, "#3B2A1C")
        XCTAssertEqual(CoColor.readDeep.dark, "#EE9A62")
        XCTAssertEqual(CoColor.watchFill.dark, "#3B2229")
        XCTAssertEqual(CoColor.watchDeep.dark, "#EE8AA0")
        XCTAssertEqual(CoColor.listenFill.dark, "#1C3324")
        XCTAssertEqual(CoColor.listenDeep.dark, "#6FCE93")
        XCTAssertEqual(CoColor.eventFill.dark, "#37301A")
        XCTAssertEqual(CoColor.eventDeep.dark, "#D8B94E")
        XCTAssertEqual(CoColor.notesGold.dark, "#E0B33F")
        XCTAssertEqual(CoColor.mist.dark, "#2A2A2A")
    }

    func testSemanticRolesCarryTheDarkTable() {
        // v0.7 (2026-08-10): cream page, WHITE cards, pure-black text, black accent.
        XCTAssertEqual(CoColor.appBackground.hex, "#F7F7F7")
        XCTAssertEqual(CoColor.appBackground, CoColor.cream)
        XCTAssertEqual(CoColor.raisedSurface.dark, "#1C1C1E")
        XCTAssertEqual(CoColor.contentCard.hex, "#FCFCFC")
        XCTAssertEqual(CoColor.contentCard.dark, "#1C1C1E")
        XCTAssertEqual(CoColor.claritySurface, CoColor.contentCard)
        XCTAssertEqual(CoColor.textPrimary.hex, "#202020", "every black in the app is #202020")
        XCTAssertEqual(CoColor.textPrimary.dark, "#FFFFFF")
        // The navy is gone — titles are the same pure black as body copy.
        XCTAssertEqual(CoColor.titlePrimary, CoColor.textPrimary)
        XCTAssertEqual(CoColor.textSecondary.hex, "#6F6F73", "AA on the page — DS §2.6")
        XCTAssertEqual(CoColor.textSecondary.dark, "#98989F")
        XCTAssertEqual(CoColor.textTertiary.hex, "#8E8E93")
        XCTAssertEqual(CoColor.borderDefault.hex, "#E8E8E8")
        XCTAssertEqual(CoColor.borderDefault.dark, "#2C2C2E")
        XCTAssertEqual(CoColor.borderStrong.dark, "#3A3A3C")
        XCTAssertEqual(CoColor.accent, CoColor.action)
        XCTAssertEqual(CoColor.accent.hex, "#202020")
        XCTAssertEqual(CoColor.accent.dark, "#F2F2F7")
        XCTAssertEqual(CoColor.action.hex, "#202020")
        XCTAssertEqual(CoColor.actionText, CoColor.action)
        XCTAssertEqual(CoColor.accentSubtle.hex, "#EFEFEF")
        XCTAssertEqual(CoColor.accentSecondary.hex, "#EFEFEF")
        XCTAssertEqual(CoColor.metadata, CoColor.textSecondary)
        // The one surviving hue: the Tasks approval pill.
        XCTAssertEqual(CoColor.approvalFill.hex, "#D6F2DF")
        XCTAssertEqual(CoColor.approvalText.hex, "#14713D")
        // Text on accent fills stays white in both schemes.
        XCTAssertEqual(CoColor.textOnAccent, CoColor.white)
        // Washes must never adapt (DS §1.2 dark table): pictures, not chrome.
        XCTAssertNil(CoColor.stone.dark)
        XCTAssertNil(CoColor.white.dark)
        XCTAssertNil(CoColor.watercolor.dark)
    }

    func testGeometryAndMotionScales() {
        // Three rungs, and three is the whole ladder (DS §4.6). `sm`/`md`/`control`/
        // `bubbleAnchor` were deleted 2026-08-11 with zero call sites.
        XCTAssertEqual(CoRadius.card, 18)
        XCTAssertEqual(CoRadius.bubble, 20)
        XCTAssertEqual(CoRadius.sheet, 24)
        XCTAssertEqual(CoSpacing.touchTarget, 44)
        XCTAssertEqual(CoSpacing.cardPadding, 16)
        // The header veil, half the package's defaults (DS §5). Both knobs, because halving the
        // radius alone leaves the tint doing what the eye actually reads as the blur.
        XCTAssertEqual(CoBlur.headerRadius, 2.5)
        XCTAssertEqual(CoBlur.headerTintTop, 0.35)
        XCTAssertEqual(CoBlur.headerTintMiddle, 0.25)
        XCTAssertEqual(CoBlur.headerFade, 64)
        XCTAssertEqual(CoMotion.fastDuration, 0.18)
        XCTAssertEqual(CoMotion.standardDuration, 0.24)
        XCTAssertEqual(CoMotion.meaningRevealDuration, 0.7)
    }

    func testGaramondShipsInBundle() {
        // The reflective faces must actually load from the app bundle (Info.plist
        // UIAppFonts + Resources/Fonts). A silent SF fallback would fake the brand.
        XCTAssertNotNil(UIFont(name: CoType.garamondMedium, size: 28))
        XCTAssertNotNil(UIFont(name: CoType.garamondRegular, size: 18))
    }

    func testTitleFaceShipsInBundle() {
        // Same law for whatever face the title knob currently points at: if it doesn't
        // load, every masthead silently falls back to SF and the audition lies.
        XCTAssertNotNil(UIFont(name: CoType.titleFace, size: 34))
    }
}
