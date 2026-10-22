import Foundation

/// Capability bridge from Justin's shell to the relationship that already exists on the iMessage
/// rail — consumes documented HTTP seams, never reaches into rail storage directly.
final class RailCoAPI: CoAPI, @unchecked Sendable {
    let supportsInAppChat = true

    private struct World: Decodable, Sendable {
        struct Me: Decodable, Sendable {
            let number: String?
            /// The member model the wall draws — people, goals, patterns. Optional because an
            /// older rail sends only the number, and absence must read as "not yet", not 500.
            let orbit: [MeLine]?
            let goals: [MeLine]?
            let patterns: [MeLine]?
        }

        /// One line of the member model. The rail is mid-flight on this shape — `patterns`
        /// grew from bare strings into `{read, receipts, alternative}` objects (2026-08-27)
        /// and the others may follow. Same tolerance law as `WatchChip`: either shape decodes,
        /// an unreadable entry becomes empty rather than sinking the whole world.
        struct MeLine: Decodable, Sendable {
            let text: String

            init(from decoder: Decoder) throws {
                if let single = try? decoder.singleValueContainer(),
                   let s = try? single.decode(String.self) {
                    text = s
                    return
                }
                enum Keys: String, CodingKey { case read }
                let keyed = try? decoder.container(keyedBy: Keys.self)
                text = (try? keyed?.decodeIfPresent(String.self, forKey: .read)) ?? "" ?? ""
            }
        }
        struct Catch: Decodable, Sendable {
            let id: String
            let ts: String
            let kind: String
            let url: String?
            let title: String?
            let text: String?
            let read: String?
            let thumb: String?
        }
        struct Staff: Decodable, Sendable {
            let ts: String
            let verb: String
            let what: String
            let why: String?
            let url: String?
            var thumb: String?
            var kind: String?
        }
        struct Find: Decodable, Sendable {
            let title: String
            let url: String
            let why: String
            var thumb: String?
        }
        /// Newer rails send structured watch chips (label + note); older ones send bare labels.
        struct WatchChip: Decodable, Sendable {
            let label: String
            let note: String?

            init(from decoder: Decoder) throws {
                if let single = try? decoder.singleValueContainer(), let s = try? single.decode(String.self) {
                    label = s; note = nil
                    return
                }
                enum Keys: String, CodingKey { case label, note }
                let keyed = try decoder.container(keyedBy: Keys.self)
                label = try keyed.decode(String.self, forKey: .label)
                note = try keyed.decodeIfPresent(String.self, forKey: .note)
            }
        }
        struct Radar: Decodable, Sendable {
            let finds: [Find]
            let watching: [WatchChip]
        }

        /// The world's rooms (frame/claims/wrapped.py `_app_rooms`) — optional for a
        /// pre-rooms rail or a world too thin for the pass.
        struct Room: Decodable, Sendable {
            struct Member: Decodable, Sendable {
                let key: String?
                let note: String?
                let url: String?
                let kind: String?
                let date: String?
                let ts: String?
            }
            let theme: String
            let members: [Member]
        }

        /// The flagship loop's output half (frame/claims/lived.py) — optional for a pre-lived rail.
        struct Lived: Decodable, Sendable {
            struct Test: Decodable, Sendable {
                let id: String
                let state: String
                let resonance: String
                let quality: String
                let change: String
                let undo: String
                let question: String
                let because: String
                let url: String?
                let days: Int
            }
            let live: [Test]
            let proposed: [Test]
            let settled: Int
            let endorsed: Int
        }

        /// `_today` caches per day; a cache miss is a legitimately empty day, not a failure.
        struct Today: Decodable, Sendable {
            let read: String?
            let one_thing: String?
            let done: Bool?
        }
        struct Overnight: Decodable, Sendable {
            let thread: String?
            let line: String?
            let url: String?
        }

        let me: Me
        let catches: [Catch]
        let staff: [Staff]?
        let rooms: [Room]?
        let radar: Radar
        let lived: Lived?
        let today: Today?
        let overnight: Overnight?
    }

    private actor Cache {
        var world: World?
        var fetchedAt: Date?

        func value(ttl: TimeInterval, fetch: @Sendable () async throws -> World) async throws -> World {
            if let world, let fetchedAt, Date().timeIntervalSince(fetchedAt) < ttl { return world }
            let fresh = try await fetch()
            world = fresh
            fetchedAt = .now
            return fresh
        }

        /// Without this, the refresh after an undo/accept/tick reads the 30s-old snapshot.
        func invalidate() {
            world = nil
            fetchedAt = nil
        }
    }

    private let baseURL: URL
    private let loader: any HTTPDataLoading
    private let cache = Cache()

    init(baseURL: URL, loader: any HTTPDataLoading = URLSession.shared) {
        self.baseURL = baseURL
        self.loader = loader
    }

    /// The device's timezone rides every call so it follows travel with no setting or question
    /// (8/6: a text-parsed zone missed "i'm currently in eastern time," reminder fired 3h early).
    private func request(_ path: String, method: String = "GET") -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue(TimeZone.current.identifier, forHTTPHeaderField: "X-Co-Timezone")
        if method != "GET" { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return request
    }

    func home() async throws -> HomeResponse {
        Self.home(from: try await world(), baseURL: baseURL)
    }

    func archiveBuckets() async throws -> ArchiveResponse {
        Self.archive(from: try await world(), baseURL: baseURL)
    }

    /// The same engine call the iMessage thread makes — app chat and texting Co are one
    /// conversation by construction.
    func chat(_ text: String) async throws -> String {
        var request = self.request("chat", method: "POST")
        request.httpBody = try JSONEncoder().encode(["text": text])
        let (data, response) = try await loader.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw CoAPIError.server(status) }
        struct Reply: Decodable, Sendable { let ok: Bool; let reply: String? }
        let body = try JSONDecoder().decode(Reply.self, from: data)
        guard body.ok, let reply = body.reply else { throw CoAPIError.server(status) }
        return reply
    }

    func chatHistory() async throws -> [CoChatMessage] {
        let request = self.request("chat.json")
        let (data, response) = try await loader.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw CoAPIError.server(status) }
        struct History: Decodable, Sendable { let messages: [CoChatMessage] }
        return try JSONDecoder().decode(History.self, from: data).messages
    }

    // The member's half of the loop; the server owns the laws (lived.py) — no client path
    // installs or closes a change without a real tap here.
    func acceptLived(_ id: String) async throws { try await lived("accept", ["id": id]) }
    func declineLived(_ id: String) async throws { try await lived("decline", ["id": id]) }
    func reverseLived(_ id: String) async throws { try await lived("reverse", ["id": id]) }
    func verdictLived(_ id: String, value: LivedVerdict, words: String) async throws {
        try await lived("verdict", ["id": id, "value": value.rawValue, "words": words])
    }

    func forgetArtifact(_ id: String) async throws {
        try await write("forget", ["id": id])
    }

    /// "false" reads truthy in the door's Python (`bool("false") == True`) — a real boolean on
    /// the wire fixes un-ticking (found 8/9 walkthrough).
    func setTodayDone(_ done: Bool) async throws {
        struct Body: Encodable { let done: Bool }
        try await write("done", Body(done: done))
    }

    private func lived(_ action: String, _ fields: [String: String]) async throws {
        try await write("lived", fields.merging(["action": action]) { a, _ in a })
    }

    /// One place for every write, so the cache drop and status check can't be forgotten at a
    /// new call site.
    private func write<B: Encodable>(_ path: String, _ body: B) async throws {
        var request = self.request(path, method: "POST")
        request.httpBody = try JSONEncoder().encode(body)
        let (_, response) = try await loader.data(for: request)
        await cache.invalidate()
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw CoAPIError.server(status) }
    }

    /// The slug is both credential and tenant — the rail resolves it server-side into the
    /// witness agent's job metadata. `history` is ignored: the rail already has the same
    /// per-tenant transcript the engine reads, so sending it would be a worse copy.
    func voiceSession(history: [CoChatMessage] = []) async throws -> VoiceSessionConfig {
        let request = self.request("voice", method: "POST")
        let (data, response) = try await loader.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // 503 means no LiveKit grant loaded — configuration state, not a failed call.
        guard status != 503 else { throw CoAPIError.notConfigured }
        guard status == 200 else { throw CoAPIError.server(status) }
        return try JSONDecoder().decode(VoiceSessionConfig.self, from: data)
    }

    private func world() async throws -> World {
        let baseURL = self.baseURL
        let loader = self.loader
        let tz = TimeZone.current.identifier
        return try await cache.value(ttl: 30) {
            var request = URLRequest(url: baseURL.appending(path: "app.json"))
            request.setValue(tz, forHTTPHeaderField: "X-Co-Timezone")
            let (data, response) = try await loader.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else { throw CoAPIError.server(status) }
            return try JSONDecoder().decode(World.self, from: data)
        }
    }

    private static func home(from world: World, baseURL: URL) -> HomeResponse {
        let live = world.radar.finds.enumerated().map { index, find in
            let url = URL(string: find.url)
            return FeedItem(
                id: stableID("find:\(find.url)"),
                kind: kind(url: url, fallback: "link"),
                aspectRatio: 1,
                imageURL: find.thumb.map { baseURL.appending(path: "t/\($0)") },
                text: find.title,
                attribution: url?.host,
                summary: find.why.isEmpty ? [] : [find.why],
                url: url,
                savedAt: .now,
                source: url?.host ?? "web",
                isHighlight: index == 0,
                isFind: true
            )
        }
        let archived = world.catches.map { feedItem(from: $0, baseURL: baseURL) }
        let receipts = (world.staff ?? []).map { entry in
            Receipt(id: stableID("staff:\(entry.ts):\(entry.what)"),
                    verb: receiptVerb(entry.verb),
                    what: entry.what,
                    why: entry.why ?? "",
                    url: entry.url.flatMap(URL.init(string:)),
                    when: CoFormat.date(entry.ts) ?? .now,
                    imageURL: entry.thumb.map { baseURL.appending(path: "t/\($0)") },
                    isFinding: entry.kind == "finding")
        }
        let watches = world.radar.watching.map { chip in
            WatchItem(id: stableID("watch:\(chip.label)"), label: chip.label, note: chip.note ?? "")
        }
        return HomeResponse(items: live + archived,
                            watching: watches,
                            messageURL: messageURL(for: world.me.number),
                            lived: livedState(from: world.lived),
                            today: todayState(from: world.today, overnight: world.overnight),
                            forYou: world.radar.finds.map(forYouItem),
                            recap: receipts.prefix(12).map(recapItem),
                            profile: profileFacts(from: world.me))
    }

    /// A radar find as the For-you shelf draws it. The rail sends no duration, so `length`
    /// stays empty and the card hides the dot; the kind is read off the host, `.read` when the
    /// host says nothing — an article is the only harmless default.
    private static func forYouItem(_ find: World.Find) -> ForYouItem {
        let url = URL(string: find.url)
        let rawHost = url?.host ?? ""
        let host = rawHost.hasPrefix("www.") ? String(rawHost.dropFirst(4)) : rawHost
        let kind: ForYouKind
        if host.contains("youtube") || host.contains("youtu.be") || host.contains("vimeo") {
            kind = .watch
        } else if host.contains("podcasts.") || host.contains("spotify") {
            kind = .listen
        } else {
            kind = .read
        }
        return ForYouItem(id: stableID("find:\(find.url)"),
                          title: find.title, source: host, length: "", kind: kind, url: url)
    }

    /// A staff receipt as the recap shelf draws it — the verb's glyph, the line as written.
    private static func recapItem(_ receipt: Receipt) -> RecapItem {
        RecapItem(id: receipt.id, line: receipt.what, symbol: receipt.verb.glyph)
    }

    /// The member model as Profile's fixed slots. Slots the rail cannot fill yet stay empty on
    /// purpose — the card says "co will fill this in", which is true.
    private static func profileFacts(from me: World.Me) -> [ProfileFact] {
        func joined(_ lines: [World.MeLine]?) -> String {
            (lines ?? []).map(\.text).filter { !$0.isEmpty }.joined(separator: ". ")
        }
        let people = joined(me.orbit)
        let goals = joined(me.goals)
        let patterns = joined(me.patterns)
        // All empty = an older rail or a brand-new member; send nothing so the store keeps
        // its seed (Debug) or Profile shows its honest empty slots (Release).
        guard !(people.isEmpty && goals.isEmpty && patterns.isEmpty) else { return [] }
        return [
            ProfileFact(id: "pf-you", title: "Who you are", line: "", symbol: "person"),
            ProfileFact(id: "pf-people", title: "Your people", line: people, symbol: "person.2"),
            ProfileFact(id: "pf-after", title: "What you're after", line: goals, symbol: "flag"),
            ProfileFact(id: "pf-rhythm", title: "Your rhythm", line: patterns, symbol: "clock"),
            ProfileFact(id: "pf-taste", title: "Your taste", line: "", symbol: "eye"),
        ]
    }

    private static func todayState(from wire: World.Today?,
                                   overnight: World.Overnight?) -> TodayState {
        guard wire != nil || overnight != nil else { return .empty }
        return TodayState(oneThing: wire?.one_thing, read: wire?.read,
                          done: wire?.done ?? false,
                          overnightThread: overnight?.thread,
                          overnightLine: overnight?.line,
                          overnightURL: overnight?.url.flatMap(URL.init(string:)))
    }

    private static func livedState(from wire: World.Lived?) -> LivedState {
        guard let wire else { return .empty }
        func map(_ t: World.Lived.Test) -> LivedTest {
            LivedTest(id: t.id,
                      state: LivedTestState(rawValue: t.state) ?? .live,
                      resonance: t.resonance, quality: t.quality, change: t.change,
                      undo: t.undo, question: t.question, because: t.because,
                      url: t.url.flatMap(URL.init(string:)), days: t.days)
        }
        return LivedState(live: wire.live.map(map), proposed: wire.proposed.map(map),
                          settled: wire.settled, endorsed: wire.endorsed)
    }

    /// Archive shelves ARE the world's rooms — the same collections the web draws as "your
    /// rooms." Source-type folding stays only as the fallback for a rail carrying none.
    private static func archive(from world: World, baseURL: URL) -> ArchiveResponse {
        let catches = world.catches.map { archiveItem(from: $0, baseURL: baseURL) }
        guard let rooms = world.rooms, !rooms.isEmpty else { return .bySourceType(catches) }

        // Where a room member and a catch are the same save, the CATCH wins — its id is the
        // one FeedStore uses for note/delete, and a synthesized id would drop that typing.
        let byURL = Dictionary(catches.compactMap { item in item.canonicalUrl.map { ($0, item) } },
                               uniquingKeysWith: { first, _ in first })
        let buckets = rooms.map { room in
            let items = room.members.enumerated().map { index, member in
                member.url.flatMap { byURL[$0] }
                    ?? archiveItem(from: member, room: room.theme, index: index, baseURL: baseURL)
            }
            return ArchiveBucket(name: room.theme, itemCount: items.count, items: items)
        }
        return ArchiveResponse(buckets: buckets, total: buckets.reduce(0) { $0 + $1.itemCount })
    }

    private static func archiveItem(from entry: World.Catch, baseURL: URL) -> ArchiveItem {
        let url = entry.url.flatMap(URL.init(string:))
        let (title, publisher) = titled(entry.title ?? entry.text, url: url)
        return ArchiveItem(artifactId: entry.id,
                           sourceType: sourceType(url: url, fallback: entry.kind),
                           canonicalUrl: entry.url,
                           title: title,
                           publisher: publisher,
                           capturedAt: entry.ts,
                           imageURL: entry.thumb.map { baseURL.appending(path: "t/\($0)") })
    }

    /// A room member the catches don't cover (older than the 40-catch window). Only `yours`
    /// gets a media tile; index is in the id since two uncaptioned photos are otherwise
    /// identical and a duplicate id costs SwiftUI a tile.
    private static func archiveItem(from member: World.Room.Member, room: String, index: Int,
                                    baseURL: URL) -> ArchiveItem {
        let url = nonEmpty(member.url).flatMap(URL.init(string:))
        let (title, publisher) = titled(nonEmpty(member.note), url: url)
        let source: String
        switch member.kind {
        case "yours": source = "image"
        case "voice": source = "voice"
        case "thought", "photo": source = "text"
        default: source = sourceType(url: url, fallback: "text")
        }
        return ArchiveItem(artifactId: stableID("room:\(room):\(index):\(member.key ?? member.url ?? "")"),
                           sourceType: source,
                           canonicalUrl: url?.absoluteString,
                           title: title,
                           publisher: publisher,
                           // A pre-stamp rail sends only the day; noon keeps that day whole in any zone.
                           capturedAt: member.ts ?? member.date.map { "\($0)T12:00:00Z" } ?? "",
                           imageURL: nonEmpty(member.key).map { baseURL.appending(path: "t/\($0)") })
    }

    /// The rail writes "no value" as `""` as readily as null — both mean absent here.
    private static func nonEmpty(_ value: String?) -> String? {
        (value?.isEmpty ?? true) ? nil : value
    }

    /// "tweet @handle: content" wastes half the tile on chrome (founder, 8/7) — split handle
    /// into publisher, content into title.
    private static func titled(_ raw: String?, url: URL?) -> (String?, String?) {
        var title = raw
        var publisher = url?.host
        if let t = title, t.hasPrefix("tweet @"), let colon = t.range(of: ": ") {
            publisher = String(t[t.index(t.startIndex, offsetBy: 6)..<colon.lowerBound])
                .replacingOccurrences(of: " (article)", with: "")
            title = String(t[colon.upperBound...])
        }
        return (title, publisher)
    }

    private static func feedItem(from entry: World.Catch, baseURL: URL) -> FeedItem {
        let url = entry.url.flatMap(URL.init(string:))
        let summary = entry.read.map { [$0] } ?? []
        return FeedItem(id: entry.id,
                        kind: kind(url: url, fallback: entry.kind),
                        aspectRatio: 1,
                        imageURL: entry.thumb.map { baseURL.appending(path: "t/\($0)") },
                        text: entry.title ?? entry.text,
                        attribution: url?.host,
                        summary: summary,
                        url: url,
                        savedAt: CoFormat.date(entry.ts) ?? .distantPast,
                        source: sourceType(url: url, fallback: entry.kind),
                        isArchived: true)
    }

    private static func kind(url: URL?, fallback: String) -> FeedItem.Kind {
        let source = sourceType(url: url, fallback: fallback)
        switch source {
        case "image", "screenshot": return .photo
        case "youtube", "podcast", "short_video", "video": return .podcast
        case "text", "voice": return .quote
        default: return .post
        }
    }

    private static func sourceType(url: URL?, fallback: String) -> String {
        let host = url?.host?.lowercased() ?? ""
        if host.contains("youtu") { return "youtube" }
        if host.contains("instagram") || host.contains("tiktok") { return "short_video" }
        if host.contains("x.com") || host.contains("twitter") { return "social_post" }
        if !host.isEmpty { return "url" }
        return fallback == "voice" ? "voice" : "text"
    }

    private static func receiptVerb(_ raw: String) -> Receipt.Verb {
        let verb = raw.lowercased()
        if verb.contains("watch") { return .watched }
        if verb.contains("find") || verb.contains("found") { return .found }
        return .read
    }

    private static func messageURL(for raw: String?) -> URL? {
        guard let raw else { return nil }
        let clean = raw.filter { $0.isNumber || $0 == "+" }
        guard clean.contains(where: \.isNumber) else { return nil }
        return URL(string: "sms:\(clean)")
    }

    /// Not cryptographic — only keeps SwiftUI from treating a refresh as a different card.
    private static func stableID(_ value: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in value.utf8 { hash = (hash ^ UInt64(byte)) &* 0x100000001b3 }
        return String(format: "%016llx", hash)
    }

    // Pure decode seams for contract tests; production goes through the cache above.
    static func decodeHome(_ data: Data, baseURL: URL) throws -> HomeResponse {
        home(from: try JSONDecoder().decode(World.self, from: data), baseURL: baseURL)
    }

    static func decodeArchive(_ data: Data, baseURL: URL) throws -> ArchiveResponse {
        archive(from: try JSONDecoder().decode(World.self, from: data), baseURL: baseURL)
    }
}
