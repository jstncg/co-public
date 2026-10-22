import Foundation

// The one Home surface that shows CONSEQUENCE — a reversible change that happened, not
// what Co merely collected or concluded. Deliberately not a task list; capped server-side (frame/claims/lived.py).

/// Where a change sits; only `proposed` and `live` render — the rest are history, not a to-do list.
enum LivedTestState: String, Codable, Sendable {
    case proposed, live, endorsed, busy, wrongRead = "wrong_read", reversed, declined, expired
}

/// The member's verdict vocabulary — Co can write none of these (lived.py LAW 4: only the person sets `endorsed`).
enum LivedVerdict: String, Codable, Sendable, CaseIterable {
    case chosen   // yes, my life got more mine
    case busy     // it happened and it only added load
    case wrong    // you misread what I wanted

    var label: String {
        switch self {
        case .chosen: return "worth it"
        case .busy: return "just made me busier"
        case .wrong: return "wrong read"
        }
    }
}

struct LivedTest: Identifiable, Equatable, Sendable {
    let id: String
    let state: LivedTestState
    /// What they encountered.
    let resonance: String
    /// The SPECIFIC quality that caught them — never wholesale admiration of the source (goal-v4 §5.3).
    let quality: String
    /// The one reversible thing that entered their week.
    let change: String
    /// How it comes back out, in their words — never truncated in the UI (an unreadable promise isn't one).
    let undo: String
    /// What this would actually teach Co about them.
    let question: String
    /// Their own words that justified it. Shown at rest so a wrong read is catchable.
    let because: String
    let url: URL?
    /// Days since the change went live (or since it was proposed).
    let days: Int
}

/// What Home carries; `settled`/`endorsed` are quiet proof it's been real before — never a streak or score.
struct LivedState: Equatable, Sendable {
    var live: [LivedTest]
    var proposed: [LivedTest]
    var settled: Int
    var endorsed: Int

    static let empty = LivedState(live: [], proposed: [], settled: 0, endorsed: 0)
    var isEmpty: Bool { live.isEmpty && proposed.isEmpty }
}
