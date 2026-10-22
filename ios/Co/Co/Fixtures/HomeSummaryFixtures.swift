import Foundation

// Design material for the daily prep card. Same person as FeedFixtures (leaving
// consulting, learning to throw), so the home reads as one person's world.

enum HomeSummaryFixtures {
    static let today = TodayState(
        oneThing: "call the cedar mill before the quote closes on the 28th",
        read: "the sauna build thread, end to end, the useful part is the drainage argument",
        done: false)

    static func ago(hours: Double) -> Date {
        Date.now.addingTimeInterval(-hours * 3600)
    }
}

// MARK: - In your week — the flagship loop's output half

/// The mock's lived tests, moved by MockCoAPI so accept/undo visibly do something
/// offline. Same person as the receipts above: leaving consulting, learning to throw.
actor DemoLivedStore {
    static let shared = DemoLivedStore()

    var state = LivedState(
        live: [LivedTest(
            id: "lt-thursday",
            state: .live,
            resonance: "the ceramics reel you sent",
            quality: "a small group making something on a repeating schedule",
            change: "thursday 7–9pm is held, every week, starting this week",
            undo: "drop the hold. nothing else in your calendar moves",
            question: "does a protected evening actually get used, or does it get given away",
            because: "i keep saving these and never doing anything",
            url: nil,
            days: 4)],
        proposed: [LivedTest(
            id: "lt-saturday",
            state: .proposed,
            resonance: "the third-places essay",
            quality: "somewhere you're a regular, not a guest",
            change: "one coffee shop, same time saturday, two weeks running",
            undo: "say no and it's gone. i won't bring it back",
            question: "is it the people you want, or just somewhere to be",
            because: "i want more interesting friends",
            url: nil,
            days: 0)],
        settled: 3,
        endorsed: 2)

    func accept(_ id: String) {
        guard let i = state.proposed.firstIndex(where: { $0.id == id }) else { return }
        let t = state.proposed.remove(at: i)
        state.live.append(LivedTest(id: t.id, state: .live, resonance: t.resonance,
                                    quality: t.quality, change: t.change, undo: t.undo,
                                    question: t.question, because: t.because, url: t.url,
                                    days: 0))
    }

    func decline(_ id: String) { state.proposed.removeAll { $0.id == id } }

    func settle(_ id: String, endorsed: Bool) {
        guard state.live.contains(where: { $0.id == id }) else { return }
        state.live.removeAll { $0.id == id }
        state.settled += 1
        if endorsed { state.endorsed += 1 }
    }
}
