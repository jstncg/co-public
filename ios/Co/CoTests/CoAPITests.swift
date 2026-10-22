import XCTest
@testable import Co

/// The network seam. Fixtures stay usable when explicitly selected; unpaired and canonical clients
/// refuse capabilities they cannot fulfill rather than fabricating them.
final class CoAPITests: XCTestCase {

    func testMockAPIReturnsAUsableVoiceConfig() async throws {
        let config = try await MockCoAPI().voiceSession()
        XCTAssertFalse(config.serverUrl.isEmpty)
        XCTAssertFalse(config.roomName.isEmpty)
        XCTAssertFalse(config.token.isEmpty)
    }

    func testMockChatAnswersInCosRegister() async throws {
        let reply = try await MockCoAPI().chat("sauna suppliers")
        XCTAssertFalse(reply.isEmpty)
        XCTAssertLessThan(reply.count, 160,
                          "Co's register is short — the mock should not announce a research job")
    }

    func testUnpairedAPIRefusesChatRatherThanFabricate() async throws {
        do {
            _ = try await UnpairedCoAPI().chat("hello")
            XCTFail("an unpaired build must not pretend it can talk")
        } catch {
            XCTAssertEqual(error as? CoAPIError, .notConfigured)
        }
    }

    func testEveryPairedClientClaimsANativeConversation() {
        XCTAssertTrue(MockCoAPI().supportsInAppChat)
        XCTAssertTrue(RailCoAPI(baseURL: URL(string: "https://co.example/w/0123456789abcdefabcd")!)
            .supportsInAppChat)
        XCTAssertFalse(UnpairedCoAPI().supportsInAppChat)
        XCTAssertTrue(LiveCoAPI(baseURL: URL(string: "https://co.example")!)
            .supportsInAppChat)
    }

    func testMockAPIReturnsTheWholeHome() async throws {
        let home = try await MockCoAPI().home()
        XCTAssertEqual(home.items, FeedFixtures.all)
        XCTAssertEqual(home.watching, HomeFixtures.watches)
        XCTAssertNil(home.messageURL, "the demo must never point at a real conversation")
    }

    func testUnpairedAPINeverLeaksFixturesOrPretendsVoiceExists() async throws {
        let api = UnpairedCoAPI()
        let home = try await api.home()
        let archive = try await api.archiveBuckets()
        XCTAssertTrue(home.items.isEmpty)
        XCTAssertTrue(home.watching.isEmpty)
        XCTAssertNil(home.messageURL)
        XCTAssertEqual(archive.total, 0)
        do {
            _ = try await api.voiceSession()
            XCTFail("an unpaired build must not mint a mock call")
        } catch {
            XCTAssertEqual(error as? CoAPIError, .notConfigured)
        }
    }

    func testMockAPIReturnsBucketedArchive() async throws {
        let response = try await MockCoAPI().archiveBuckets()
        XCTAssertEqual(response.total, FeedFixtures.all.count)
        XCTAssertFalse(response.buckets.isEmpty)
        // Buckets speak the server's source_type vocabulary, one name per shelf.
        let names = Set(response.buckets.map(\.name))
        XCTAssertTrue(names.isSubset(of: ["image", "text", "podcast", "social_post"]))
        // Size desc, then name — deterministic order, like the server's.
        let sizes = response.buckets.map(\.itemCount)
        XCTAssertEqual(sizes, sizes.sorted(by: >))
    }

    func testLiveAPIRefusesWithoutAToken() async {
        let api = LiveCoAPI(baseURL: URL(string: "https://example.invalid")!, accessToken: { nil })
        do {
            _ = try await api.voiceSession()
            XCTFail("expected CoAPIError.unauthorized, got a config")
        } catch {
            XCTAssertEqual(error as? CoAPIError, .unauthorized)
        }
    }

    func testLiveArchiveRefusesWithoutAToken() async {
        let api = LiveCoAPI(baseURL: URL(string: "https://example.invalid")!, accessToken: { nil })
        do {
            _ = try await api.archiveBuckets()
            XCTFail("expected CoAPIError.unauthorized, got buckets")
        } catch {
            XCTAssertEqual(error as? CoAPIError, .unauthorized)
        }
    }
}
