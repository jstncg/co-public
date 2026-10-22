import XCTest
@testable import Co

/// The feed's only real logic: mode partitions the items, search narrows whatever mode is
/// showing. Everything else on that surface is layout, and layout is judged by looking.
@MainActor
final class FeedFilterTests: XCTestCase {
    private let items = [
        FeedItem(id: "live-quote", kind: .quote, aspectRatio: 1, imageURL: nil,
                 text: "You can have anything you want, but not everything.",
                 attribution: "Oliver Burkeman", tags: ["time"]),
        FeedItem(id: "live-photo", kind: .photo, aspectRatio: 1, imageURL: nil,
                 text: nil, attribution: "Morning light, Coto", tags: ["light"]),
        FeedItem(id: "arch-post", kind: .post, aspectRatio: 1, imageURL: nil,
                 text: "I gave notice on a Tuesday.", attribution: "Michael Ashcroft",
                 tags: ["leaving consulting", "essays"], isArchived: true),
        FeedItem(id: "arch-pod", kind: .podcast, aspectRatio: 1, imageURL: nil,
                 text: "The sabbatical nobody budgets for", attribution: "Longform",
                 tags: ["money"], isArchived: true),
    ]

    private func ids(_ mode: FeedStore.Mode, _ query: String) -> [String] {
        FeedStore.visible(items, mode: mode, query: query).map(\.id)
    }

    func testModePartitionsTheSameItems() {
        XCTAssertEqual(ids(.live, ""), ["live-quote", "live-photo"])
        XCTAssertEqual(ids(.archive, ""), ["arch-post", "arch-pod"])
    }

    func testSearchMatchesTitleAttributionAndTags() {
        XCTAssertEqual(ids(.live, "everything"), ["live-quote"], "title")
        XCTAssertEqual(ids(.live, "Coto"), ["live-photo"], "attribution")
        XCTAssertEqual(ids(.archive, "essays"), ["arch-post"], "tag")
    }

    func testSearchIsCaseInsensitiveAndSubstring() {
        XCTAssertEqual(ids(.archive, "SABBAT"), ["arch-pod"])
        XCTAssertEqual(ids(.archive, "consult"), ["arch-post"])
    }

    func testSearchStaysInsideTheActiveMode() {
        // "Ashcroft" only exists in the archive; searching Live must not smuggle it in.
        XCTAssertEqual(ids(.live, "Ashcroft"), [])
        XCTAssertEqual(ids(.archive, "Ashcroft"), ["arch-post"])
    }

    func testWhitespaceOnlyQueryMatchesEverythingRatherThanNothing() {
        XCTAssertEqual(ids(.live, "   "), ["live-quote", "live-photo"])
    }

    func testNoMatchIsEmptyNotEverything() {
        XCTAssertEqual(ids(.live, "kintsugi"), [])
    }

    func testHighlightsAreLiveOnlyAndLeaveTheGrid() async {
        let store = FeedStore(api: MockCoAPI())
        await store.load()

        XCTAssertEqual(store.highlights.count, 1, "one calm focal object, not a stack of billboards")
        XCTAssertTrue(store.highlights.allSatisfy { !$0.isArchived })
        XCTAssertFalse(store.gridItems.contains { $0.isHighlight },
                       "a highlight is lifted out of the masonry, not drawn twice")

        store.mode = .archive
        XCTAssertTrue(store.highlights.isEmpty, "archive makes no recommendations")
    }

    func testTagEditingNormalisesAndDeduplicates() async {
        let store = FeedStore(api: MockCoAPI())
        await store.load()
        let id = store.items.first { $0.isArchived }!.id
        let before = store.item(id: id)!.tags

        // The typed case survives (no forced lowercase); duplicates are judged
        // case-insensitively.
        store.addTag("  Kintsugi  ", to: id)
        XCTAssertEqual(store.item(id: id)?.tags.last, "Kintsugi")
        store.addTag("KINTSUGI", to: id)
        XCTAssertEqual(
            store.item(id: id)?.tags.filter { $0.caseInsensitiveCompare("kintsugi") == .orderedSame }.count, 1)
        store.addTag("   ", to: id)
        XCTAssertEqual(store.item(id: id)?.tags.count, before.count + 1)

        store.removeTag("kintsugi", from: id)
        XCTAssertEqual(store.item(id: id)?.tags, before)
    }

    func testFixturesMeetTheSurfaceContract() {
        let all = FeedFixtures.all
        XCTAssertGreaterThanOrEqual(all.count, 14)
        XCTAssertEqual(Set(all.map(\.id)).count, all.count, "ids must be unique")
        for kind in [FeedItem.Kind.photo, .quote, .podcast, .post] {
            XCTAssertTrue(all.contains { $0.kind == kind }, "missing kind: \(kind)")
        }
        let archived = all.filter(\.isArchived)
        XCTAssertGreaterThanOrEqual(archived.count, 5)
        XCTAssertTrue(all.allSatisfy { (2...4).contains($0.tags.count) },
                      "every item carries 2–4 tags — the detail's tag row needs two minimum")
        XCTAssertTrue(all.allSatisfy { (2...3).contains($0.summary.count) },
                      "the expanded card's body is 2–3 summary bullets; fewer reads blank")
        let highlights = all.filter(\.isHighlight)
        XCTAssertEqual(highlights.count, 1,
                       "Live opens on exactly one highlight so the grid makes the fold")
        XCTAssertTrue(all.filter { $0.kind == .podcast }.allSatisfy { $0.duration != nil },
                      "anything with a runtime carries it — the footer shows nothing else")
        XCTAssertTrue(all.allSatisfy { $0.imageURL == nil }, "this prototype fetches nothing")
    }
}
