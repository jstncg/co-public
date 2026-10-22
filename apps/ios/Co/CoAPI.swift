// CoAPI.swift — all server calls go through this seam.
//
// demo mode (MockAPI) is the default until the backend exists.
// BLOCKED: supabase project — the real client (supabase auth + signed upload
// urls + server routes, goal.md §25.3) implements this same protocol here.

import Foundation

protocol CoAPI: Sendable {
    func fetchCatches() async throws -> [Moment]
    func fetchPatterns() async throws -> [PatternCard]
    func fetchRadar() async throws -> RadarState
    func fetchMe() async throws -> MeModel
    func fetchToday() async throws -> TodayModel
    func search(_ q: String) async throws -> [Moment]
    func requestCall() async throws
    func fetchOvernight() async throws -> OvernightModel?
    func markDone() async throws
    func fetchRooms() async throws -> [RoomModel]
    func fetchStaff() async throws -> [StaffEntry]

    /// the flagship loop's output half — what changed in their week, still reversible
    func fetchLived() async throws -> LivedState
    /// co proposed; ONLY the member installs (lived.py LAW 2)
    func acceptLived(_ id: String) async throws
    func declineLived(_ id: String) async throws
    /// always available while live (LAW 3)
    func reverseLived(_ id: String) async throws
    /// only the member closes it (LAW 4) — this is the endorsement metric 7 needs
    func verdictLived(_ id: String, value: LivedVerdict, words: String) async throws

    /// upload one queued capture (called by the outbox drainer).
    func uploadCapture(_ payload: CapturePayload) async throws

    /// user verdict on a pattern read (right / partly / wrong — goal.md §20.5)
    func submitPatternVerdict(patternID: UUID, verdict: PatternVerdict) async throws

    /// "not relevant" / mute updates the watch policy (goal.md §15.7)
    func muteRadarItem(_ itemID: UUID) async throws

    /// [save] on a radar card keeps it as a catch (goal.md §20.6)
    func saveRadarItem(_ itemID: UUID) async throws
}

/// deterministic local implementation backed by the seeded maya journey
/// (goal.md §37). every view renders real-looking content without a network.
final class MockAPI: CoAPI, @unchecked Sendable {
    // in-memory state so actions visibly do something in demo mode
    private let lock = NSLock()
    private var moments: [Moment] = DemoData.mayaMoments
    private var patterns: [PatternCard] = DemoData.patterns
    private var radar: RadarState = DemoData.radar

    func fetchCatches() async throws -> [Moment] {
        lock.withLock { moments }
    }

    func fetchPatterns() async throws -> [PatternCard] {
        lock.withLock { patterns }
    }

    func fetchRadar() async throws -> RadarState {
        lock.withLock { radar }
    }

    func fetchMe() async throws -> MeModel {
        DemoData.me
    }

    func uploadCapture(_ payload: CapturePayload) async throws {
        // demo mode: reflect the capture locally, honestly marked as pending —
        // there is no model behind this yet, so no fake "understanding".
        let moment = Moment(
            id: UUID(),
            sourceType: payload.sourceType,
            sourceApp: payload.sourceApp,
            canonicalURL: payload.url,
            title: payload.text.map { String($0.prefix(80)) },
            capturedAt: payload.capturedAt,
            rawText: payload.text,
            userNote: payload.userNote,
            sensitivity: payload.sensitivity,
            processingStatus: .pending,
            coverage: payload.coverage,
            whySignal: payload.whyAnswer,
            facets: payload.sourceType == .voice ? [.voice] : []
        )
        lock.withLock { moments.insert(moment, at: 0) }
    }

    func submitPatternVerdict(patternID: UUID, verdict: PatternVerdict) async throws {
        // "wrong" retires the pattern; "right"/"partly" keep it. (§20.5)
        lock.withLock {
            if verdict == .wrong {
                patterns.removeAll { $0.id == patternID }
            }
        }
    }

    func muteRadarItem(_ itemID: UUID) async throws {
        lock.withLock {
            radar.newItems.removeAll { $0.id == itemID }
        }
    }

    func saveRadarItem(_ itemID: UUID) async throws {
        lock.withLock {
            guard let item = radar.newItems.first(where: { $0.id == itemID }) else { return }
            let moment = Moment(
                id: UUID(),
                sourceType: .article,
                canonicalURL: item.sourceURL,
                title: item.headline,
                publisher: item.sourceLabel,
                capturedAt: .now,
                coverage: item.sourceURL == nil ? .unavailable : .urlOnly,
                whySignal: item.whyReachedYou.first,
                facets: [.watch]
            )
            moments.insert(moment, at: 0)
        }
    }
    func search(_ q: String) async throws -> [Moment] {
        let ql = q.lowercased()
        return DemoData.mayaMoments.filter {
            ($0.title ?? "").lowercased().contains(ql) || ($0.rawText ?? "").lowercased().contains(ql)
        }
    }

    func fetchToday() async throws -> TodayModel {
        TodayModel(read: "quiet morning. one honest brick beats a grand plan.",
                   oneThing: "send the maya intro you drafted last night",
                   setup: ["phone on do-not-disturb until ten", "coffee before the feed"],
                   then: "then the afternoon is yours.", done: false)
    }
    func requestCall() async throws {}

    func fetchOvernight() async throws -> OvernightModel? {
        OvernightModel(thread: "the sauna idea", line: "found the person who built one in an alley in portland — reads like your plan.", url: "https://example.com")
    }
    func markDone() async throws {}

    func fetchRooms() async throws -> [RoomModel] {
        [RoomModel(theme: "the sauna build", whisper: "price the cedar kit from that reel", count: 6,
                   members: [
                       RoomMember(thumbURL: nil, note: "backyard sauna conversion, alley footprint", url: nil, kind: "note", date: "2026-07-28"),
                       RoomMember(thumbURL: nil, note: "cedar vs hemlock — the reel said cedar overrated", url: nil, kind: "instagram", date: "2026-07-30"),
                       RoomMember(thumbURL: nil, note: "portland guy who built one for $3k", url: nil, kind: "youtube", date: "2026-08-01"),
                   ]),
         RoomModel(theme: "getting out of consulting", whisper: "text jules back about the studio idea", count: 4,
                   members: [
                       RoomMember(thumbURL: nil, note: "the designer who quit and got her first client on twitter", url: nil, kind: "x", date: "2026-07-25"),
                       RoomMember(thumbURL: nil, note: "voice note: 'i keep saying one more year'", url: nil, kind: "voice", date: "2026-07-29"),
                   ]),
         RoomModel(theme: "pottery", whisper: "the wheel class has tuesday spots", count: 3,
                   members: [
                       RoomMember(thumbURL: nil, note: "kiln-share studio two blocks from work", url: nil, kind: "note", date: "2026-07-22"),
                   ])]
    }

    func fetchStaff() async throws -> [StaffEntry] {
        [StaffEntry(ts: "2026-08-04T08:31:00", verb: "read",
                    what: "pulled a morning read on the sauna build",
                    why: "it had heat in yesterday's conversation", url: "https://example.com"),
         StaffEntry(ts: "2026-08-03T21:12:00", verb: "watched",
                    what: "a 41-minute video, end to end",
                    why: "so the take you got came from the whole thing", url: nil),
         StaffEntry(ts: "2026-08-02T18:00:00", verb: "found",
                    what: "sourced this week's unasked find",
                    why: "themed from: the studio idea keeps recurring", url: nil)]
    }

    func fetchLived() async throws -> LivedState { await DemoLivedStore.shared.state }
    func acceptLived(_ id: String) async throws { await DemoLivedStore.shared.accept(id) }
    func declineLived(_ id: String) async throws { await DemoLivedStore.shared.decline(id) }
    func reverseLived(_ id: String) async throws { await DemoLivedStore.shared.settle(id, endorsed: false) }
    func verdictLived(_ id: String, value: LivedVerdict, words: String) async throws {
        await DemoLivedStore.shared.settle(id, endorsed: value == .chosen)
    }
}

/// The demo journey's lived tests — one already in her week, one waiting on her.
/// An actor because the mock is shared mutable state and the real client is not.
private actor DemoLivedStore {
    static let shared = DemoLivedStore()

    var state = LivedState(
        live: [LivedTest(
            id: "demo-live-1", state: .live,
            resonance: "the ceramics reel you sent",
            quality: "a small group making something on a repeating schedule",
            change: "thursday 7–9pm is held, every week, starting this week",
            undo: "drop the hold. nothing else in your calendar moves",
            question: "does a protected evening actually get used, or does it get given away",
            because: "i keep saving these and never doing anything",
            url: nil, days: 4)],
        proposed: [LivedTest(
            id: "demo-prop-1", state: .proposed,
            resonance: "the third-places essay",
            quality: "somewhere you're a regular, not a guest",
            change: "one coffee shop, same time saturday, two weeks running",
            undo: "say no and it's gone. i won't bring it back",
            question: "is it the people you want, or just somewhere to be",
            because: "i want more interesting friends",
            url: nil, days: 0)],
        settled: 3, endorsed: 2)

    func accept(_ id: String) {
        guard let i = state.proposed.firstIndex(where: { $0.id == id }) else { return }
        var t = state.proposed.remove(at: i)
        t.state = .live
        t.days = 0
        state.live.append(t)
    }

    func decline(_ id: String) {
        state.proposed.removeAll { $0.id == id }
    }

    func settle(_ id: String, endorsed: Bool) {
        guard state.live.contains(where: { $0.id == id }) else { return }
        state.live.removeAll { $0.id == id }
        state.settled += 1
        if endorsed { state.endorsed += 1 }
    }
}

