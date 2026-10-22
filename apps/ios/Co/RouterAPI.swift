// RouterAPI.swift — the real CoAPI client, speaking to the homebase router.
//
// Pairing is the wrapped link: the user pastes their /w/<slug> URL (co texts it to them),
// which is both address and credential (HMAC slug, unguessable). Stored in the app group
// so the share extension's outbox drains through the same identity.
//
// Endpoints (frame/claims/wrapped.py + sendblue_router.py):
//   GET  <link>/app.json   → the whole state: me / catches / radar
//   POST <link>/capture    → CapturePayload → journal.capture (one memory, three doors)
//   POST <link>/verdict    → pattern verdicts + radar mutes/saves (the reward stream)

import Foundation

// MARK: - pairing

enum Pairing {
    static let defaultsKey = "coPairedLink"

    static var store: UserDefaults {
        UserDefaults(suiteName: Outbox.appGroupID) ?? .standard
    }

    /// the /w/<slug> base URL, or nil when unpaired (demo mode).
    static var link: URL? {
        get {
            guard let s = store.string(forKey: defaultsKey), let u = URL(string: s) else { return nil }
            return u
        }
    }

    static func set(_ url: URL?) {
        store.set(url?.absoluteString, forKey: defaultsKey)
    }

    /// accepts a pasted wrapped link and normalizes it to the /w/<slug> base.
    static func normalize(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let u = URL(string: trimmed), let host = u.host, !host.isEmpty else { return nil }
        let parts = u.path.split(separator: "/").map(String.init)
        guard parts.count >= 2, parts[0] == "w", parts[1].count == 20 else { return nil }
        var c = URLComponents()
        c.scheme = u.scheme ?? "https"
        c.host = host
        c.path = "/w/\(parts[1])"
        return c.url
    }
}

// MARK: - wire DTOs (mirror wrapped.app_state)

private struct WireState: Decodable, Sendable {
    struct Pattern: Decodable, Sendable {
        var read: String
        var receipts: [String]
        var alternative: String?
    }
    struct Me: Decodable, Sendable {
        var orbit: [String]
        var goals: [String]
        var patterns: [Pattern]
        var watching: [String]
        var aim: String?
        var n: Int
        var span: [String]
        var number: String?
    }
    struct Catch: Decodable, Sendable {
        var id: String
        var ts: String
        var kind: String
        var url: String?
        var title: String?
        var text: String?
        var read: String?
        var thumb: String?
    }
    struct Today: Decodable, Sendable {
        var read: String?
        var one_thing: String?
        var setup: [String]?
        var then: String?
        var done: Bool?
    }
    struct Overnight: Decodable, Sendable {
        var thread: String?
        var line: String?
        var url: String?
    }
    struct Find: Decodable, Sendable {
        var title: String
        var url: String
        var why: String
    }
    struct Radar: Decodable, Sendable {
        var finds: [Find]
        var watching: [String]
    }
    struct Room: Decodable, Sendable {
        struct Member: Decodable, Sendable {
            var key: String?
            var note: String
            var url: String?
            var kind: String
            var date: String?
        }
        var theme: String
        var whisper: String?
        var count: Int
        var members: [Member]
    }
    struct Staff: Decodable, Sendable {
        var ts: String
        var verb: String
        var what: String
        var why: String?
        var url: String?
    }
    struct Lived: Decodable, Sendable {
        struct Test: Decodable, Sendable {
            var id: String
            var state: String
            var resonance: String
            var quality: String
            var change: String
            var undo: String
            var question: String
            var because: String
            var url: String?
            var days: Int
        }
        var live: [Test]
        var proposed: [Test]
        var settled: Int
        var endorsed: Int
    }
    var me: Me
    var today: Today?
    var overnight: Overnight?
    var catches: [Catch]
    var radar: Radar
    var rooms: [Room]?
    var staff: [Staff]?
    var lived: Lived?
}

// MARK: - client

private actor StateCache {
    private var cached: WireState?
    private var fetchedAt: Date?

    func get(ttl: TimeInterval, fetch: @Sendable () async throws -> WireState) async throws -> WireState {
        if let c = cached, let t = fetchedAt, Date().timeIntervalSince(t) < ttl { return c }
        let s = try await fetch()
        cached = s
        fetchedAt = Date()
        return s
    }

    func invalidate() {
        fetchedAt = nil
    }
}

final class RouterAPI: CoAPI, Sendable {
    private let base: URL
    private let session: URLSession
    private let cache = StateCache()

    init(base: URL) {
        self.base = base
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 45
        self.session = URLSession(configuration: cfg)
    }

    /// paired client, or nil → caller falls back to demo mode.
    static func paired() -> RouterAPI? {
        guard let link = Pairing.link else { return nil }
        return RouterAPI(base: link)
    }

    // one fetch feeds all four surfaces; 60s of reuse keeps tab-hopping instant.
    private func state() async throws -> WireState {
        let base = self.base
        let session = self.session
        return try await cache.get(ttl: 60) {
            let (data, resp) = try await session.data(from: base.appendingPathComponent("app.json"))
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            return try JSONDecoder().decode(WireState.self, from: data)
        }
    }

    // ISO8601DateFormatter is documented thread-safe (unlike DateFormatter) — the
    // annotation states what Apple's docs promise.
    nonisolated(unsafe) private static let iso = ISO8601DateFormatter()

    func fetchCatches() async throws -> [Moment] {
        let s = try await state()
        return s.catches.map { c in
            let url = c.url.flatMap(URL.init(string:))
            let kind: SourceType = {
                if c.kind == "voice" { return .voice }
                guard let h = url?.host?.lowercased() else { return .text }
                if h.contains("youtu") { return .youtube }
                if h.contains("instagram") || h.contains("tiktok") { return .shortVideo }
                if h.contains("x.com") || h.contains("twitter") { return .socialPost }
                return .url
            }()
            var facets: Set<CatchFacet> = [.all]
            if kind == .voice { facets.insert(.voice) }
            if kind == .youtube || kind == .shortVideo { facets.insert(.media) }
            return Moment(
                id: UUID(uuidString: c.id) ?? UUID(),
                userID: nil, sourceType: kind, sourceApp: nil,
                canonicalURL: url, title: c.title, publisher: nil, creator: nil,
                publishedAt: nil,
                capturedAt: Self.iso.date(from: c.ts) ?? .now,
                rawObjectPath: nil, mimeType: nil,
                rawText: c.text, transcript: c.read,
                thumbnailPath: c.thumb.map { base.appendingPathComponent("t/\($0)").absoluteString },
                duration: nil, timestampSeconds: nil,
                userNote: nil, retentionMode: nil,
                coverage: (c.read != nil && !(c.read ?? "").isEmpty) ? .text : .urlOnly,
                whySignal: nil, facets: facets)
        }
    }

    func fetchPatterns() async throws -> [PatternCard] {
        let s = try await state()
        // receipts are DATES from the stream; map them to the catches captured that day so the
        // detail screen shows the actual evidence (character.md law 3).
        let byDay = Dictionary(grouping: s.catches) { String($0.ts.prefix(10)) }
        return s.me.patterns.map { p in
            let ids = p.receipts.flatMap { day in
                (byDay[day] ?? []).compactMap { UUID(uuidString: $0.id) }
            }
            return PatternCard(
                id: UUID(uuidString: stableUUID("pattern:" + p.read)) ?? UUID(),
                title: String(p.read.prefix(56)),
                momentCount: ids.count,
                statusLine: "\(p.receipts.count) receipts · a hypothesis, tell co if it's wrong",
                currentRead: p.read,
                receiptMomentIDs: Array(ids.prefix(6)),
                alternatives: [p.alternative].compactMap { $0 }.filter { !$0.isEmpty })
        }
    }

    func fetchRadar() async throws -> RadarState {
        let s = try await state()
        let items = s.radar.finds.map { f in
            RadarItem(
                id: UUID(uuidString: stableUUID("find:" + f.url)) ?? UUID(),
                headline: f.title,
                whyReachedYou: [f.why],
                sourceLabel: URL(string: f.url)?.host ?? "the web",
                sourceURL: URL(string: f.url),
                publishedAgo: "this week")
        }
        return RadarState(newItems: items, waiting: [], watching: s.radar.watching)
    }

    func search(_ q: String) async throws -> [Moment] {
        guard var comps = URLComponents(url: base.appendingPathComponent("search"), resolvingAgainstBaseURL: false) else { return [] }
        comps.queryItems = [URLQueryItem(name: "q", value: q)]
        guard let u = comps.url else { return [] }
        struct R: Decodable { var results: [WireState.Catch] }
        let (data, _) = try await session.data(from: u)
        let r = try JSONDecoder().decode(R.self, from: data)
        return r.results.map { c in
            Moment(
                id: UUID(uuidString: c.id) ?? UUID(), userID: nil,
                sourceType: c.kind == "voice" ? .voice : (c.url != nil ? .url : .text),
                sourceApp: nil, canonicalURL: c.url.flatMap(URL.init(string:)),
                title: c.title, publisher: nil, creator: nil, publishedAt: nil,
                capturedAt: Self.iso.date(from: c.ts) ?? .now,
                rawObjectPath: nil, mimeType: nil, rawText: c.text, transcript: c.read,
                thumbnailPath: c.thumb.map { base.appendingPathComponent("t/\($0)").absoluteString },
                duration: nil, timestampSeconds: nil, userNote: nil, retentionMode: nil,
                coverage: .text, whySignal: nil, facets: [.all])
        }
    }

    func fetchToday() async throws -> TodayModel {
        let s = try await state()
        let t = s.today
        return TodayModel(read: t?.read, oneThing: t?.one_thing,
                          setup: t?.setup ?? [], then: t?.then, done: t?.done ?? false)
    }

    func fetchOvernight() async throws -> OvernightModel? {
        let s = try await state()
        guard let o = s.overnight, let line = o.line, !line.isEmpty else { return nil }
        return OvernightModel(thread: o.thread, line: line, url: o.url)
    }

    func fetchLived() async throws -> LivedState {
        let s = try await state()
        func map(_ t: WireState.Lived.Test) -> LivedTest {
            LivedTest(id: t.id, state: LivedTestState(rawValue: t.state) ?? .live,
                      resonance: t.resonance, quality: t.quality, change: t.change,
                      undo: t.undo, question: t.question, because: t.because,
                      url: t.url.flatMap(URL.init(string:)), days: t.days)
        }
        guard let l = s.lived else { return LivedState(live: [], proposed: [], settled: 0, endorsed: 0) }
        return LivedState(live: l.live.map(map), proposed: l.proposed.map(map),
                          settled: l.settled, endorsed: l.endorsed)
    }

    /// The member installs it. co proposed; only this makes it real (lived.py LAW 2).
    func acceptLived(_ id: String) async throws { try await post("lived", json: ["action": "accept", "id": id]) }
    func declineLived(_ id: String) async throws { try await post("lived", json: ["action": "decline", "id": id]) }
    /// Always available while live (LAW 3). A change you cannot take back was never a test.
    func reverseLived(_ id: String) async throws { try await post("lived", json: ["action": "reverse", "id": id]) }
    /// The member closes it (LAW 4). There is no co-side path to "endorsed".
    func verdictLived(_ id: String, value: LivedVerdict, words: String) async throws {
        try await post("lived", json: ["action": "verdict", "id": id, "value": value.rawValue, "words": words])
    }

    func fetchRooms() async throws -> [RoomModel] {
        let s = try await state()
        let base = self.base
        return (s.rooms ?? []).map { r in
            RoomModel(theme: r.theme, whisper: r.whisper, count: r.count,
                      members: r.members.map { m in
                          RoomMember(thumbURL: m.key.map { base.appendingPathComponent("t/\($0)").absoluteString },
                                     note: m.note, url: m.url, kind: m.kind, date: m.date)
                      })
        }
    }

    func fetchStaff() async throws -> [StaffEntry] {
        let s = try await state()
        return (s.staff ?? []).map { w in
            StaffEntry(ts: w.ts, verb: w.verb, what: w.what, why: w.why, url: w.url)
        }
    }


    func requestCall() async throws {
        var req = URLRequest(url: base.appendingPathComponent("call"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        let (_, resp) = try await session.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }

    func markDone() async throws {
        var req = URLRequest(url: base.appendingPathComponent("done"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["done": true])
        _ = try await session.data(for: req)
    }

    func fetchMe() async throws -> MeModel {
        let s = try await state()
        return MeModel(
            whatKeepsCatchingYou: s.me.orbit,
            thingsYouWantMoreOf: s.me.goals,
            standardsCoIsLearning: [],
            watching: s.me.watching,
            hypothesesCoIsTesting: s.me.patterns.map(\.read),
            totalHeld: s.me.n,
            number: s.me.number)
    }

    func uploadCapture(_ payload: CapturePayload) async throws {
        var body: [String: Any] = [:]
        body["sourceType"] = payload.sourceType.rawValue
        if let u = payload.url { body["url"] = u.absoluteString }
        if let t = payload.text { body["text"] = t }
        if let n = payload.userNote { body["userNote"] = n }
        if let w = payload.whyAnswer { body["whyAnswer"] = w }
        try await post("capture", json: body)
        await cache.invalidate()              // the next state() sees the new catch
    }

    func submitPatternVerdict(patternID: UUID, verdict: PatternVerdict) async throws {
        // the READ text rides along: the server kills a wrong read by its words, so it can
        // never be re-derived under a new id (the verdict loop's teeth).
        let read = (try? await state())?.me.patterns
            .first { UUID(uuidString: stableUUID("pattern:" + $0.read)) == patternID }?.read
        try await post("verdict", json: ["type": "pattern", "id": patternID.uuidString,
                                         "verdict": verdict.rawValue, "read": read ?? ""])
        await cache.invalidate()
    }

    /// what they're figuring out today — re-aims the finds immediately
    func setAim(_ text: String) async throws {
        try await post("aim", json: ["text": text])
        await cache.invalidate()
    }

    func currentAim() async -> String {
        ((try? await state())?.me.aim) ?? ""
    }

    func muteRadarItem(_ itemID: UUID) async throws {
        try await post("verdict", json: ["type": "radar_mute", "id": itemID.uuidString])
    }

    func saveRadarItem(_ itemID: UUID) async throws {
        try await post("verdict", json: ["type": "radar_save", "id": itemID.uuidString])
    }

    private func post(_ path: String, json: [String: Any]) async throws {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: json)
        let (_, resp) = try await session.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }

    /// deterministic UUID from a string (v5-style via MD5 fold) — stable identity across fetches.
    private func stableUUID(_ s: String) -> String {
        var h1: UInt64 = 0xcbf29ce484222325
        for b in s.utf8 { h1 = (h1 ^ UInt64(b)) &* 0x100000001b3 }
        var h2: UInt64 = 0x84222325cbf29ce4
        for b in s.utf8.reversed() { h2 = (h2 ^ UInt64(b)) &* 0x100000001b3 }
        let hex = String(format: "%016llx%016llx", h1, h2)
        let p = Array(hex)
        return "\(String(p[0..<8]))-\(String(p[8..<12]))-\(String(p[12..<16]))-\(String(p[16..<20]))-\(String(p[20..<32]))"
    }
}
