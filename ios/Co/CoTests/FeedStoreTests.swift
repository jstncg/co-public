import XCTest
@testable import Co

private struct OfflineAPI: CoAPI {
    func home() async throws -> HomeResponse { throw URLError(.notConnectedToInternet) }
    func voiceSession(history: [CoChatMessage] = []) async throws -> VoiceSessionConfig { throw CoAPIError.notConfigured }
    func archiveBuckets() async throws -> ArchiveResponse { throw URLError(.notConnectedToInternet) }
    func chat(_ text: String) async throws -> String { throw URLError(.notConnectedToInternet) }
}

@MainActor
final class FeedStoreTests: XCTestCase {
    func testPairingNeverLeaksTheDemoPersonsLifeAcrossTheIdentityBoundary() async {
        let store = FeedStore(api: MockCoAPI())
        await store.load()
        XCTAssertFalse(store.items.isEmpty)

        await store.connect(to: OfflineAPI())

        XCTAssertTrue(store.items.isEmpty)
        XCTAssertNil(store.messageURL)
        XCTAssertEqual(store.today, .empty)
        XCTAssertEqual(store.lived, .empty)
    }
}
