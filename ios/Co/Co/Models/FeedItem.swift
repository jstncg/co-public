import Foundation

struct FeedItem: Identifiable, Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case photo, quote, podcast, post

        /// SF glyph that stands in for the media on a tile and names the kind in detail.
        var glyph: String {
            switch self {
            case .photo: return "photo"
            case .quote: return "quote.opening"
            case .podcast: return "waveform"
            case .post: return "text.alignleft"
            }
        }

        var label: String {
            switch self {
            case .photo: return "Photo"
            case .quote: return "Quote"
            case .podcast: return "Podcast"
            case .post: return "Post"
            }
        }

        /// Leads with a picture — centralized so no surface disagrees on which kinds carry a face.
        var isMedia: Bool { self == .photo || self == .podcast }
    }

    /// What the post carries under its words; nil is a text post, the commonest case, hence the absence not a case.
    enum Media: Equatable, Sendable { case image, video }

    let id: String
    let kind: Kind
    /// width / height. Drives column balancing; a quote tile with no image still needs one.
    let aspectRatio: CGFloat
    let imageURL: URL?
    let text: String?
    let attribution: String?
    // Defaults, not required args — existing call sites and tests spell out the init above and must not break.
    /// Time to consume, already worded ("51 min") — the card footer's ONLY metadata.
    var duration: String?
    /// What the thing is about as 2–3 scannable points — bullets, not a block (reads as homework otherwise).
    var summary: [String] = []
    /// Where to consume it right now. Absent for things that only live here (camera roll).
    var url: URL?
    var tags: [String] = []
    /// What the user wrote under it once it was already kept. Empty is the normal state.
    var note: String = ""
    var savedAt: Date = .distantPast
    var source: String = ""
    var isArchived: Bool = false
    var isHighlight: Bool = false
    /// True for radar finds (co found it, with a why) vs saved items; finds get their own shelf, never the feed.
    var isFind: Bool = false
    // Declared last on purpose — the memberwise init is positional; call sites spell out fields above it.
    /// The account it came from, "@handle" — so the feed can show who wrote it, not just a category.
    var handle: String?
    /// Nil = text post. See `Media`.
    var media: Media?

    /// What the tile leads with. A photo has no body copy, so its caption IS its title.
    var title: String { text ?? attribution ?? "" }

    /// The seed every wash (and avatar) on this item shares, so a person keeps one colour across the feed.
    var authorSeed: String { handle ?? attribution ?? id }

    /// Search predicate over title, attribution, tags; empty/whitespace query matches everything, not nothing.
    func matches(_ query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return true }
        let haystack = [text, attribution].compactMap { $0 } + tags
        return haystack.contains { $0.localizedCaseInsensitiveContains(q) }
    }
}

extension FeedItem {
    /// A server archive item, as a tile — the artifact's face when the rail has one, wash+glyph as fallback.
    init(archiveItem: ArchiveItem) {
        let kind = ArchiveAlbum.kind(for: archiveItem.sourceType)
        let savedAt = CoFormat.date(archiveItem.capturedAt) ?? .distantPast
        self.init(id: archiveItem.artifactId,
                  kind: kind,
                  aspectRatio: 1,
                  imageURL: archiveItem.imageURL,
                  text: archiveItem.title,
                  attribution: archiveItem.publisher,
                  url: archiveItem.canonicalUrl.flatMap(URL.init(string:)),
                  savedAt: savedAt,
                  source: archiveItem.sourceType)
    }
}
