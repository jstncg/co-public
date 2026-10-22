import XCTest
@testable import Co

/// Archive's search (Justin, 2026-08-03): the field under the Archive title narrows the
/// shelves. `ArchiveAlbum.matching` is the whole rule.
final class ArchiveSearchTests: XCTestCase {
    private func item(_ text: String, tags: [String] = []) -> FeedItem {
        FeedItem(id: text, kind: .post, aspectRatio: 1, imageURL: nil, text: text,
                 attribution: nil, tags: tags, isArchived: true)
    }

    private var albums: [ArchiveAlbum] {
        [ArchiveAlbum(name: "Ceramics", items: [item("Throwing a bowl")]),
         ArchiveAlbum(name: "Craft", items: [item("Building a sauna", tags: ["Heat"])])]
    }

    func testEmptyQueryReturnsEverything() {
        XCTAssertEqual(ArchiveAlbum.matching(albums, query: ""), albums)
        // Whitespace is not a search: typing a space must not blank the grid.
        XCTAssertEqual(ArchiveAlbum.matching(albums, query: "   "), albums)
    }

    func testMatchesOnAlbumName() {
        let hits = ArchiveAlbum.matching(albums, query: "ceram")
        XCTAssertEqual(hits.map(\.name), ["Ceramics"])
    }

    /// The point of the rule: a shelf surfaces because of what is ON it, not only because
    /// of what it is called.
    func testMatchesOnContentsAndOnTags() {
        XCTAssertEqual(ArchiveAlbum.matching(albums, query: "sauna").map(\.name), ["Craft"])
        XCTAssertEqual(ArchiveAlbum.matching(albums, query: "heat").map(\.name), ["Craft"])
    }

    func testCaseInsensitive() {
        XCTAssertEqual(ArchiveAlbum.matching(albums, query: "SAUNA").map(\.name), ["Craft"])
    }

    func testNoMatchReturnsNothing() {
        XCTAssertTrue(ArchiveAlbum.matching(albums, query: "zzz").isEmpty)
    }
}
