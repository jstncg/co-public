import XCTest
@testable import Co

/// The archive's live mapping (Justin, 2026-08-05): a server bucket becomes a shelf, and the
/// tile's look is a pure function of the server's source_type. Everything else on this surface
/// is layout, which the screenshot gate owns.
final class ArchiveMappingTests: XCTestCase {

    private func item(_ id: String, sourceType: String, title: String? = nil,
                      publisher: String? = nil, url: String? = nil,
                      capturedAt: String = "2026-07-20T19:00:00Z") -> ArchiveItem {
        ArchiveItem(artifactId: id, sourceType: sourceType, canonicalUrl: url,
                    title: title, publisher: publisher, capturedAt: capturedAt)
    }

    func testBucketBecomesShelfInServerOrder() {
        let bucket = ArchiveBucket(name: "image", itemCount: 2, items: [
            item("1", sourceType: "image", title: "pottery reel"),
            item("2", sourceType: "image", title: "dinner"),
        ])
        let album = ArchiveAlbum(bucket: bucket)
        XCTAssertEqual(album.name, "images", "wire keys are humanized for the shelf title")
        XCTAssertEqual(album.items.map(\.id), ["1", "2"])
    }

    func testSourceTypeMapsToTileKind() {
        XCTAssertEqual(ArchiveAlbum.kind(for: "image"), .photo)
        XCTAssertEqual(ArchiveAlbum.kind(for: "screenshot"), .photo)
        XCTAssertEqual(ArchiveAlbum.kind(for: "voice"), .quote)
        XCTAssertEqual(ArchiveAlbum.kind(for: "call"), .quote)
        XCTAssertEqual(ArchiveAlbum.kind(for: "youtube"), .podcast)
        XCTAssertEqual(ArchiveAlbum.kind(for: "podcast"), .podcast)
        XCTAssertEqual(ArchiveAlbum.kind(for: "short_video"), .podcast)
        // Anything else is a text post — the commonest case.
        XCTAssertEqual(ArchiveAlbum.kind(for: "url"), .post)
        XCTAssertEqual(ArchiveAlbum.kind(for: "article"), .post)
        XCTAssertEqual(ArchiveAlbum.kind(for: "social_post"), .post)
        XCTAssertEqual(ArchiveAlbum.kind(for: "text"), .post)
    }

    func testItemCarriesTitlePublisherAndURL() {
        let album = ArchiveAlbum(bucket: ArchiveBucket(name: "article", itemCount: 1, items: [
            item("3", sourceType: "article", title: "A useful source",
                 publisher: "Example", url: "https://example.com/source"),
        ]))
        XCTAssertEqual(album.items[0].title, "A useful source")
        XCTAssertEqual(album.items[0].attribution, "Example")
        XCTAssertEqual(album.items[0].url?.absoluteString, "https://example.com/source")
        XCTAssertEqual(album.items[0].source, "article")
    }

    func testItemsSortNewestFirst() {
        let bucket = ArchiveBucket(name: "voice", itemCount: 2, items: [
            item("1", sourceType: "voice", title: "old", capturedAt: "2026-07-20T19:00:00Z"),
            item("2", sourceType: "voice", title: "new", capturedAt: "2026-07-22T09:00:00Z"),
        ])
        let album = ArchiveAlbum(bucket: bucket)
        // The server already orders by captured_at desc; the app must not re-shuffle.
        XCTAssertEqual(album.items.map(\.title), ["old", "new"])
    }

    /// Ported with `ArchiveAlbum.shelfName` from main@1e9033d — this branch retires ProfileView,
    /// which is where both used to live.
    func testWireKeysNeverRenderAsShelfTitles() {
        XCTAssertEqual(ArchiveAlbum.shelfName("social_post"), "posts")
        XCTAssertEqual(ArchiveAlbum.shelfName("short_video"), "clips")
        XCTAssertEqual(ArchiveAlbum.shelfName("voice"), "voice notes")
        // Unknown keys still lose their underscores.
        XCTAssertEqual(ArchiveAlbum.shelfName("live_stream"), "live stream")
        // Room themes pass through untouched.
        XCTAssertEqual(ArchiveAlbum.shelfName("design inspiration capture"),
                       "design inspiration capture")
    }
}
