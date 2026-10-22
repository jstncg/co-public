import XCTest
@testable import Co

private actor HistoryChatAPI: CoAPI {
    private(set) var historyCalls = 0
    func home() async throws -> HomeResponse {
        HomeResponse(items: [], watching: [], messageURL: nil)
    }
    func voiceSession(history: [CoChatMessage] = []) async throws -> VoiceSessionConfig { throw CoAPIError.notConfigured }
    func archiveBuckets() async throws -> ArchiveResponse { ArchiveResponse(buckets: [], total: 0) }
    func chat(_ text: String) async throws -> String { "right here" }
    func chatHistory() async throws -> [CoChatMessage] {
        historyCalls += 1
        return [
            CoChatMessage(id: "imessage-in", isCo: false, text: "remember this",
                           sentAt: "2026-08-06T12:00:00Z", transport: "sendblue"),
            CoChatMessage(id: "imessage-out", isCo: true, text: "i do",
                           sentAt: "2026-08-06T12:00:01Z", transport: "sendblue"),
        ]
    }
}

/// The ask-Co thread is one relationship across app and iMessage, never a chat list
final class ChatStoreTests: XCTestCase {

    @MainActor
    private func fixtureChat() -> ChatStore {
        ChatStore(api: MockCoAPI(), messages: [])
    }

    @MainActor
    func testAskAppendsTheTrimmedQuestionImmediately() {
        let chat = fixtureChat()
        chat.ask("  where do I start?  ")
        XCTAssertEqual(chat.messages.count, 1)
        XCTAssertEqual(chat.messages.first?.text, "where do I start?")
        XCTAssertEqual(chat.messages.first?.isCo, false)
    }

    @MainActor
    func testABlankAskIsIgnored() {
        let chat = fixtureChat()
        chat.ask("   ")
        XCTAssertTrue(chat.messages.isEmpty)
    }

    @MainActor
    func testTheReplyArrivesAndContinuesTheThread() async throws {
        let chat = fixtureChat()
        chat.ask("sauna suppliers")
        // Await the store's actual work, not a wall clock — no flake, no fixed 1.2s.
        await chat.replyTask?.value
        XCTAssertEqual(chat.messages.count, 2)
        XCTAssertEqual(chat.messages.last?.isCo, true)
        XCTAssertFalse(chat.messages.last?.text.isEmpty == true,
                       "the reply arrives and keeps the thread going")
    }

    @MainActor
    func testExistingIMessageHistoryRefreshesEveryTimeTheThreadOpens() async {
        let api = HistoryChatAPI()
        let chat = ChatStore(api: api, messages: [])

        await chat.loadHistory()
        await chat.loadHistory()

        XCTAssertEqual(chat.messages.map(\.id), ["imessage-in", "imessage-out"])
        XCTAssertEqual(chat.messages.map(\.isCo), [false, true])
        let historyCalls = await api.historyCalls
        XCTAssertEqual(historyCalls, 2)
    }

    @MainActor
    func testTheMessageShapeCarriesAStableCanonicalIdentity() {
        let names = Mirror(reflecting: ChatStore.Message(isCo: false, text: "hi"))
            .children.compactMap(\.label)
        XCTAssertEqual(names, ["id", "isCo", "text"])
    }

    @MainActor
    func testTheThreadThinksBetweenTheAskAndTheReply() async throws {
        let chat = fixtureChat()
        chat.ask("sauna suppliers")
        XCTAssertTrue(chat.isThinking, "the row is up the moment the question lands")
        await chat.replyTask?.value
        XCTAssertFalse(chat.isThinking, "and gone the moment the answer does")
    }

    @MainActor
    func testASecondAskKeepsTheThinkingRowUp() async throws {
        let chat = fixtureChat()
        chat.ask("first")
        chat.ask("second")
        XCTAssertTrue(chat.isThinking, "the cancelled reply must not clear a live question")
        await chat.replyTask?.value
        XCTAssertFalse(chat.isThinking)
        XCTAssertEqual(chat.messages.count, 4, "two asks receive two ordered answers")
    }

    @MainActor
    func testVoiceNeverClaimsWorkBeforeAudioIsConnected() async throws {
        let chat = fixtureChat()
        chat.sendVoice(seconds: 7.4)
        XCTAssertEqual(chat.messages.map(\.text), [ChatStore.voiceUnavailable])
        XCTAssertEqual(chat.messages.map(\.isCo), [true])
    }

    @MainActor
    func testAttachmentNeverClaimsItWasReadBeforeBytesAreConnected() async throws {
        let chat = fixtureChat()
        chat.attach("quotes.pdf")
        XCTAssertEqual(chat.messages.map(\.text), [ChatStore.attachmentUnavailable])
        XCTAssertEqual(chat.messages.map(\.isCo), [true])
    }

    @MainActor
    func testTheMicMapsSilenceToTheFloorAndShoutingToTheCeiling() {
        XCTAssertEqual(VoiceRecorder.level(fromDecibels: 0), 1, accuracy: 0.001)
        XCTAssertEqual(VoiceRecorder.level(fromDecibels: -160), 0, accuracy: 0.001)
        XCTAssertGreaterThan(VoiceRecorder.level(fromDecibels: -10),
                             VoiceRecorder.level(fromDecibels: -30),
                             "louder always reads brighter")
        XCTAssertEqual(VoiceRecorder.level(fromDecibels: -42), 0, accuracy: 0.001,
                       "the floor is where silence sits")
        XCTAssertGreaterThan(VoiceRecorder.level(fromDecibels: -21), 0.5,
                             "conversation at arm's length has to clear half the bar")
    }

    @MainActor
    func testTheTakeReadsAsAClock() {
        XCTAssertEqual(VoiceRecorder.clock(0), "0:00")
        XCTAssertEqual(VoiceRecorder.clock(7.9), "0:07", "a take is as long as it has finished")
        XCTAssertEqual(VoiceRecorder.clock(65), "1:05")
    }

    /// The orb's pull: resistance, no wall, and a stretch that caps.
    func testThePullResistsWithoutEverHittingAWall() {
        XCTAssertEqual(CoPull.band(0, limit: 100), 0)
        XCTAssertEqual(CoPull.band(-40, limit: 100), -CoPull.band(40, limit: 100),
                       "pulling up and pulling down resist identically")
        XCTAssertLessThan(CoPull.band(40, limit: 100), 40, "every point past the finger is resisted")
        XCTAssertLessThan(CoPull.band(10_000, limit: 100), 100, "asymptote, so there is no wall")
        XCTAssertGreaterThan(CoPull.band(200, limit: 100), CoPull.band(100, limit: 100),
                             "further always moves further, just less of it")
    }

    func testTheStretchCapsSoTheBallStaysABall() {
        XCTAssertEqual(CoPull.stretch(for: .zero), 0)
        XCTAssertEqual(CoPull.stretch(for: CGSize(width: 0, height: 10_000)), CoPull.maxStretch)
        XCTAssertEqual(CoPull.stretch(for: CGSize(width: 0, height: CoPull.stretchSpan / 2)),
                       CoPull.maxStretch / 2, accuracy: 0.0001, "linear up to the cap")
    }
}
