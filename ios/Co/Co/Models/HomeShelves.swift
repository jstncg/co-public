import Foundation

/// A piece of media co pulled for the member — a video, an article, an episode. Fed by the
/// rail's radar finds; fixture-seeded in Debug like every Home shelf.
struct ForYouItem: Identifiable, Equatable {
    let id: String
    var title: String
    var source: String
    /// "12 min", "48 min listen" — the cost of the card, said up front. Empty when the rail
    /// does not know it; the card hides the dot, not the row.
    var length: String
    var kind: ForYouKind
    var url: URL?
}

/// What taking the card costs the member's attention: eyes, eyes-and-time, or ears.
enum ForYouKind: String, Equatable {
    case watch, read, listen

    var label: String { rawValue.capitalized }

    var symbol: String {
        switch self {
        case .watch: return "play.fill"
        case .read: return "text.alignleft"
        case .listen: return "headphones"
        }
    }
}

/// One thing co did while the member was away. A receipt, not a task — there is nothing to do
/// but know it happened, which is why the card carries no chevron and no destination.
struct RecapItem: Identifiable, Equatable {
    let id: String
    var line: String
    var symbol: String
}

/// One thing co believes about the member. `line` empty = a slot co has not filled yet — the
/// slot still draws, saying so, because hiding it would hide what co is trying to learn.
struct ProfileFact: Identifiable, Equatable {
    let id: String
    var title: String
    var line: String
    var symbol: String
}

