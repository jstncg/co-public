import XCTest
@testable import Co

/// The member's half of the flagship loop. The LAWS live server-side (frame/claims/lived.py)
/// and cannot be enforced here — what these check is that the app carries the contract
/// faithfully and, above all, never renders a state that is not true.
final class LivedTests: XCTestCase {
    private func world(lived: String?) -> Data {
        let livedKey = lived.map { ",\n      \"lived\": \($0)" } ?? ""
        return Data("""
        {
          "me": {"number": "+1 (555) 010-0000"},
          "catches": [],
          "staff": [],
          "radar": {"finds": [], "watching": []}\(livedKey)
        }
        """.utf8)
    }

    private let base = URL(string: "https://co.example/w/0123456789abcdefabcd")!

    func testWeekDecodesFromTheRail() throws {
        let home = try RailCoAPI.decodeHome(world(lived: """
        {
          "live": [{"id":"a","state":"live","resonance":"a reel","quality":"a weekly group",
                    "change":"thursday 7-9pm held","undo":"drop the hold",
                    "question":"does it get used","because":"i keep saving these",
                    "url":null,"days":4}],
          "proposed": [{"id":"b","state":"proposed","resonance":"an essay","quality":"a regular",
                        "change":"saturday coffee","undo":"say no and it's gone",
                        "question":"people or place","because":"i want more friends",
                        "url":null,"days":0}],
          "settled": 3, "endorsed": 2
        }
        """), baseURL: base)

        XCTAssertEqual(home.lived.live.count, 1)
        XCTAssertEqual(home.lived.proposed.count, 1)
        XCTAssertEqual(home.lived.endorsed, 2)
        XCTAssertEqual(home.lived.live.first?.change, "thursday 7-9pm held")
        // provenance rides all the way to the card: a wrong read must be catchable at rest
        XCTAssertEqual(home.lived.live.first?.because, "i keep saving these")
        XCTAssertEqual(home.lived.live.first?.state, .live)
    }

    /// A rail that predates the loop simply carries no week. It must not crash the home fetch,
    /// because the feed is the whole app and one missing key cannot take it down.
    func testOlderRailWithoutTheKeyStillDecodes() throws {
        let home = try RailCoAPI.decodeHome(world(lived: nil), baseURL: base)
        XCTAssertTrue(home.lived.isEmpty)
        XCTAssertEqual(home.lived.settled, 0)
    }

    /// An unrecognised server state must not silently become something friendlier. Falling
    /// back to `.live` keeps the undo reachable, which is the safe direction to fail.
    func testUnknownStateFallsBackToLive() throws {
        let home = try RailCoAPI.decodeHome(world(lived: """
        {"live":[{"id":"a","state":"something_new","resonance":"r","quality":"q","change":"c",
                  "undo":"u","question":"?","because":"b","url":null,"days":1}],
         "proposed":[],"settled":0,"endorsed":0}
        """), baseURL: base)
        XCTAssertEqual(home.lived.live.first?.state, .live)
    }

    /// The mock has to MOVE, or the surface cannot be exercised offline and every screenshot
    /// is a lie about what tapping does.
    func testMockInstallsAndUndoesForReal() async throws {
        let api = MockCoAPI()
        let before = try await api.home().lived
        guard let proposal = before.proposed.first else { return XCTFail("no proposal in fixtures") }

        try await api.acceptLived(proposal.id)
        let installed = try await api.home().lived
        XCTAssertTrue(installed.live.contains { $0.id == proposal.id })
        XCTAssertFalse(installed.proposed.contains { $0.id == proposal.id })

        try await api.reverseLived(proposal.id)
        let undone = try await api.home().lived
        XCTAssertFalse(undone.live.contains { $0.id == proposal.id })
        // an undo is not an endorsement — it must never inflate the "worth it" count
        XCTAssertEqual(undone.endorsed, before.endorsed)
        XCTAssertEqual(undone.settled, before.settled + 1)
    }

    /// A backend that cannot carry the member's half must throw, never no-op. Believing you
    /// undid something that is still in effect is the one failure this surface cannot afford.
    func testUnconfiguredBackendRefusesRatherThanPretending() async {
        let api = UnpairedCoAPI()
        do {
            try await api.reverseLived("anything")
            XCTFail("an unconfigured backend must not swallow the tap")
        } catch {
            XCTAssertEqual(error as? CoAPIError, .notConfigured)
        }
    }
}
