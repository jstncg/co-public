import Foundation

/// Everything the app asks of the server goes through here. Fixtures are an explicit
/// launch mode; production startup never silently selects the mock.
protocol CoAPI: Sendable {
    /// Only the private rail currently keeps app and iMessage turns in one transcript.
    var supportsInAppChat: Bool { get }
    func home() async throws -> HomeResponse
    func voiceSession(history: [CoChatMessage]) async throws -> VoiceSessionConfig
    func archiveBuckets() async throws -> ArchiveResponse
    /// The same engine call the iMessage thread makes — app chat and texting Co stay
    /// one conversation.
    func chat(_ text: String) async throws -> String
    func chatHistory() async throws -> [CoChatMessage]

    // The member's half of the flagship loop (frame/claims/lived.py, LAWS 2–4).
    func acceptLived(_ id: String) async throws
    func declineLived(_ id: String) async throws
    func reverseLived(_ id: String) async throws
    func verdictLived(_ id: String, value: LivedVerdict, words: String) async throws

    func setTodayDone(_ done: Bool) async throws

    /// The trash, made true on the server — a local array removal resurrects on the
    /// next fetch.
    func forgetArtifact(_ id: String) async throws
}

/// Defaults throw LOUDLY rather than swallow the tap — silently succeeding would let
/// the member believe they undid something still in effect.
extension CoAPI {
    var supportsInAppChat: Bool { false }
    func chatHistory() async throws -> [CoChatMessage] { [] }
    func acceptLived(_ id: String) async throws { throw CoAPIError.notConfigured }
    func declineLived(_ id: String) async throws { throw CoAPIError.notConfigured }
    func reverseLived(_ id: String) async throws { throw CoAPIError.notConfigured }
    func verdictLived(_ id: String, value: LivedVerdict, words: String) async throws {
        throw CoAPIError.notConfigured
    }
    func setTodayDone(_ done: Bool) async throws { throw CoAPIError.notConfigured }
    func forgetArtifact(_ id: String) async throws { throw CoAPIError.notConfigured }
}

struct CoChatMessage: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let isCo: Bool
    let text: String
    let sentAt: String?
    let transport: String?

    /// The wire still says `isKyo` (both servers emit it, older builds decode it) — the
    /// Kyo→Co rename moved the Swift property but not the contract.
    enum CodingKeys: String, CodingKey {
        case id
        case isCo = "isKyo"
        case text
        case sentAt
        case transport
    }
}

struct HomeResponse: Equatable, Sendable {
    let items: [FeedItem]
    let watching: [WatchItem]
    /// Data, not UI policy — the shell decides when to hand back to iMessage.
    let messageURL: URL?
    var lived: LivedState = .empty
    var today: TodayState = .empty
    /// Defaulted empty, and every backend but the rail leaves them so: empty is what an older
    /// rail (or the unpaired API) genuinely has, and it is the signal the stores read as
    /// "keep what you were seeded with" rather than blank the screen.
    var forYou: [ForYouItem] = []
    var recap: [RecapItem] = []
    var profile: [ProfileFact] = []
}

/// The rail's daily prep (claims/wrapped.py `_today`), cached per day server-side — a
/// cache miss is a genuinely empty day, not an error.
struct TodayState: Equatable, Sendable {
    var oneThing: String?
    var read: String?
    var done: Bool = false
    /// The thread that moved overnight — name, the line that advanced it, where it leads.
    var overnightThread: String?
    var overnightLine: String?
    var overnightURL: URL?

    static let empty = TodayState()

    var isEmpty: Bool {
        (oneThing ?? "").isEmpty && (read ?? "").isEmpty && (overnightLine ?? "").isEmpty
    }
}

/// Mirrors packages/contracts/src/archive.ts. A bucket is one of the member's rooms;
/// source-type shelves are the fallback where no rooms exist (fixtures, older rails).
struct ArchiveItem: Codable, Equatable, Sendable {
    let artifactId: String
    let sourceType: String
    let canonicalUrl: String?
    let title: String?
    let publisher: String?
    let capturedAt: String
    /// Absent means derive from source_type (words square, a screenshot tall, video 16:9).
    var aspectRatio: CGFloat? = nil
    var imageURL: URL? = nil
}

struct ArchiveBucket: Codable, Equatable, Sendable {
    let name: String
    let itemCount: Int
    let items: [ArchiveItem]
}

struct ArchiveResponse: Codable, Equatable, Sendable {
    let buckets: [ArchiveBucket]
    let total: Int

    /// Biggest first then alphabetical — the fallback shape when a backend has no rooms.
    static func bySourceType(_ items: [ArchiveItem]) -> ArchiveResponse {
        let buckets = Dictionary(grouping: items, by: \.sourceType)
            .map { ArchiveBucket(name: $0.key, itemCount: $0.value.count, items: $0.value) }
            .sorted { ($1.itemCount, $0.name) < ($0.itemCount, $1.name) }
        return ArchiveResponse(buckets: buckets, total: items.count)
    }
}

/// The token IS the identity story — LiveKit signs it server-side, so there is no
/// separate grant to verify and no secret the app ever holds.
struct VoiceSessionConfig: Codable, Sendable, Equatable {
    let serverUrl: String
    let roomName: String
    let token: String
}

enum CoAPIError: Error, Equatable {
    case notConfigured
    case unauthorized
    case server(Int)
}

/// Deterministic, offline — every screen renders without a network.
final class MockCoAPI: CoAPI, @unchecked Sendable {
    let supportsInAppChat = true

    func home() async throws -> HomeResponse {
        HomeResponse(items: FeedFixtures.all,
                     watching: HomeFixtures.watches,
                     messageURL: nil,
                     lived: await DemoLivedStore.shared.state,
                     today: HomeSummaryFixtures.today)
    }

    func setTodayDone(_ done: Bool) async throws {}
    func forgetArtifact(_ id: String) async throws {}

    // The mock moves its own state so it's exercisable offline — accept really installs,
    // undo really removes.
    func acceptLived(_ id: String) async throws { await DemoLivedStore.shared.accept(id) }
    func declineLived(_ id: String) async throws { await DemoLivedStore.shared.decline(id) }
    func reverseLived(_ id: String) async throws { await DemoLivedStore.shared.settle(id, endorsed: false) }
    func verdictLived(_ id: String, value: LivedVerdict, words: String) async throws {
        await DemoLivedStore.shared.settle(id, endorsed: value == .chosen)
    }

    /// Deliberately unreachable, so voice mode exercises its real failure path offline.
    func voiceSession(history: [CoChatMessage] = []) async throws -> VoiceSessionConfig {
        VoiceSessionConfig(serverUrl: "wss://mock.livekit.cloud",
                           roomName: "co-voice-mock",
                           token: "mock")
    }

    func chat(_ text: String) async throws -> String {
        "Yeah, that's one to sit with. I'll keep it in mind and we can pick it back up."
    }

    func archiveBuckets() async throws -> ArchiveResponse {
        let items: [ArchiveItem] = FeedFixtures.all.map { item in
            ArchiveItem(artifactId: item.id,
                        sourceType: Self.sourceType(for: item.kind),
                        canonicalUrl: item.url?.absoluteString,
                        title: item.title,
                        publisher: item.attribution,
                        capturedAt: timestamp.string(from: item.savedAt),
                        aspectRatio: item.kind == .quote ? 1 : item.aspectRatio)
        }
        return .bySourceType(items)
    }

    /// Instance, not static — building a formatter per item is the waste this avoids,
    /// and static would trip Swift 6's Sendable rules.
    private let timestamp = ISO8601DateFormatter()

    private static func sourceType(for kind: FeedItem.Kind) -> String {
        switch kind {
        case .photo: return "image"
        case .quote: return "text"
        case .podcast: return "podcast"
        case .post: return "social_post"
        }
    }
}

/// Honest first paint for an installed-but-not-yet-linked TestFlight build.
final class UnpairedCoAPI: CoAPI, @unchecked Sendable {
    func home() async throws -> HomeResponse {
        HomeResponse(items: [], watching: [], messageURL: nil)
    }

    func voiceSession(history: [CoChatMessage] = []) async throws -> VoiceSessionConfig {
        throw CoAPIError.notConfigured
    }

    func chat(_ text: String) async throws -> String {
        throw CoAPIError.notConfigured
    }

    func archiveBuckets() async throws -> ArchiveResponse {
        ArchiveResponse(buckets: [], total: 0)
    }
}

final class LiveCoAPI: CoAPI, @unchecked Sendable {
    let supportsInAppChat = true

    private struct HistoryResponse: Decodable, Sendable {
        struct Catch: Decodable, Sendable {
            let artifactId: String
            let sourceType: String
            let canonicalUrl: String?
            let title: String?
            let publisher: String?
            let textPreview: String?
            let capturedAt: String
        }
        let catches: [Catch]
    }

    private struct RadarResponse: Decodable, Sendable {
        struct Item: Decodable, Sendable {
            let id: String
            let title: String
            let summary: String?
            let url: String
            let publishedAt: String
            let eventType: String
            let whyYou: String
            let watchName: String
        }
        let items: [Item]
    }

    private let baseURL: URL
    private let accessToken: @Sendable () async -> String?

    init(baseURL: URL,
         accessToken: @escaping @Sendable () async -> String? = { nil },
         allowAnonymous: Bool = false) {
        self.baseURL = baseURL
        self.accessToken = accessToken
        self.allowAnonymous = allowAnonymous
    }

    /// Dev-bypass twin of the server's VOICE_DEV_USER_ID — with no app sign-in yet, the
    /// request goes out bare and the server decides.
    private let allowAnonymous: Bool

    func home() async throws -> HomeResponse {
        async let history: HistoryResponse = get("api/v1/history")
        async let radar: RadarResponse = get("api/v1/radar")
        async let phone: PhoneLinkStatus = get("api/v1/phone-link")
        let (historyValue, radarValue, phoneValue) = try await (history, radar, phone)

        let live = radarValue.items.enumerated().map { index, item in
            FeedItem(id: item.id,
                     kind: Self.kind(sourceType: item.eventType),
                     aspectRatio: 1,
                     imageURL: nil,
                     text: item.title,
                     attribution: URL(string: item.url)?.host,
                     summary: [item.summary, item.whyYou].compactMap { value in
                         guard let value, !value.isEmpty else { return nil }
                         return value
                     },
                     url: URL(string: item.url),
                     savedAt: Self.date(item.publishedAt),
                     source: item.eventType,
                     isHighlight: index == 0,
                     isFind: true)
        }
        let catches = historyValue.catches.map(Self.feedItem)
        let watches = Dictionary(grouping: radarValue.items, by: \.watchName).map { name, items in
            WatchItem(id: Self.stableID("watch:\(name)"), label: name,
                      note: items.first?.whyYou ?? "")
        }.sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
        return HomeResponse(items: live + catches, watching: watches,
                            messageURL: phoneValue.messageURL)
    }

    func voiceSession(history: [CoChatMessage] = []) async throws -> VoiceSessionConfig {
        let token = await accessToken()
        if token == nil && !allowAnonymous { throw CoAPIError.unauthorized }
        var request = URLRequest(url: baseURL.appending(path: "api/v1/voice/session"))
        request.httpMethod = "POST"
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        // The call opens already knowing the thread; a blank thread sends no body.
        if !history.isEmpty {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(["session": Array(history.suffix(12))])
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 201 else { throw CoAPIError.server(code) }
        return try JSONDecoder().decode(VoiceSessionConfig.self, from: data)
    }

    func chat(_ text: String) async throws -> String {
        struct Reply: Decodable, Sendable { let reply: String }
        let body = [
            "text": text,
            "turnId": UUID().uuidString.lowercased(),
        ]
        var lastError: Error = CoAPIError.notConfigured
        for attempt in 0..<6 {
            do {
                let turn: Reply = try await post("api/v1/chat", body: body)
                return turn.reply
            } catch {
                lastError = error
                let retryable: Bool
                if let apiError = error as? CoAPIError,
                   case .server(let code) = apiError {
                    retryable = [409, 502, 503, 504].contains(code)
                } else {
                    retryable = error is URLError
                }
                guard retryable, attempt < 5 else { throw error }
                try await Task.sleep(for: .milliseconds(500 * (attempt + 1)))
            }
        }
        throw lastError
    }

    func chatHistory() async throws -> [CoChatMessage] {
        struct History: Decodable, Sendable { let messages: [CoChatMessage] }
        let history: History = try await get("api/v1/chat/history")
        return history.messages
    }

    func archiveBuckets() async throws -> ArchiveResponse {
        let history: HistoryResponse = try await get("api/v1/history")
        let items = history.catches.map { item in
            ArchiveItem(artifactId: item.artifactId,
                        sourceType: item.sourceType,
                        canonicalUrl: item.canonicalUrl,
                        title: item.title ?? item.textPreview,
                        publisher: item.publisher,
                        capturedAt: item.capturedAt)
        }
        return .bySourceType(items)
    }

    private func get<Response: Decodable>(_ path: String) async throws -> Response {
        let token = await accessToken()
        if token == nil && !allowAnonymous { throw CoAPIError.unauthorized }
        var request = URLRequest(url: baseURL.appending(path: path))
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw CoAPIError.server(code) }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private func post<Response: Decodable>(_ path: String,
                                            body: [String: String]) async throws -> Response {
        let token = await accessToken()
        if token == nil && !allowAnonymous { throw CoAPIError.unauthorized }
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(TimeZone.current.identifier, forHTTPHeaderField: "X-Co-Timezone")
        request.timeoutInterval = 210
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw CoAPIError.server(code) }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private static func feedItem(_ item: HistoryResponse.Catch) -> FeedItem {
        FeedItem(id: item.artifactId,
                 kind: kind(sourceType: item.sourceType),
                 aspectRatio: 1,
                 imageURL: nil,
                 text: item.title ?? item.textPreview,
                 attribution: item.publisher,
                 url: item.canonicalUrl.flatMap(URL.init(string:)),
                 savedAt: date(item.capturedAt),
                 source: item.sourceType,
                 isArchived: true)
    }

    private static func kind(sourceType: String) -> FeedItem.Kind {
        switch sourceType {
        case "image", "screenshot": return .photo
        case "youtube", "podcast", "short_video", "video": return .podcast
        case "text", "voice", "document": return .quote
        default: return .post
        }
    }

    private static func date(_ raw: String) -> Date {
        CoFormat.date(raw) ?? .distantPast
    }

    private static func stableID(_ value: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in value.utf8 { hash = (hash ^ UInt64(byte)) &* 0x100000001b3 }
        return String(format: "%016llx", hash)
    }
}
