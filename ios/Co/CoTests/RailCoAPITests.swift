import XCTest
@testable import Co

private actor RailLoader: HTTPDataLoading {
    private let data: Data
    private let status: Int
    private var capturedRequest: URLRequest?

    init(data: Data, status: Int = 200) {
        self.data = data
        self.status = status
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        capturedRequest = request
        let response = HTTPURLResponse(url: request.url!, statusCode: status,
                                       httpVersion: nil, headerFields: nil)!
        return (data, response)
    }

    func request() -> URLRequest? { capturedRequest }
}

final class RailCoAPITests: XCTestCase {
    private let world = Data(#"""
    {
      "me": {"number": "+1 (555) 100-0999"},
      "catches": [
        {"id":"catch-1","ts":"2026-08-05T18:00:00Z","kind":"link",
         "url":"https://www.youtube.com/watch?v=real","title":"A real watch",
         "text":null,"read":"The part that matters.","thumb":null},
        {"id":"catch-2","ts":"2026-08-04T18:00:00Z","kind":"text",
         "url":null,"title":"A note","text":"something kept","read":null,"thumb":null}
      ],
      "staff": [
        {"ts":"2026-08-06T01:00:00Z","verb":"watched","what":"watched the whole thing",
         "why":"the useful part was late","url":"https://www.youtube.com/watch?v=real"}
      ],
      "radar": {
        "finds": [{"title":"The price changed","url":"https://x.com/example/status/1",
                   "why":"This changes the camera decision."}],
        "watching": ["Sony camera release"]
      }
    }
    """#.utf8)

    func testWorldBecomesRealHomeWithoutFixtureData() throws {
        let home = try RailCoAPI.decodeHome(
            world, baseURL: URL(string: "https://co.example/w/0123456789abcdefabcd")!)

        XCTAssertEqual(home.items.filter { !$0.isArchived }.map(\.title), ["The price changed"])
        XCTAssertEqual(home.items.filter(\.isArchived).count, 2)
        XCTAssertEqual(home.recap.map(\.line), ["watched the whole thing"])
        XCTAssertEqual(home.recap.first?.symbol, Receipt.Verb.watched.glyph)
        XCTAssertEqual(home.watching.map(\.label), ["Sony camera release"])
        XCTAssertEqual(home.messageURL?.absoluteString, "sms:+15551000999")
        XCTAssertFalse(home.items.contains { $0.attribution == "Oliver Burkeman" },
                       "a paired member must never inherit the demo person's life")
    }

    /// A world with no `today` is the commonest real case — the rail computes it per day and
    /// a cache miss legitimately carries none. It must decode to an empty day, not fail.
    func testAWorldWithoutTodayStillDecodesAndDrawsNothing() throws {
        let home = try RailCoAPI.decodeHome(
            world, baseURL: URL(string: "https://co.example/w/0123456789abcdefabcd")!)

        XCTAssertEqual(home.today, .empty)
        XCTAssertTrue(home.today.isEmpty, "an empty Today draws no card at all")
    }

    func testTodayCarriesTheOneThingTheRailAlreadyComputed() throws {
        let withToday = Data(#"""
        {
          "me": {"number": null}, "catches": [], "staff": [],
          "radar": {"finds": [], "watching": []},
          "today": {"read":"the sauna thread","one_thing":"call the mill","done":true}
        }
        """#.utf8)

        let home = try RailCoAPI.decodeHome(
            withToday, baseURL: URL(string: "https://co.example/w/0123456789abcdefabcd")!)

        XCTAssertEqual(home.today.oneThing, "call the mill")
        XCTAssertEqual(home.today.read, "the sauna thread")
        XCTAssertTrue(home.today.done)
        XCTAssertFalse(home.today.isEmpty)
    }

    /// A rail that carries no rooms still has to fill the shelf — source type is the
    /// fallback fold, not the intent.
    func testAWorldWithoutRoomsStillFoldsBySourceType() throws {
        let archive = try RailCoAPI.decodeArchive(world, baseURL: URL(string: "https://rail.example/w/slug")!)
        XCTAssertEqual(archive.total, 2)
        XCTAssertEqual(Set(archive.buckets.map(\.name)), ["youtube", "text"])
        XCTAssertEqual(archive.buckets.flatMap(\.items).map(\.artifactId).sorted(),
                       ["catch-1", "catch-2"])
    }




    /// The world the rail actually serves: rooms present, so the shelves are the member's
    /// own themes — the same ones the web world shows under "your rooms".
    private let worldWithRooms = Data(#"""
    {
      "me": {"number": null},
      "catches": [
        {"id":"catch-1","ts":"2026-08-05T12:00:00Z","kind":"url",
         "url":"https://x.com/example/status/1","title":"tweet @example: the price changed",
         "text":null,"read":null,"thumb":"abc123"},
        {"id":"catch-2","ts":"2026-08-04T12:00:00Z","kind":"text",
         "url":null,"title":"a save no room wanted","text":"a save no room wanted",
         "read":null,"thumb":null}
      ],
      "staff": [],
      "rooms": [
        {"theme":"design inspiration capture","whisper":"price the sauna kit","count":4,
         "members":[
           {"key":"abc123","note":"tweet @example: the price changed",
            "url":"https://x.com/example/status/1","kind":"x","date":"2026-08-05"},
           {"key":"def456","note":"","url":"","kind":"yours","date":"2026-08-03"},
           {"key":"ghi789","note":"","url":"","kind":"yours","date":"2026-08-03"},
           {"key":"","note":"a screenshot the source expired on","url":"","kind":"photo",
            "date":"2026-08-01"}
         ]},
        {"theme":"reminder management","whisper":null,"count":1,
         "members":[
           {"key":null,"note":"remind me in an hour","url":null,"kind":"thought","date":"2026-08-02"}
         ]}
      ],
      "radar": {"finds": [], "watching": []}
    }
    """#.utf8)

    func testRoomsBecomeTheArchiveShelves() throws {
        let archive = try RailCoAPI.decodeArchive(
            worldWithRooms, baseURL: URL(string: "https://rail.example/w/slug")!)

        // Server order is the room order — biggest first — and the app must not reshuffle.
        // The rooms are the WHOLE shelf: `catch-2` belongs to none of them and gets no
        // source-type shelf of its own alongside them.
        XCTAssertEqual(archive.buckets.map(\.name),
                       ["design inspiration capture", "reminder management"])
        XCTAssertEqual(archive.buckets.map(\.itemCount), [4, 1])
        XCTAssertEqual(archive.total, 5)
    }

    /// Two uncaptioned photos in one room are identical on every field the wire carries. If
    /// they key the same, SwiftUI drops one off the shelf and opens the wrong one from the
    /// other — so the id has to separate them.
    func testTwoBlankPhotosInOneRoomAreTwoDifferentTiles() throws {
        let archive = try RailCoAPI.decodeArchive(
            worldWithRooms, baseURL: URL(string: "https://rail.example/w/slug")!)
        let ids = archive.buckets.flatMap(\.items).map(\.artifactId)

        XCTAssertEqual(Set(ids).count, ids.count, "no two tiles may share an id")
    }

    /// A save the rail also lists as a catch keeps the CATCH's id — that is the id FeedStore
    /// holds, and the note field and delete button on a memory both write through it.
    func testASaveOnBothOrgansKeepsTheIdFeedStoreKnows() throws {
        let archive = try RailCoAPI.decodeArchive(
            worldWithRooms, baseURL: URL(string: "https://rail.example/w/slug")!)
        let room = try XCTUnwrap(archive.buckets.first)

        XCTAssertEqual(room.items[0].artifactId, "catch-1")
    }

    func testARoomMemberCarriesItsFaceKindAndText() throws {
        let archive = try RailCoAPI.decodeArchive(
            worldWithRooms, baseURL: URL(string: "https://rail.example/w/slug")!)
        let room = try XCTUnwrap(archive.buckets.first { $0.name == "design inspiration capture" })

        let tweet = room.items[0]
        XCTAssertEqual(tweet.sourceType, "social_post")
        XCTAssertEqual(tweet.title, "the price changed", "the handle is chrome, not the title")
        XCTAssertEqual(tweet.publisher, "@example")
        XCTAssertEqual(tweet.imageURL?.absoluteString, "https://rail.example/w/slug/t/abc123")
        XCTAssertEqual(tweet.capturedAt, "2026-08-05T12:00:00Z")

        // Their own photo is a photo, and carries no title rather than a blank one.
        XCTAssertEqual(room.items[1].sourceType, "image")
        XCTAssertEqual(ArchiveAlbum.kind(for: room.items[1].sourceType), .photo)
        XCTAssertEqual(room.items[1].imageURL?.absoluteString, "https://rail.example/w/slug/t/def456")
        XCTAssertNil(room.items[1].title, "an empty note is no note, not an empty headline")

        // A `photo` whose source expired has no face — it is words, and a photo tile would
        // draw the wash and throw the words away.
        XCTAssertEqual(room.items[3].sourceType, "text")
        XCTAssertNil(room.items[3].imageURL)
        XCTAssertEqual(room.items[3].title, "a screenshot the source expired on")

        let thought = try XCTUnwrap(archive.buckets.first { $0.name == "reminder management" })
        XCTAssertEqual(thought.items[0].sourceType, "text")
        XCTAssertNil(thought.items[0].canonicalUrl)
    }

    func testChatPostsOneTurnToThePrivateRelationship() async throws {
        let loader = RailLoader(data: Data(#"{"ok":true,"reply":"I remember. Wait a month."}"#.utf8))
        let base = URL(string: "https://co.example/w/0123456789abcdefabcd")!
        let api = RailCoAPI(baseURL: base, loader: loader)

        let reply = try await api.chat("should I buy the camera?")

        XCTAssertEqual(reply, "I remember. Wait a month.")
        let captured = await loader.request()
        let request = try XCTUnwrap(captured)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString,
                       "https://co.example/w/0123456789abcdefabcd/chat")
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(json, ["text": "should I buy the camera?"])
    }

    /// The wire key is `isKyo`, not `isCo` — that is what both the rail's `chat.json` and
    /// co-api actually emit. This fixture said `isCo` and so agreed with the client instead
    /// of the server, which is how the Kyo→Co rename broke every real `chatHistory()` call
    /// with a green suite.
    func testRelationshipLinkHydratesItsExistingIMessageTranscript() async throws {
        let loader = RailLoader(data: Data(#"{"messages":[{"id":"rail-1","isKyo":false,"text":"remember this","sentAt":"2026-08-06T12:00:00Z","transport":"sendblue"},{"id":"rail-2","isKyo":true,"text":"i do","sentAt":"2026-08-06T12:01:00Z","transport":"sendblue"}]}"#.utf8))
        let base = URL(string: "https://co.example/w/0123456789abcdefabcd")!
        let api = RailCoAPI(baseURL: base, loader: loader)

        let messages = try await api.chatHistory()

        XCTAssertEqual(messages.first?.text, "remember this")
        XCTAssertEqual(messages.map(\.isCo), [false, true],
                       "the server's isKyo IS the client's isCo — one contract, two names")
        let captured = await loader.request()
        XCTAssertEqual(captured?.url?.absoluteString,
                       "https://co.example/w/0123456789abcdefabcd/chat.json")
    }

    func testTickingTheOneThingPostsDoneAndDropsTheCachedWorld() async throws {
        let loader = RailLoader(data: Data(#"{"ok":true}"#.utf8))
        let base = URL(string: "https://co.example/w/0123456789abcdefabcd")!
        let api = RailCoAPI(baseURL: base, loader: loader)

        try await api.setTodayDone(true)

        let captured = await loader.request()
        XCTAssertEqual(captured?.url?.absoluteString,
                       "https://co.example/w/0123456789abcdefabcd/done")
        XCTAssertEqual(captured?.httpMethod, "POST")
        let body = try XCTUnwrap(captured?.httpBody)
        // A REAL boolean, not the string "true": Python's bool("false") is True, so the
        // string shape made un-ticking silently impossible (fixed 8/9).
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Bool])
        XCTAssertEqual(json, ["done": true])
    }

    func testVoiceAsksTheRailForARoomAndNeverNamesATenant() async throws {
        let loader = RailLoader(data: Data(#"{"serverUrl":"wss://co.livekit.cloud","roomName":"co-voice-p1-abc12345","token":"jwt"}"#.utf8))
        let base = URL(string: "https://co.example/w/0123456789abcdefabcd")!
        let api = RailCoAPI(baseURL: base, loader: loader)

        let config = try await api.voiceSession(history: [])

        XCTAssertEqual(config.serverUrl, "wss://co.livekit.cloud")
        XCTAssertEqual(config.roomName, "co-voice-p1-abc12345")
        XCTAssertEqual(config.token, "jwt")
        let captured = await loader.request()
        XCTAssertEqual(captured?.url?.absoluteString,
                       "https://co.example/w/0123456789abcdefabcd/voice")
        XCTAssertEqual(captured?.httpMethod, "POST")
        XCTAssertNil(captured?.httpBody,
                     "the slug IS the tenant — the app must never name one, or ask for another's room")
    }

    /// The thread does not ride along: the rail's agent reads the same transcript `ask_engine`
    /// writes, so shipping it would hand the server a worse copy of what it already has.
    func testVoiceSendsNoThreadEvenWhenTheChatHasOne() async throws {
        let loader = RailLoader(data: Data(#"{"serverUrl":"wss://x","roomName":"r","token":"t"}"#.utf8))
        let api = RailCoAPI(baseURL: URL(string: "https://co.example/w/0123456789abcdefabcd")!,
                            loader: loader)

        _ = try await api.voiceSession(history: [
            CoChatMessage(id: "1", isCo: false, text: "should I buy the camera?",
                          sentAt: nil, transport: nil),
        ])

        let captured = await loader.request()
        XCTAssertNil(captured?.httpBody)
    }

    /// A rail with no LiveKit grant is a CONFIGURATION state, not a failed call — the orb's
    /// copy should not blame the network for it.
    func testARailWithoutALiveKitGrantIsNotConfiguredRatherThanBroken() async {
        let loader = RailLoader(data: Data(#"{"ok":false,"error":"voice_not_configured"}"#.utf8),
                                status: 503)
        let api = RailCoAPI(baseURL: URL(string: "https://co.example/w/0123456789abcdefabcd")!,
                            loader: loader)

        do {
            _ = try await api.voiceSession(history: [])
            XCTFail("a 503 must not read as a usable session")
        } catch {
            XCTAssertEqual(error as? CoAPIError, .notConfigured)
        }
    }
}
