import Foundation

/// A page. v0.8 (Justin, 2026-08-10): pages carry a NAME, not a date — "relationships", "work",
/// whatever the member actually calls it. The day survives because the open page still shows it,
/// and because the Today page is created for them rather than named by them.
struct Note: Identifiable, Codable, Equatable {
    let id: String
    /// What the member calls this page. The row's first line.
    var title: String
    /// Midnight of the day this page belongs to — the numeral the open page shows.
    var day: Date
    /// Last edited. Drives both the row's date and the Recent ordering.
    var updatedAt: Date
    /// One entry per thing deposited. Kept as lines, not one blob, so the row can preview the
    /// top of the page and co can point at the single line it derived a project from.
    var lines: [String]

    init(id: String = UUID().uuidString, title: String, day: Date,
         updatedAt: Date? = nil, lines: [String] = []) {
        self.id = id
        self.title = title
        self.day = day
        self.updatedAt = updatedAt ?? day
        self.lines = lines
    }

    var isToday: Bool { Calendar.current.isDateInToday(day) }

    /// The row's second line: the top of the page, run together. Truncation is the row's job,
    /// not this property's — it never pre-clips.
    var preview: String { lines.joined(separator: "  ") }

    /// "Aug 8, 2026" — the row's last-edited stamp.
    var lastEdited: String { Note.stamp.string(from: updatedAt) }

    /// "10", "08" — always two digits, so every numeral has the same optical weight.
    var dayNumeral: String {
        String(format: "%02d", Calendar.current.component(.day, from: day))
    }
    /// "Monday"
    var weekdayName: String { Note.weekday.string(from: day) }
    /// "August 10"
    var monthDay: String { Note.monthDay.string(from: day) }

    private static let weekday = Note.formatter("EEEE")
    private static let monthDay = Note.formatter("MMMM d")
    private static let stamp: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.dateFormat = "MMM d, yyyy"
        return formatter
    }()

    private static func formatter(_ template: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter
    }
}
