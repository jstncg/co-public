// Models.swift — client-side mirror of the server data model (goal.md §21.1)
// shared between the app and the share extension.

import Foundation

// MARK: - enums

/// goal.md §11 "supported source types"
enum SourceType: String, Codable, CaseIterable, Sendable {
    case text, voice, image, screenshot, url, article, youtube, podcast
    case shortVideo = "short_video"
    case socialPost = "social_post"
    case aiConversation = "ai_conversation"
    case place, product, person, event, other
}

/// goal.md §27.2 — adapters must report coverage; the ui must reflect it honestly.
enum Coverage: String, Codable, Sendable {
    case fullMedia = "full_media"
    case image
    case text
    case urlOnly = "url_only"
    case unavailable

    /// honest one-liner shown when co cannot inspect the content (goal.md §11).
    var honestLine: String? {
        switch self {
        case .urlOnly:
            return "i have the link, but the app didn’t give me the video itself. what caught you?"
        case .unavailable:
            return "i couldn’t read anything from this. what should i remember about it?"
        case .fullMedia, .image, .text:
            return nil
        }
    }
}

enum ProcessingStatus: String, Codable, Sendable {
    case pending, processing, ready, failed
}

enum Sensitivity: String, Codable, Sendable {
    case normal
    /// jordan journey (goal.md §37): saved without analysis — no extraction,
    /// no embedding, no pattern use, fully deletable.
    case vaultOnly = "vault_only"
}

/// catches-tab filter chips (goal.md §20.1)
enum CatchFacet: String, Codable, CaseIterable, Sendable {
    case all, watch
    case makeReal = "make real"
    case people, places, ideas, media, voice
}

// MARK: - moment

/// a moment: a piece of the world + the exact part that caught the user +
/// the meaning available at that time (goal.md §11).
/// field-for-field mirror of the `artifacts` table (goal.md §21.1),
/// plus client-side fields noted below.
struct Moment: Identifiable, Codable, Hashable, Sendable {
    // artifacts table
    var id: UUID
    var userID: UUID?
    var sourceType: SourceType
    var sourceApp: String?
    var canonicalURL: URL?
    var title: String?
    var publisher: String?
    var creator: String?
    var publishedAt: Date?
    var capturedAt: Date
    var rawObjectPath: String?
    var mimeType: String?
    var rawText: String?
    var transcript: String?
    var thumbnailPath: String?
    var duration: TimeInterval?
    var timestampSeconds: Double?
    var userNote: String?
    var retentionMode: String?
    var sensitivity: Sensitivity = .normal
    var processingStatus: ProcessingStatus = .ready
    var deletedAt: Date?

    // client-side
    /// what the host app actually supplied (goal.md §27.2)
    var coverage: Coverage
    /// the one-line why (annotation type `why`, goal.md §21.1) shown on the card
    var whySignal: String?
    /// which filter chips this moment appears under
    var facets: Set<CatchFacet> = []
}

// MARK: - capture payload (outbox)

/// what the app / share extension queues for background upload.
/// attachments are file names inside the app-group `Attachments/` directory.
struct CapturePayload: Codable, Sendable {
    var sourceType: SourceType
    var coverage: Coverage
    var url: URL?
    var text: String?
    var userNote: String?
    var whyAnswer: String?
    var sourceApp: String?
    var attachmentFilenames: [String] = []
    var sensitivity: Sensitivity = .normal
    var capturedAt: Date = .now
}

// MARK: - patterns (taking shape)

/// pattern card (goal.md §20.2) + detail (§20.5)
struct PatternCard: Identifiable, Hashable, Sendable {
    var id: UUID
    var title: String
    var momentCount: Int
    /// e.g. "medium confidence", "one plan ready", "watched", "still unclear"
    var statusLine: String
    /// co's current read, stated as a hypothesis, never an identity label
    var currentRead: String
    /// receipts: the moments behind the read
    var receiptMomentIDs: [UUID]
    /// other possible explanations — always shown (goal.md §20.5)
    var alternatives: [String]
}

enum PatternVerdict: String, Sendable {
    case right, partly, wrong
}

// MARK: - radar (you should know)

/// radar card (goal.md §15.7, §20.3, §20.6)
struct RadarItem: Identifiable, Hashable, Sendable {
    var id: UUID
    var headline: String
    /// mandatory: why this reached you — must reference explicit user evidence
    var whyReachedYou: [String]
    /// mandatory source receipt
    var sourceLabel: String
    var sourceURL: URL?
    var publishedAgo: String
    var isMuted: Bool = false
}

struct RadarState: Sendable {
    var newItems: [RadarItem]
    /// "waiting" list — watches with nothing new
    var waiting: [String]
    /// shown in the honest empty state: "co is still watching: …"
    var watching: [String]
}

// MARK: - me surface

/// simple inspectable model, not a psychological dashboard (goal.md §13.4, §20.4)
struct MeModel: Sendable {
    var whatKeepsCatchingYou: [String]
    var thingsYouWantMoreOf: [String]
    var standardsCoIsLearning: [String]
    var watching: [String]
    var hypothesesCoIsTesting: [String]
    /// true total from the graph (the catches array is a recent window — same-story law)
    var totalHeld: Int? = nil
    /// co's text number, so "open the thread" lands in the right conversation
    var number: String? = nil
}

// MARK: - today (the delivery room — app charter 8/4)

struct TodayModel: Sendable {
    var read: String?
    var oneThing: String?
    var setup: [String]
    var then: String?
    var done: Bool
}

struct OvernightModel: Sendable {
    var thread: String?
    var line: String
    var url: String?
}

// MARK: - the world's rooms (call-003: Inside-Out — your head has rooms, not a graph)

struct RoomMember: Identifiable, Sendable {
    var id: String { (thumbURL ?? "") + (url ?? "") + note.prefix(24) }
    /// full server thumb URL — nil renders the typographic tile (the words are the picture)
    var thumbURL: String?
    var note: String
    var url: String?
    var kind: String
    var date: String?
}

struct RoomModel: Identifiable, Sendable {
    var id: String { theme }
    var theme: String
    /// one concrete first-move line, their vocabulary (never self-help)
    var whisper: String?
    var count: Int
    var members: [RoomMember]
}

// MARK: - the staff ledger (institution law #2: many hands, one ledger)

struct StaffEntry: Identifiable, Sendable {
    var id: String { ts + what.prefix(24) }
    var ts: String
    /// closed verb set: watched · read · checked · found · researched · drafted
    var verb: String
    var what: String
    /// the reasoning, one tap away (call-003: in reach, never inline)
    var why: String?
    var url: String?
}

// MARK: - the lived test (the flagship loop's output half)

/// Everything else in this app is what co COLLECTED (catches) or CONCLUDED (me, radar,
/// rooms). A lived test is the third thing: what actually changed in your week because of
/// something you sent — still reversible, still owed a verdict.
///
/// It is deliberately NOT a matter list or a task backlog (the-architecture.md: matters are
/// never user-facing). It is the short list of changes you can still take back.
enum LivedTestState: String, Codable, Sendable {
    case proposed, live, endorsed, busy, wrong_read, reversed, declined, expired
}

/// The member's verdict vocabulary. co cannot write any of these (lived.py LAW 4).
enum LivedVerdict: String, Codable, Sendable, CaseIterable {
    case chosen   // yes — my life got more mine
    case busy     // it happened, it just added load
    case wrong    // you misread what I wanted

    var label: String {
        switch self {
        case .chosen: "worth it"
        case .busy: "just made me busier"
        case .wrong: "wrong read"
        }
    }
}

struct LivedTest: Identifiable, Hashable, Sendable {
    var id: String
    var state: LivedTestState
    /// what they encountered
    var resonance: String
    /// the SPECIFIC quality that caught them — never wholesale admiration of the source
    var quality: String
    /// the one reversible thing that entered their week
    var change: String
    /// how it comes back out, in their terms
    var undo: String
    /// what this test would actually teach
    var question: String
    /// their own words that justified it — provenance, shown so they can catch a wrong read
    var because: String
    var url: URL?
    var days: Int
}

struct LivedState: Sendable {
    var live: [LivedTest]
    var proposed: [LivedTest]
    var settled: Int
    var endorsed: Int

    var isEmpty: Bool { live.isEmpty && proposed.isEmpty }
}

// MARK: - privacy vault

/// goal.md §20.7 — defaults are the covenant, not marketing.
struct PrivacySettings: Sendable {
    var sharedModelTraining = false          // off by default, always
    var founderReview = true                 // beta consent, time-boxed
    var founderReviewActiveUntil = "sep 12"  // consent expiry shown to the user
    var rawVoiceRetention = false            // delete audio after transcription
    var proactiveNotesPerWeek = 2            // hard cap (goal.md §18)
    var worldRadar = true
}
