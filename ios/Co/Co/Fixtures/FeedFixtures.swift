import Foundation

// Design material, not filler — one person's coherent story, so the feed reads like it came
// from somewhere. `source` is a PLATFORM name, never a show/blog name (Justin, 2026-08-03).

enum FeedFixtures {
    static func day(_ month: Int, _ day: Int) -> Date {
        DateComponents(calendar: .current, timeZone: .current,
                       year: 2026, month: month, day: day, hour: 9).date ?? .distantPast
    }

    /// Live posts are dated relative to now ("4h", "2d") — a fixed date would read stale by morning.
    static func ago(hours: Double) -> Date { Date.now.addingTimeInterval(-hours * 3600) }

    // MARK: Live — what kyo is putting in front of you
    // Each item carries its own `aspectRatio` so no two cards are the same height (Justin, 2026-08-04).

    static let highlights: [FeedItem] = [
        FeedItem(
            id: "hl-notice", kind: .podcast, aspectRatio: 1.78, imageURL: nil,
            text: "The whole episode is one question: what was the salary actually paying "
                + "for? Worth the 51 minutes.",
            attribution: "Search Engine", duration: "51 min",
            summary: [
                "What walking away from a salary actually takes when your life is built on it",
                "A listener who quit walks through the year after, what the money really "
                    + "covered, what replaced it",
                "The one expense nobody warns you about",
            ],
            url: URL(string: "https://www.youtube.com/watch?v=search-engine-quit"),
            tags: ["Leaving consulting", "Money"],
            savedAt: ago(hours: 3), source: "YouTube",
            isHighlight: true, handle: "@searchengine", media: .video
        ),
    ]

    static let live: [FeedItem] = [
        FeedItem(id: "l-two-things", kind: .post, aspectRatio: 1, imageURL: nil,
                 text: "There's only two things left to sell:\n\nCompute and Context",
                 attribution: "Jake",
                 summary: [
                     "The whole thread argues everything else in software is now a wrapper",
                     "Replies are the good part, three counterexamples, all infrastructure",
                 ],
                 url: URL(string: "https://x.com/JustJake/status/two-things"),
                 tags: ["Work", "Attention"], savedAt: ago(hours: 2), source: "X",
                 handle: "@justjake"),
        FeedItem(id: "hl-lisbon-studio", kind: .photo, aspectRatio: 0.8, imageURL: nil,
                 text: "open studio in alfama. you glaze it, they fire it, you pick it up "
                     + "friday 🏺",
                 attribution: "Cerâmica Alfama",
                 summary: [
                     "An open ceramics studio in Alfama, glaze and fire your own pieces",
                     "Walk-ins during the week, kiln nights on Fridays",
                 ],
                 url: URL(string: "https://www.instagram.com/p/lisbon-open-studio"),
                 tags: ["Ceramics", "Lisbon"], savedAt: ago(hours: 5), source: "Instagram",
                 handle: "@ceramicaalfama", media: .image),
        FeedItem(id: "l-burkeman", kind: .quote, aspectRatio: 1.0, imageURL: nil,
                 text: "You can have anything you want, but not everything.",
                 attribution: "Oliver Burkeman",
                 summary: [
                     "The core of Four Thousand Weeks: finitude is the condition for a "
                         + "meaningful life, not its obstacle",
                     "Choosing anything means paying with everything you didn't choose",
                 ],
                 url: URL(string: "https://x.com/oliverburkeman/status/anything"),
                 tags: ["Time", "Quotes"], savedAt: ago(hours: 7), source: "X",
                 handle: "@oliverburkeman"),
        FeedItem(id: "l-thursday-pots", kind: .post, aspectRatio: 0.5625, imageURL: nil,
                 text: "six of us meet every thursday in a garage in leslieville to make "
                     + "deliberately bad pots. week 31.",
                 attribution: "bad pots club",
                 summary: [
                     "A Toronto group that makes pots badly on purpose, every Thursday",
                     "No keeping, no selling, no improving, the point is the Thursday, "
                         + "not the pots",
                 ],
                 url: URL(string: "https://www.instagram.com/reel/thursday-pots"),
                 tags: ["Ceramics", "Toronto"], savedAt: ago(hours: 9), source: "Instagram",
                 handle: "@badpotsclub", media: .video),
        FeedItem(id: "l-no-income", kind: .post, aspectRatio: 1, imageURL: nil,
                 text: "nobody tells you the expensive part of a year off isn't rent. it's "
                     + "the dental plan you didn't think about once in nine years.",
                 attribution: "Priya Raman",
                 summary: [
                     "A line-item breakdown of a year without a paycheque",
                     "The cash number, the insurance gaps, and the part that isn't money "
                         + "at all",
                 ],
                 url: URL(string: "https://x.com/priyaraman/status/no-income"),
                 tags: ["Money", "Leaving consulting"], savedAt: ago(hours: 13),
                 source: "X", handle: "@priyaraman"),
        FeedItem(id: "l-ando-stair", kind: .photo, aspectRatio: 1.33, imageURL: nil,
                 text: "Ando, Church of the Light stair. No handrail. Nobody has ever "
                     + "fallen down it.",
                 attribution: "concrete daily",
                 summary: [
                     "An unguarded Ando stair in raw concrete",
                     "The reference for how far restraint can go before it stops being "
                         + "generous",
                 ],
                 url: URL(string: "https://www.instagram.com/p/ando-stair"),
                 tags: ["Architecture", "Concrete"], savedAt: ago(hours: 20),
                 source: "Instagram", handle: "@concretedaily", media: .image),
        FeedItem(id: "l-hische", kind: .quote, aspectRatio: 1.78, imageURL: nil,
                 text: "The work you do while you procrastinate is probably the work you "
                     + "should be doing for the rest of your life.",
                 attribution: "Jessica Hische", duration: "12 min",
                 summary: [
                     "The procrastiwork idea, from a lettering talk",
                     "The work you drift to while avoiding your real work is a compass, "
                         + "not a leak",
                 ],
                 url: URL(string: "https://www.youtube.com/watch?v=hische-procrastiwork"),
                 tags: ["Work", "Quotes"], savedAt: ago(hours: 27), source: "YouTube",
                 handle: "@jessicahische", media: .video),
        FeedItem(id: "l-studio-rent", kind: .post, aspectRatio: 1, imageURL: nil,
                 text: "Rent on a shared studio in the east end fell twelve percent this "
                     + "spring and nobody wrote about it.",
                 attribution: "Small Rooms",
                 summary: [
                     "East-end shared-studio rents fell twelve percent this spring",
                     "Every headline watched housing instead, the listing data is in "
                         + "the piece",
                 ],
                 url: URL(string: "https://smallrooms.substack.com/p/east-end-studios"),
                 tags: ["Toronto", "Studios"], savedAt: ago(hours: 34), source: "Substack",
                 handle: "@smallrooms"),
        FeedItem(id: "l-hands-wheel", kind: .photo, aspectRatio: 1.5, imageURL: nil,
                 text: "thirty seconds before this collapsed. posting it anyway.",
                 attribution: "Ellen Mori",
                 summary: [
                     "A throwing sequence caught thirty seconds before the collapse",
                     "Most attempts end this way, and that's fine",
                 ],
                 url: URL(string: "https://www.instagram.com/p/hands-wheel"),
                 tags: ["Ceramics", "Process"], savedAt: ago(hours: 41),
                 source: "Instagram", handle: "@ellenmori", media: .image),
        FeedItem(id: "l-friends-thirty", kind: .post, aspectRatio: 0.5625, imageURL: nil,
                 text: "making friends after 30 is a logistics problem, not a personality "
                     + "one. the three-invite rule 👇",
                 attribution: "hana",
                 summary: [
                     "Adult friendship is a logistics problem, not a personality one",
                     "The three-invite rule that turns acquaintances into people who "
                         + "show up",
                 ],
                 url: URL(string: "https://www.tiktok.com/@hanadoesthings/three-invites"),
                 tags: ["Friendship", "Adulthood"], savedAt: ago(hours: 50),
                 source: "TikTok", handle: "@hanadoesthings", media: .video),
        FeedItem(id: "l-mead-city", kind: .quote, aspectRatio: 1, imageURL: nil,
                 text: "A city is a place where there is no need to wait for next week to "
                     + "get the answer to a question.",
                 attribution: "Margaret Mead",
                 summary: [
                     "Mead on density as access",
                     "A city collapses the distance between a question and the person "
                         + "who can answer it",
                 ],
                 tags: ["Cities", "Quotes"], savedAt: ago(hours: 62), source: "X",
                 handle: "@meadquotes"),
        FeedItem(id: "l-kiln-queue", kind: .post, aspectRatio: 1.2, imageURL: nil,
                 text: "The community kiln has a six week queue. People bring folding chairs "
                     + "and wait together on firing day.",
                 attribution: "r/ceramics",
                 summary: [
                     "The community kiln runs a six-week backlog",
                     "Firing day became a scene, folding chairs, thermoses, strangers "
                         + "turned regulars",
                 ],
                 url: URL(string: "https://www.reddit.com/r/ceramics/kiln-queue"),
                 tags: ["Ceramics", "Toronto"], savedAt: ago(hours: 77), source: "Reddit",
                 handle: "u/potterbot", media: .image),
    ]

    // MARK: Archive — what you already kept, and tagged

    static let archived: [FeedItem] = [
        FeedItem(id: "a-gave-notice", kind: .post, aspectRatio: 0.85, imageURL: nil,
                 text: "I gave notice on a Tuesday. Nobody at the firm reacted the way I had "
                     + "rehearsed it.",
                 attribution: "Michael Ashcroft",
                 summary: [
                     "The confrontation he rehearsed for weeks never arrived",
                     "The anticlimax taught him how much of the fear was furniture he'd "
                         + "built himself",
                 ],
                 url: URL(string: "https://michaelashcroft.substack.com/p/gave-notice"),
                 tags: ["Leaving consulting", "Essays", "Courage"],
                 savedAt: day(6, 14), source: "Substack", isArchived: true),
        FeedItem(id: "a-first-kiln", kind: .photo, aspectRatio: 0.75, imageURL: nil,
                 text: nil, attribution: "First kiln load. All four of them cracked.",
                 summary: [
                     "Your first kiln load, June, all four pieces cracked",
                     "Kept as the baseline everything since gets measured against",
                 ],
                 tags: ["Ceramics", "First tries"],
                 savedAt: day(6, 2), source: "Photos", isArchived: true),
        FeedItem(id: "a-rand", kind: .quote, aspectRatio: 1.0, imageURL: nil,
                 text: "Do not be an artist. Be an artisan. The difference is the deadline.",
                 attribution: "Paul Rand",
                 summary: [
                     "Deadlines, not inspiration, separate craft from art",
                     "Craft is the one that ships",
                 ],
                 tags: ["Craft", "Quotes", "Work"],
                 savedAt: day(5, 30), source: "Notes", isArchived: true),
        FeedItem(id: "a-sabbatical", kind: .podcast, aspectRatio: 1.0, imageURL: nil,
                 text: "The sabbatical nobody budgets for",
                 attribution: "Longform", duration: "62 min",
                 summary: [
                     "Three writers on funding a year off, what they saved, what they sold",
                     "Where the money actually went, against where they planned for it "
                         + "to go",
                 ],
                 url: URL(string: "https://podcasts.apple.com/podcast/longform"),
                 tags: ["Leaving consulting", "Money", "Podcasts"],
                 savedAt: day(5, 19), source: "Apple Podcasts", isArchived: true),
        FeedItem(id: "a-alfama", kind: .photo, aspectRatio: 1.5, imageURL: nil,
                 text: nil, attribution: "Alfama from the tram window, eleven in the morning",
                 summary: [
                     "Alfama from the 28 tram, eleven in the morning",
                     "The morning the Lisbon thread started",
                 ],
                 tags: ["Lisbon", "Travel", "Light"],
                 savedAt: day(5, 4), source: "Photos", isArchived: true),
        FeedItem(id: "a-boring-mornings", kind: .post, aspectRatio: 0.9, imageURL: nil,
                 text: "Every good year of my life started with a boring, identical morning.",
                 attribution: "Anne Helen Petersen",
                 summary: [
                     "Identical mornings lower the cost of every ambitious thing stacked "
                         + "on top of them",
                     "Petersen's case for making them boring on purpose",
                 ],
                 url: URL(string: "https://annehelen.substack.com/p/boring-mornings"),
                 tags: ["Mornings", "Habits", "Essays"],
                 savedAt: day(4, 21), source: "Substack", isArchived: true),
        FeedItem(id: "a-glaze-recipe", kind: .quote, aspectRatio: 0.95, imageURL: nil,
                 text: "Glaze is just rock that has agreed to melt at a temperature you can "
                     + "afford.",
                 attribution: "Ellen, Tuesday night class",
                 summary: [
                     "Glaze is rock, heat, and a budget",
                     "Everything past that is preference",
                 ],
                 tags: ["Ceramics", "Craft"],
                 savedAt: day(4, 8), source: "Notes", isArchived: true),
        // Every archived tag carries at least three saves — a shelf with one item renders oddly.
        FeedItem(id: "a-wedgwood", kind: .quote, aspectRatio: 0.95, imageURL: nil,
                 text: "I have made a thousand of these and the thousandth is the first one "
                     + "I would sell.",
                 attribution: "Josiah Wedgwood",
                 summary: [
                     "Repetition as the price of a piece worth selling",
                     "The number is the point, not the talent",
                 ],
                 tags: ["Ceramics", "Craft", "Quotes"],
                 savedAt: day(4, 2), source: "Notes", isArchived: true),
        FeedItem(id: "a-kiln-log", kind: .photo, aspectRatio: 0.8, imageURL: nil,
                 text: nil, attribution: "Kiln log, page one, every firing since June",
                 summary: [
                     "Cone, hold time and result for every firing since June",
                     "The cracks stop around firing nine",
                 ],
                 tags: ["Ceramics", "First tries"],
                 savedAt: day(3, 27), source: "Photos", isArchived: true),
        FeedItem(id: "a-severance", kind: .post, aspectRatio: 0.9, imageURL: nil,
                 text: "Severance is not a windfall. It is the last invoice for the years you "
                     + "already worked.",
                 attribution: "Ramit Sethi",
                 summary: [
                     "Treating severance as runway rather than a bonus",
                     "What to move first, and what to leave alone for a year",
                 ],
                 url: URL(string: "https://iwillteachyoutoberich.com/severance"),
                 tags: ["Leaving consulting", "Money", "Essays", "Work"],
                 savedAt: day(3, 19), source: "Substack", isArchived: true),
        FeedItem(id: "a-tile-market", kind: .photo, aspectRatio: 1.4, imageURL: nil,
                 text: nil, attribution: "Feira da Ladra, the tile stall, before the crowd",
                 summary: [
                     "The tile stall at Feira da Ladra, eight in the morning",
                     "Half of these are broken, which is why they were affordable",
                 ],
                 tags: ["Lisbon", "Travel", "Light"],
                 savedAt: day(3, 11), source: "Photos", isArchived: true),
        FeedItem(id: "a-azulejo", kind: .photo, aspectRatio: 0.7, imageURL: nil,
                 text: nil, attribution: "Azulejo wall, Graça, four in the afternoon",
                 summary: [
                     "One wall in Graça, photographed for the glaze rather than the pattern",
                     "The blue is cobalt over tin, the reason the white stays white",
                 ],
                 tags: ["Lisbon", "Travel", "Light"],
                 savedAt: day(3, 4), source: "Photos", isArchived: true),
        FeedItem(id: "a-quit-letter", kind: .quote, aspectRatio: 1.0, imageURL: nil,
                 text: "Courage is not the absence of the rehearsed speech. It is sending the "
                     + "email before you have rehearsed it.",
                 attribution: "Sasha Chapin",
                 summary: [
                     "The rehearsal is the avoidance, not the preparation",
                     "Sending it unrehearsed is the whole act",
                 ],
                 tags: ["Courage", "Quotes", "Leaving consulting"],
                 savedAt: day(2, 26), source: "Notes", isArchived: true),
        FeedItem(id: "a-morning-pages", kind: .post, aspectRatio: 0.85, imageURL: nil,
                 text: "Three pages, longhand, before anything else. They are not meant to be "
                     + "good and they are not meant to be read.",
                 attribution: "Julia Cameron",
                 summary: [
                     "The pages exist to clear the queue, not to produce writing",
                     "Reading them back is the one rule that breaks the habit",
                 ],
                 url: URL(string: "https://juliacameronlive.com/morning-pages"),
                 tags: ["Mornings", "Habits", "Essays"],
                 savedAt: day(2, 18), source: "Substack", isArchived: true),
        FeedItem(id: "a-five-am", kind: .quote, aspectRatio: 1.05, imageURL: nil,
                 text: "The hour you protect is the hour that decides the year.",
                 attribution: "Kevin Kelly",
                 summary: [
                     "One protected hour outranks a well-planned week",
                     "Protection means it is booked against other people, not yourself",
                 ],
                 tags: ["Mornings", "Habits", "Quotes"],
                 savedAt: day(2, 9), source: "Notes", isArchived: true),
        FeedItem(id: "a-runway-math", kind: .podcast, aspectRatio: 1.0, imageURL: nil,
                 text: "Runway math for people who hate spreadsheets",
                 attribution: "Hard Fork", duration: "44 min",
                 summary: [
                     "Three numbers that decide how long a year off actually lasts",
                     "The month-by-month version, without a model to maintain",
                 ],
                 url: URL(string: "https://podcasts.apple.com/podcast/hard-fork"),
                 tags: ["Money", "Podcasts", "Leaving consulting"],
                 savedAt: day(2, 1), source: "Apple Podcasts", isArchived: true),
        FeedItem(id: "a-studio-hours", kind: .post, aspectRatio: 0.9, imageURL: nil,
                 text: "Studio hours are not the hours you feel like working. They are the "
                     + "hours the studio is open.",
                 attribution: "Anna Wilcox",
                 summary: [
                     "Booked hours beat inspired ones, in ceramics more than most",
                     "The wheel is busy at seven whether or not you showed up",
                 ],
                 url: URL(string: "https://annawilcox.substack.com/p/studio-hours"),
                 tags: ["Craft", "Work", "Ceramics"],
                 savedAt: day(1, 24), source: "Substack", isArchived: true),
        FeedItem(id: "a-first-sale", kind: .photo, aspectRatio: 1.2, imageURL: nil,
                 text: nil, attribution: "First piece someone paid for. Twenty-two dollars.",
                 summary: [
                     "The first mug that sold, at the Sunday market table",
                     "Twenty-two dollars, and the photograph cost more to take",
                 ],
                 tags: ["Ceramics", "First tries", "Courage"],
                 savedAt: day(1, 15), source: "Photos", isArchived: true),
        FeedItem(id: "a-clay-podcast", kind: .podcast, aspectRatio: 1.0, imageURL: nil,
                 text: "The potter who fires once a month",
                 attribution: "Clay Cast", duration: "38 min",
                 summary: [
                     "One firing a month, and what that does to how she throws",
                     "Scarcity as a quality control that costs nothing",
                 ],
                 url: URL(string: "https://podcasts.apple.com/podcast/clay-cast"),
                 tags: ["Podcasts", "Ceramics", "Craft"],
                 savedAt: day(1, 6), source: "Apple Podcasts", isArchived: true),
    ]

    static let all: [FeedItem] = highlights + live + archived
}
