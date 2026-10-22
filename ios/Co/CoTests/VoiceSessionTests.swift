import XCTest
@testable import Co

/// The server refusing to mint a room. The mock's unreachable URL fails at connect time instead,
/// which is slower and network-shaped — this fails at the seam, deterministically.
private struct FailingAPI: CoAPI {
    func home() async throws -> HomeResponse { throw CoAPIError.unauthorized }
    func voiceSession(history: [CoChatMessage] = []) async throws -> VoiceSessionConfig { throw CoAPIError.unauthorized }
    func archiveBuckets() async throws -> ArchiveResponse { throw CoAPIError.unauthorized }
    func chat(_ text: String) async throws -> String { throw CoAPIError.unauthorized }
}

@MainActor
final class VoiceSessionTests: XCTestCase {
    func testStartsIdle() {
        XCTAssertEqual(VoiceSession(api: MockCoAPI()).phase, .idle)
    }

    func testRefusedSessionSurfacesFailureNotSilence() async {
        let session = VoiceSession(api: FailingAPI())
        await session.start()
        guard case .failed = session.phase else {
            return XCTFail("expected .failed, got \(session.phase)")
        }
    }

    func testEndReturnsToIdle() async {
        let session = VoiceSession(api: FailingAPI())
        await session.start()
        session.end()
        XCTAssertEqual(session.phase, .idle)
        XCTAssertEqual(session.level, 0)
    }
}
