// DemoData.swift — deterministic seeded demo journeys (goal.md §37)
// used for previews, screenshots, ui development, and demo mode.
// primary journey: maya (creative room). radar mixes in alex/priya signals.

import Foundation

enum DemoData {

    private static func date(daysAgo: Int, hour: Int, minute: Int) -> Date {
        var components = Calendar.current.dateComponents([.year, .month, .day], from: .now)
        components.day! -= daysAgo
        components.hour = hour
        components.minute = minute
        return Calendar.current.date(from: components) ?? .now
    }

    // stable ids so previews and tests are deterministic
    static let potteryReelID = UUID(uuidString: "AA000000-0000-0000-0000-000000000001")!
    static let dinnerShotID = UUID(uuidString: "AA000000-0000-0000-0000-000000000002")!
    static let bookClubID = UUID(uuidString: "AA000000-0000-0000-0000-000000000003")!
    static let thirdPlaceID = UUID(uuidString: "AA000000-0000-0000-0000-000000000004")!
    static let voiceNoteID = UUID(uuidString: "AA000000-0000-0000-0000-000000000005")!
    static let creativeRoomPatternID = UUID(uuidString: "BB000000-0000-0000-0000-000000000001")!

    // MARK: maya's moments (§37: creative room)

    static let mayaMoments: [Moment] = [
        Moment(
            id: potteryReelID,
            sourceType: .shortVideo,
            sourceApp: "instagram",
            canonicalURL: URL(string: "https://www.instagram.com/reel/demo-pottery"),
            title: "six women, thursday ceramics",
            creator: "@claystudio.la",
            capturedAt: date(daysAgo: 0, hour: 12, minute: 41),
            coverage: .urlOnly,
            whySignal: "the people mattered more than the pottery",
            facets: [.people, .media]
        ),
        Moment(
            id: dinnerShotID,
            sourceType: .screenshot,
            sourceApp: "instagram",
            title: "communal dinner, long table",
            capturedAt: date(daysAgo: 1, hour: 21, minute: 4),
            coverage: .image,
            whySignal: "twelve people who cook together monthly",
            facets: [.people, .places]
        ),
        Moment(
            id: bookClubID,
            sourceType: .socialPost,
            sourceApp: "x",
            canonicalURL: URL(string: "https://x.com/demo/status/bookclub"),
            title: "book club that outlived four apartments",
            capturedAt: date(daysAgo: 3, hour: 8, minute: 55),
            coverage: .text,
            whySignal: "a room that survived everyone moving",
            facets: [.people, .ideas]
        ),
        Moment(
            id: thirdPlaceID,
            sourceType: .youtube,
            canonicalURL: URL(string: "https://www.youtube.com/watch?v=demo-thirdplace&t=754"),
            title: "why third places disappeared",
            creator: "the urbanist",
            capturedAt: date(daysAgo: 5, hour: 19, minute: 22),
            timestampSeconds: 754,
            coverage: .fullMedia,
            whySignal: "the 12:34 mark: rooms need a fixed day",
            facets: [.ideas, .media]
        ),
        Moment(
            id: voiceNoteID,
            sourceType: .voice,
            capturedAt: date(daysAgo: 6, hour: 23, minute: 12),
            transcript: "everyone i find interesting makes something. i don't have a room like that.",
            duration: 19,
            coverage: .fullMedia,
            whySignal: "something i want to change",
            facets: [.voice, .ideas]
        ),

        // image-rich filler (8/4 — "add more mock images, even links and such"):
        // the demo world should look ALIVE. picsum images are stable and keyless.
        Moment(id: UUID(uuidString: "AA000000-0000-0000-0000-000000000006")!,
               sourceType: .youtube, sourceApp: "youtube",
               canonicalURL: URL(string: "https://www.youtube.com/watch?v=demo-onelens"),
               title: "the studio that shoots everything on one lens",
               creator: "process breakdown, 18 min",
               capturedAt: date(daysAgo: 0, hour: 9, minute: 12),
               thumbnailPath: "https://picsum.photos/seed/co-lens/640/420",
               coverage: .fullMedia, whySignal: "constraints as a style engine", facets: [.media]),
        Moment(id: UUID(uuidString: "AA000000-0000-0000-0000-000000000007")!,
               sourceType: .shortVideo, sourceApp: "instagram",
               canonicalURL: URL(string: "https://www.instagram.com/reel/demo-sauna-build"),
               title: "backyard sauna build, four weekends",
               creator: "@cedarandsteam",
               capturedAt: date(daysAgo: 1, hour: 19, minute: 3),
               thumbnailPath: "https://picsum.photos/seed/co-sauna/640/640",
               coverage: .fullMedia, whySignal: "the permit part looked easier than feared",
               facets: [.media, .makeReal]),
        Moment(id: UUID(uuidString: "AA000000-0000-0000-0000-000000000008")!,
               sourceType: .article, sourceApp: "safari",
               canonicalURL: URL(string: "https://www.hearthandcoal.com/essays/third-places"),
               title: "why every city lost its third places",
               publisher: "hearth & coal",
               capturedAt: date(daysAgo: 1, hour: 23, minute: 41),
               thumbnailPath: "https://picsum.photos/seed/co-thirdplace/640/400",
               coverage: .text, whySignal: "names the thing the dinners are for", facets: [.ideas]),
        Moment(id: UUID(uuidString: "AA000000-0000-0000-0000-000000000009")!,
               sourceType: .socialPost, sourceApp: "x",
               canonicalURL: URL(string: "https://x.com/naval/status/demo"),
               title: "thread on small games vs status games",
               creator: "@naval",
               capturedAt: date(daysAgo: 2, hour: 8, minute: 55),
               coverage: .text, whySignal: "the sentence about rented status stuck", facets: [.ideas]),
        Moment(id: UUID(uuidString: "AA000000-0000-0000-0000-00000000000A")!,
               sourceType: .image, sourceApp: "camera",
               title: "sunday market haul",
               capturedAt: date(daysAgo: 2, hour: 11, minute: 30),
               thumbnailPath: "https://picsum.photos/seed/co-market/640/480",
               coverage: .image, facets: [.media]),
        Moment(id: UUID(uuidString: "AA000000-0000-0000-0000-00000000000B")!,
               sourceType: .podcast, sourceApp: "podcasts",
               canonicalURL: URL(string: "https://podcasts.apple.com/podcast/demo-founders"),
               title: "the ceramicist who quit consulting",
               creator: "how i built this, ep 402",
               capturedAt: date(daysAgo: 3, hour: 7, minute: 45),
               thumbnailPath: "https://picsum.photos/seed/co-podcast/640/640",
               coverage: .urlOnly, whySignal: "her first year numbers, minute 24",
               facets: [.media, .people]),
        Moment(id: UUID(uuidString: "AA000000-0000-0000-0000-00000000000C")!,
               sourceType: .url, sourceApp: "safari",
               canonicalURL: URL(string: "https://kilnstudio.tokyo/residency"),
               title: "tokyo winter residency — applications open",
               publisher: "kiln studio",
               capturedAt: date(daysAgo: 3, hour: 22, minute: 18),
               thumbnailPath: "https://picsum.photos/seed/co-tokyo/640/420",
               coverage: .urlOnly, whySignal: "deadline oct 1. you paused on it twice.",
               facets: [.makeReal, .places]),
        Moment(id: UUID(uuidString: "AA000000-0000-0000-0000-00000000000E")!,
               sourceType: .shortVideo, sourceApp: "tiktok",
               canonicalURL: URL(string: "https://www.tiktok.com/@studiofire/video/demo"),
               title: "raku firing at night, no commentary",
               creator: "@studiofire",
               capturedAt: date(daysAgo: 4, hour: 20, minute: 33),
               thumbnailPath: "https://picsum.photos/seed/co-raku/640/800",
               coverage: .fullMedia, facets: [.media]),
        Moment(id: UUID(uuidString: "AA000000-0000-0000-0000-00000000000F")!,
               sourceType: .article, sourceApp: "safari",
               canonicalURL: URL(string: "https://longform.demo/the-second-studio"),
               title: "the second studio problem",
               publisher: "longform",
               capturedAt: date(daysAgo: 5, hour: 13, minute: 2),
               thumbnailPath: "https://picsum.photos/seed/co-secondstudio/640/400",
               coverage: .text, whySignal: "scaling a craft without losing the hands",
               facets: [.ideas]),
        Moment(id: UUID(uuidString: "AA000000-0000-0000-0000-000000000010")!,
               sourceType: .image, sourceApp: "screenshots",
               title: "glaze recipe from the workshop whiteboard",
               capturedAt: date(daysAgo: 5, hour: 16, minute: 44),
               thumbnailPath: "https://picsum.photos/seed/co-glaze/640/480",
               coverage: .image, facets: [.media, .ideas]),
        Moment(id: UUID(uuidString: "AA000000-0000-0000-0000-000000000011")!,
               sourceType: .youtube, sourceApp: "youtube",
               canonicalURL: URL(string: "https://www.youtube.com/watch?v=demo-kiln-tour"),
               title: "12 kilns, one warehouse — oakland collective tour",
               creator: "27 min",
               capturedAt: date(daysAgo: 6, hour: 18, minute: 20),
               thumbnailPath: "https://picsum.photos/seed/co-warehouse/640/420",
               coverage: .fullMedia, whySignal: "shared kilns halve the startup cost",
               facets: [.media, .places, .makeReal]),
    ]

    // MARK: patterns (§20.2 card copy, §20.5 detail, maya pattern from §37)

    static let patterns: [PatternCard] = [
        PatternCard(
            id: creativeRoomPatternID,
            title: "a regular creative room",
            momentCount: 6,
            statusLine: "6 moments · medium confidence",
            currentRead: "you may want recurring creative participation more than a specific hobby.",
            receiptMomentIDs: [potteryReelID, dinnerShotID, bookClubID, thirdPlaceID, voiceNoteID],
            alternatives: [
                "the aesthetic",
                "a broader desire for new friends",
                "nostalgia for being a beginner",
            ]
        ),
        PatternCard(
            id: UUID(uuidString: "BB000000-0000-0000-0000-000000000002")!,
            title: "hosting more at home",
            momentCount: 7,
            statusLine: "7 moments · one plan ready",
            currentRead: "the saves cluster around hosting people, not decorating.",
            receiptMomentIDs: [dinnerShotID],
            alternatives: ["seasonal mood", "one friend's influence"]
        ),
        PatternCard(
            id: UUID(uuidString: "BB000000-0000-0000-0000-000000000003")!,
            title: "systems thinking",
            momentCount: 13,
            statusLine: "13 moments · watched",
            currentRead: "an active interest you asked co to watch.",
            receiptMomentIDs: [thirdPlaceID],
            alternatives: ["professional research, not personal interest"]
        ),
        PatternCard(
            id: UUID(uuidString: "BB000000-0000-0000-0000-000000000004")!,
            title: "work that feels more meaningful",
            momentCount: 9,
            statusLine: "9 moments · still unclear",
            currentRead: "something here keeps catching you. co doesn't have a clean read yet.",
            receiptMomentIDs: [voiceNoteID],
            alternatives: ["burnout, not direction", "one bad week overweighted"]
        ),
    ]

    // MARK: radar (§20.3 / §20.6; alex + priya journeys)

    static let radar = RadarState(
        newItems: [
            RadarItem(
                id: UUID(uuidString: "CC000000-0000-0000-0000-000000000001")!,
                headline: "“the rise of systems thinkers” just released",
                whyReachedYou: [
                    "you asked co to watch systems thinking podcasts",
                    "relevant to 2 active threads",
                ],
                sourceLabel: "podcast feed",
                sourceURL: URL(string: "https://example.com/systems-thinkers-episode"),
                publishedAgo: "3h ago"
            ),
            RadarItem(
                id: UUID(uuidString: "CC000000-0000-0000-0000-000000000002")!,
                headline: "andera launched today",
                whyReachedYou: [
                    "you explicitly asked co to watch andera",
                    "you said launches are moments you often notice late",
                ],
                sourceLabel: "public launch post",
                sourceURL: URL(string: "https://example.com/andera-launch"),
                publishedAgo: "2h ago"
            ),
        ],
        waiting: [
            "andera launch",
            "ceramics registration opens friday",
        ],
        watching: ["andera", "systems thinking", "local creative rooms"]
    )

    // MARK: me surface (§20.4)

    static let me = MeModel(
        whatKeepsCatchingYou: [
            "recurring creative rooms",
            "systems thinking",
            "lives built around making",
        ],
        thingsYouWantMoreOf: [
            "people who do things together",
            "work with clearer ownership",
        ],
        standardsCoIsLearning: [
            "recurring > one-off",
            "intimate > crowded",
            "thoughtful > polished",
        ],
        watching: [
            "andera",
            "systems thinking podcasts",
        ],
        hypothesesCoIsTesting: [
            "the room matters more than the craft",
            "you host when the group is under eight people",
        ]
    )
}
