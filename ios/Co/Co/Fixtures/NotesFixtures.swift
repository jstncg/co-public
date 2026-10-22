import Foundation

/// Offline design data for Home, reachable only under `-coFixtures` — same law as the other
/// fixture files: an ordinary launch never substitutes someone else's pages. Names are what a
/// person actually calls a page, not dates (Justin, 2026-08-10).
enum NotesFixtures {
    static var board: [Note] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        func day(_ back: Int) -> Date {
            calendar.date(byAdding: .day, value: -back, to: today) ?? today
        }
        return [
            Note(id: "note-today", title: "Today", day: today, lines: [
                "i want to start working on cuz",
                "look into gym memberships — cold plunge and sauna are non-negotiable",
                "reach out to ren ito",
            ]),
            Note(id: "note-frameworks", title: "frameworks for thinking", day: day(1), lines: [
                "the clock starts the first time you meet someone",
                "everyone should see compounded growth in you the next time you meet",
                "people hate decisions but love the illusion of optionality",
            ]),
            Note(id: "note-relationships", title: "relationships", day: day(2), lines: [
                "respond to dated lead",
                "sa — has not heard from me since the spring",
                "ren ito, five weeks",
            ]),
            Note(id: "note-work", title: "work", day: day(3), lines: [
                "unfair distribution advantage — what is ours",
                "the repo cleanup before anything ships to isabel",
                "ask brett for the intro",
            ]),
            Note(id: "note-newyork", title: "new york", day: day(5), lines: [
                "best price-to-quantity food spots",
                "a slice a day, joe's or scarr's",
                "thursday 7:30am flight, thirty days",
            ]),
            Note(id: "note-wants", title: "wants", day: day(8), lines: [
                "a gym with a cold plunge AND a sauna",
                "camera — figure out what i would actually shoot",
            ]),
            Note(id: "note-research", title: "research", day: day(11), lines: [
                "map the space before claiming the approach is novel",
                "how it scored that high on arc-agi, and how to beat it",
            ]),
            Note(id: "note-random", title: "random", day: day(14), lines: [
                "nostalgia is a real feeling and my favourite foods are all nostalgic ones",
                "the burrito spot is not the best burrito, it is the familiar one",
            ]),
            Note(id: "note-struggles", title: "struggles", day: day(19), lines: [
                "lack of direction in between things",
                "i overthink how hard it is to start",
            ]),
        ]
    }
}
