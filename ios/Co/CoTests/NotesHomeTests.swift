import XCTest
@testable import Co

@MainActor
final class NotesHomeTests: XCTestCase {
    private func note(_ id: String, title: String, daysAgo: Int) -> Note {
        let day = Calendar.current.date(byAdding: .day, value: -daysAgo, to: Date()) ?? Date()
        return Note(id: id, title: title, day: day, lines: ["line for \(id)"])
    }

    private func store(_ notes: [Note]) -> NotesStore {
        NotesStore(defaults: UserDefaults(suiteName: UUID().uuidString)!, seed: notes)
    }

    /// Justin, 2026-08-10: "for recent, there should only be 4 recents."
    func testRecentShowsExactlyFour() {
        let notes = (0..<9).map { note("n\($0)", title: "page \($0)", daysAgo: $0 + 1) }
        XCTAssertEqual(store(notes).recent.count, 4)
    }

    /// Recent is the head of the same ordering General uses — newest edit first, not newest day.
    /// The store always adds a Today page, so this asserts on the seeded pair's relative order.
    func testBothSectionsOrderByLastEdit() {
        var older = note("older", title: "older", daysAgo: 1)
        var newer = note("newer", title: "newer", daysAgo: 9)
        older.updatedAt = Date(timeIntervalSince1970: 1_000)
        newer.updatedAt = Date(timeIntervalSince1970: 9_000)
        let seeded = store([older, newer]).board.map(\.id).filter { $0 == "older" || $0 == "newer" }
        XCTAssertEqual(seeded, ["newer", "older"])
    }

    /// A page with fewer than four siblings must not pad Recent with duplicates or blanks.
    func testRecentNeverExceedsWhatExists() {
        let store = store([note("only", title: "only", daysAgo: 2)])
        // The store always keeps a Today page, so "only" plus Today is the whole board.
        XCTAssertEqual(store.recent.count, store.board.count)
        XCTAssertLessThanOrEqual(store.recent.count, NotesStore.recentCount)
    }

    /// Writing to Today must move it to the head of Recent, or the section is a lie. `stale` is
    /// dated three days back on purpose — a page dated today IS the Today page.
    func testAddingToTodayBumpsItToTheTopOfRecent() {
        var stale = note("stale", title: "stale", daysAgo: 3)
        stale.updatedAt = Date().addingTimeInterval(-3_600)
        let store = store([stale])
        store.addToToday("a new line")
        XCTAssertEqual(store.recent.first?.title, "Today")
        XCTAssertTrue(store.today?.lines.contains("a new line") == true)
    }

    /// Empty input must never reach the page.
    func testBlankQuickNoteIsDropped() {
        let store = store([])
        let before = store.today?.lines.count ?? 0
        store.addToToday("   \n ")
        XCTAssertEqual(store.today?.lines.count ?? 0, before)
    }




}
