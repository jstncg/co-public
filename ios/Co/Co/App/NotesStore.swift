import Foundation

/// Home's pages. There is no notes endpoint on the rail yet, so this is local-first on purpose:
/// a quick note has to survive the app being closed, or the composer is a demo (Justin, 8/10).
/// Wiring these pages to the rail is separate work — the shape here is what it will sync.
@Observable
@MainActor
final class NotesStore {
    private(set) var notes: [Note] = []

    /// Home's shelves and the member model: rail-fed, fixture-seeded in Debug
    /// (`AppShellView.init`), memory-only — a card is wrong the moment it outlives the
    /// launch that made it.
    private(set) var forYou: [ForYouItem] = []
    private(set) var recap: [RecapItem] = []
    private(set) var profile: [ProfileFact] = []
    /// The standing watches — what co has eyes on RIGHT NOW (price, listings, a thread).
    /// Distinct from `sensitive`, which is a watch or promise that has already fired.
    private(set) var watches: [WatchItem] = []

    private let defaults: UserDefaults
    private let storageKey = "co.notes.v1"

    init(defaults: UserDefaults = .standard, seed: [Note]? = nil,
         forYou: [ForYouItem] = [], recap: [RecapItem] = [],
         profile: [ProfileFact] = [], watches: [WatchItem] = []) {
        self.defaults = defaults
        self.forYou = forYou
        self.recap = recap
        self.profile = profile
        self.watches = watches
        if let seed {
            notes = seed
        } else {
            notes = Self.decode(from: defaults, key: storageKey)
        }
        ensureTodayExists()
    }

    /// The rail's cards replace the seeded ones wholesale, shelf by shelf — a merge would
    /// keep showing a card the server has already dropped. An EMPTY list is not an answer:
    /// blanking a seed on it would make the simulator's Home read as broken every launch.
    func apply(forYou incoming: [ForYouItem]) {
        guard !incoming.isEmpty else { return }
        forYou = incoming
    }

    func apply(recap incoming: [RecapItem]) {
        guard !incoming.isEmpty else { return }
        recap = incoming
    }

    func apply(profile incoming: [ProfileFact]) {
        guard !incoming.isEmpty else { return }
        profile = incoming
    }

    func apply(watches incoming: [WatchItem]) {
        guard !incoming.isEmpty else { return }
        watches = incoming
    }

    /// Newest edit first. Both sections read from this — Recent is simply its head.
    var board: [Note] { notes.sorted { $0.updatedAt > $1.updatedAt } }

    /// Recent shows exactly four (Justin, 2026-08-10). General shows everything.
    static let recentCount = 4
    var recent: [Note] { Array(board.prefix(Self.recentCount)) }
    var general: [Note] { board }

    var today: Note? { notes.first(where: \.isToday) }

    /// The composer's one job. Empty input is a no-op, not an empty line on the page.
    func addToToday(_ text: String) {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return }
        ensureTodayExists()
        guard let index = notes.firstIndex(where: \.isToday) else { return }
        notes[index].lines.append(line)
        notes[index].updatedAt = Date()
        persist()
    }

    func update(noteID: String, lines: [String]) {
        guard let index = notes.firstIndex(where: { $0.id == noteID }) else { return }
        guard notes[index].lines != lines else { return }
        notes[index].lines = lines
        notes[index].updatedAt = Date()
        persist()
    }

    /// The only way to lose a page. Until 2026-08-10 there was none: a note could be written and
    /// edited but never removed. Deleting today's page clears the day rather than leaving the
    /// board without one, since `ensureTodayExists` puts a fresh one back.
    func delete(noteID: String) {
        guard notes.contains(where: { $0.id == noteID }) else { return }
        notes.removeAll { $0.id == noteID }
        ensureTodayExists()
        persist()
    }

    /// Today's page is created on demand, never by a background pass — an empty card for a day
    /// nothing was deposited is noise on the board.
    private func ensureTodayExists() {
        guard !notes.contains(where: \.isToday) else { return }
        notes.append(Note(title: "Today", day: Calendar.current.startOfDay(for: Date()),
                          updatedAt: Date()))
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(notes) else { return }
        defaults.set(data, forKey: storageKey)
    }

    private static func decode(from defaults: UserDefaults, key: String) -> [Note] {
        guard let data = defaults.data(forKey: key),
              let decoded = try? JSONDecoder().decode([Note].self, from: data) else { return [] }
        return decoded
    }
}
