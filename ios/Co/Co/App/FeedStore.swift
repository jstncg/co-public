import Foundation

@Observable
@MainActor
final class FeedStore {
    /// Two promises wearing the same grid: Live is what co picked, Archive is what you kept.
    enum Mode: CaseIterable {
        case live, archive

        var label: String {
            switch self {
            case .live: return "Live"
            case .archive: return "Archive"
            }
        }
    }

    private(set) var items: [FeedItem] = []
    /// What changed in their week because of something they sent — consequence, not collection.
    private(set) var lived: LivedState = .empty
    /// The day co set up before they woke. Empty is real (fresh tenant, or per-day cache miss).
    private(set) var today: TodayState = .empty
    /// App-first uses this to hand off to iMessage; a privately paired rail opens in-app chat instead.
    private(set) var messageURL: URL?
    var mode: Mode = .live
    var query: String = ""

    /// Gates CONTENT vs LOADING — empty defaults must never render as "co has nothing for
    /// you" before the first load lands (founder, 8/9).
    private(set) var hasLoaded = false

    /// Same launch-argument pattern as `AppShellView`'s `-coTab` — screenshots this surface's real gate.
    private var api: CoAPI

    init(api: CoAPI = CoAPIEnvironment.current()) {
        self.api = api
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-coFeedArchive") { mode = .archive }
        if let i = args.firstIndex(of: "-coQuery"), i + 1 < args.count {
            query = args[i + 1]
        }
    }

    func load() async {
        do {
            let home = try await api.home()
            items = home.items
            lived = home.lived
            today = home.today
            messageURL = home.messageURL
            hasLoaded = true
        } catch {
            // Keep the last known state on a failed refresh — never fall back to fixtures.
        }
    }

    func connect(to api: CoAPI) async {
        self.api = api
        // A freshly paired member must never see the prototype person's stale life mid-request.
        items = []
        lived = .empty
        today = .empty
        messageURL = nil
        await load()
    }

    /// Optimistic: tick lands instantly, the next `load()` reconciles against the rail's own `done`.
    func setTodayDone(_ done: Bool) {
        today.done = done
        let api = self.api
        Task { try? await api.setTodayDone(done) }
    }

    /// Refreshes on success so an undo visibly takes; on failure the change stays on screen
    /// rather than pretending it was undone.
    func livedAction(_ work: @Sendable (CoAPI) async throws -> Void) async -> Bool {
        do {
            try await work(api)
            lived = (try? await api.home().lived) ?? lived
            return true
        } catch {
            return false
        }
    }

    // MARK: Reading

    /// The only real logic on this surface — static and pure so `FeedFilterTests` can exercise
    /// it without a store or a view.
    static func visible(_ items: [FeedItem], mode: Mode, query: String) -> [FeedItem] {
        items.filter { $0.isArchived == (mode == .archive) && $0.matches(query) }
    }

    /// Watching / while-you-were-living are HOME's face, not search's — they show only in
    /// Live mode with no active query; `FeedView` hides them rather than filtering them.
    static func showsSummary(mode: Mode, query: String) -> Bool {
        mode == .live && query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var showsSummary: Bool { Self.showsSummary(mode: mode, query: query) }

    var visibleItems: [FeedItem] { Self.visible(items, mode: mode, query: query) }

    /// Lifted out of the masonry so highlights can be physically bigger, not merely marked.
    var highlights: [FeedItem] {
        mode == .live ? visibleItems.filter(\.isHighlight) : []
    }

    var gridItems: [FeedItem] {
        mode == .live ? visibleItems.filter { !$0.isHighlight } : visibleItems
    }

    func item(id: String) -> FeedItem? { items.first { $0.id == id } }

    // MARK: Writing

    /// Keeps the case the user typed (Justin, 8/3 — no forced lowercase); dupes judged case-insensitively.
    func addTag(_ tag: String, to id: String) {
        let clean = tag.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        mutate(id) {
            if !$0.tags.contains(where: { $0.caseInsensitiveCompare(clean) == .orderedSame }) {
                $0.tags.append(clean)
            }
        }
    }

    func removeTag(_ tag: String, from id: String) {
        mutate(id) { $0.tags.removeAll { $0.caseInsensitiveCompare(tag) == .orderedSame } }
    }

    /// A pool IS a tag — this is the tag write plus `isArchived`, which moves the post onto a
    /// shelf. Deselecting the last pool takes it back out; no archived item sits on no shelf.
    func setPool(_ pool: String, selected: Bool, on id: String) {
        if selected { addTag(pool, to: id) } else { removeTag(pool, from: id) }
        mutate(id) { $0.isArchived = !$0.tags.isEmpty }
    }

    func setNote(_ note: String, on id: String) {
        mutate(id) { $0.note = note }
    }

    /// Server forgets first — before this (8/9 walkthrough) removal was in-memory only and a
    /// "deleted" memory resurrected on the next fetch. On failure the item stays on screen.
    func forget(id: String) async -> Bool {
        do {
            try await api.forgetArtifact(id)
            items.removeAll { $0.id == id }
            return true
        } catch {
            return false
        }
    }

    private func mutate(_ id: String, _ change: (inout FeedItem) -> Void) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        change(&items[i])
    }
}
