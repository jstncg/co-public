import Foundation

// The two top-of-Home surfaces for what co DID, not what you're reading: Watching pins as
// a glanceable chip rail; while-you-were-living scrolls as the feed's first block (Live mode, no search).

/// One line of "while you were living" — read/watched/found on your behalf; why is one tap away.
struct Receipt: Identifiable, Equatable, Sendable {
    enum Verb: Equatable, Sendable {
        case read, watched, found

        /// SF glyph for the quiet verb chip.
        var glyph: String {
            switch self {
            case .read: return "book"
            case .watched: return "play.rectangle"
            case .found: return "sparkle.magnifyingglass"
            }
        }
    }

    let id: String
    let verb: Verb
    /// What co did — the delivery, not the description.
    let what: String
    /// Why co did it. Tap to reveal, never inline at rest.
    let why: String
    let url: URL?
    let when: Date
    /// The artifact's face (rail thumb). Default keeps existing call sites source-compatible.
    var imageURL: URL? = nil
    /// A FINDING changed something in the world; only findings show on Home (8/7 teardown killed the activity noise).
    var isFinding: Bool = false
}

/// Something co is actively tracking (price, deadline, thread) — renders as one chip; the label is the whole chip.
struct WatchItem: Identifiable, Equatable, Sendable {
    let id: String
    /// What is being watched, short enough to read as a chip.
    let label: String
    /// Why it is on the list — one line of context, kept for the tap or a later surface.
    let note: String
}
