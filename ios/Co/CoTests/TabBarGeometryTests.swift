import XCTest
@testable import Co

final class TabBarGeometryTests: XCTestCase {
    /// Justin, 2026-08-10: the bar moved to the top and Tasks joined it. Three destinations,
    /// in this order, and every case is a real page — no disguised actions in the enum.
    func testTabsAreExactlyHomeArchiveAndProfile() {
        XCTAssertEqual(CoTab.destinations, [.home, .archive, .profile])
        XCTAssertEqual(CoTab.destinations.map(\.label), ["Home", "Archive", "Profile"])
        XCTAssertEqual(CoTab.destinations.count, CoTab.allCases.count)
    }

    /// The row is hand-built now, so its geometry is ours to keep honest: the pills must clear
    /// the 44pt touch floor (DS §3), and a resting pill must be narrower than a selected one —
    /// that difference IS the selected state.
    func testPillGeometryClearsTheTouchFloor() {
        XCTAssertGreaterThanOrEqual(CoTabMetrics.barHeight, CoSpacing.touchTarget)
        XCTAssertGreaterThanOrEqual(CoTabMetrics.restingPillWidth, CoSpacing.touchTarget)
    }

    /// The pills are DRAWN shorter than they are TAPPED (Justin, 2026-08-11 — "just slightly
    /// thinner"). If someone later collapses the two back into one value, the row either grows
    /// a fat bar again or drops under the touch floor; this is the guard against both.
    ///
    /// The 4pt difference is also what makes the shell's top inset `m` 12 instead of `l` 16
    /// (DS §4.4b): centring 40 in 44 leaves 2pt of dead space under the paint, and the optical
    /// gap counts it. Change this pair and that inset has to move with it — this assertion is
    /// where that coupling is written down, so it fails loudly instead of drifting quietly.
    func testPillsAreDrawnShorterThanTheyAreTapped() {
        XCTAssertLessThan(CoTabMetrics.pillHeight, CoTabMetrics.barHeight)
        XCTAssertGreaterThanOrEqual(CoTabMetrics.barHeight, CoSpacing.touchTarget)
        XCTAssertEqual(CoTabMetrics.barHeight - CoTabMetrics.pillHeight, 4,
                       "DS §4.4b's optical gap assumes 2pt of dead space under the paint")
    }

    /// The leading disc plus three resting pills must still fit a small iPhone's width, or the
    /// selected pill has no room left to grow into.
    func testTheRowFitsTheNarrowestPhone() {
        let narrowest: CGFloat = 320
        let resting = CoTabMetrics.barHeight
            + (CoTabMetrics.restingPillWidth * CGFloat(CoTab.destinations.count))
            + (CoTabMetrics.gap * CGFloat(CoTab.destinations.count))
            + (CoSpacing.l * 2)
        XCTAssertLessThan(resting, narrowest)
    }

    func testEveryTabCarriesAGlyphAndALabel() {
        for tab in CoTab.allCases {
            XCTAssertFalse(tab.symbol.isEmpty)
            XCTAssertFalse(tab.selectedSymbol.isEmpty)
            XCTAssertFalse(tab.label.isEmpty)
        }
    }

    /// The chat, the notepad and the retired mascot circle are all NOT destinations.
    /// "profile" left this list 2026-08-26 — it is a real page now, co's model of the member.
    func testOnlyRealDestinationsAreCases() {
        let raw = Set(CoTab.allCases.map(\.rawValue))
        XCTAssertTrue(raw.isDisjoint(with: ["notepad", "chat", "today", "search", "plan", "kyo", "feed", "tasks"]))
    }
}
