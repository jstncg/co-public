import XCTest
@testable import Co

/// The redesigned Home's three shelves and the member model: fixture sanity (ForEach and
/// CoWash both key off ids), and the store's keep-the-seed law per shelf.
@MainActor
final class HomeShelfTests: XCTestCase {
    private func store() -> NotesStore {
        NotesStore(defaults: UserDefaults(suiteName: UUID().uuidString)!, seed: [],
                   forYou: HomeFixtures.forYou, recap: HomeFixtures.recap,
                   profile: HomeFixtures.profile, watches: HomeFixtures.watches)
    }

    /// A duplicate id draws two identical washes and breaks ForEach — the fixture file is the
    /// only author, so the test is the reviewer.
    func testFixtureIDsAreUniqueAcrossEveryShelf() {
        let ids = HomeFixtures.forYou.map(\.id) + HomeFixtures.recap.map(\.id)
            + HomeFixtures.profile.map(\.id) + HomeFixtures.watches.map(\.id)
        XCTAssertEqual(ids.count, Set(ids).count)
    }

    /// The standing watches obey the same seed law as every shelf.
    func testWatchesKeepTheSeedOnEmptyAndReplaceOnNews() {
        let s = store()
        s.apply(watches: [])
        XCTAssertEqual(s.watches, HomeFixtures.watches)
        let live = [WatchItem(id: "rail-w", label: "From the rail", note: "")]
        s.apply(watches: live)
        XCTAssertEqual(s.watches, live)
    }

    /// A For-you card with no URL is untappable by design — the fixtures must not ship one,
    /// or the demo teaches that the cards are decoration.
    func testForYouFixturesAllOpenSomewhere() {
        for item in HomeFixtures.forYou {
            XCTAssertNotNil(item.url, "\(item.id) has no destination")
        }
    }

    /// An empty rail answer keeps the seed on EVERY shelf — blanking one shelf because the
    /// rail had news for another is how the sim's Home reads as broken.
    func testEmptyRailAnswersLeaveEverySeedAlone() {
        let s = store()
        s.apply(forYou: [])
        s.apply(recap: [])
        s.apply(profile: [])
        XCTAssertEqual(s.forYou, HomeFixtures.forYou)
        XCTAssertEqual(s.recap, HomeFixtures.recap)
        XCTAssertEqual(s.profile, HomeFixtures.profile)
    }

    /// When the rail does answer, it replaces the seed wholesale, shelf by shelf.
    func testRailAnswersReplaceSeedsShelfByShelf() {
        let s = store()
        let fy = [ForYouItem(id: "rail-fy", title: "From the rail", source: "rail",
                             length: "", kind: .read, url: nil)]
        let rc = [RecapItem(id: "rail-rc", line: "Did a thing", symbol: "sparkle")]
        let pf = [ProfileFact(id: "rail-pf", title: "Who you are", line: "A member",
                              symbol: "person")]
        s.apply(forYou: fy)
        s.apply(recap: rc)
        s.apply(profile: pf)
        XCTAssertEqual(s.forYou, fy)
        XCTAssertEqual(s.recap, rc)
        XCTAssertEqual(s.profile, pf)
        // The untouched shelf keeps its seed — one shelf's news is not another's blanking.
        XCTAssertEqual(s.watches, HomeFixtures.watches)
    }
}
