import XCTest
@testable import Co

/// The two home surfaces (watching rail + while-you-were-living) are HOME's face, not
/// search's. The only logic on them is the show/hide rule — Live mode, no active query —
/// plus the surface contracts the fixtures must meet so the sections render the way the
/// design says.
@MainActor
final class HomeSummaryTests: XCTestCase {
    func testSummaryShowsOnlyInLiveModeWithNoQuery() {
        XCTAssertTrue(FeedStore.showsSummary(mode: .live, query: ""))
        XCTAssertTrue(FeedStore.showsSummary(mode: .live, query: "   "),
                      "whitespace-only is no query, same law as the feed filter")
        XCTAssertFalse(FeedStore.showsSummary(mode: .live, query: "sauna"),
                       "a receipt is not a search result — searching hides the house")
        XCTAssertFalse(FeedStore.showsSummary(mode: .archive, query: ""),
                       "archive is the kept-feed, not the house")
        XCTAssertFalse(FeedStore.showsSummary(mode: .archive, query: "sauna"))
    }

}

