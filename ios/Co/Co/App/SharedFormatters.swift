import Foundation

/// One shared ISO-8601 parser. Constructing a formatter is expensive (~0.1ms + allocation);
/// the home and archive decoders were building a fresh one PER ITEM, on every refresh —
/// the textbook iOS hot-path allocation. ISO8601DateFormatter is documented thread-safe for
/// parsing, so a single instance is a pure win with no behavior change: same default config
/// (internet date-time, the "…Z" the rail emits), same parse result.
enum CoFormat {
    // nonisolated(unsafe): ISO8601DateFormatter is documented thread-safe for parsing, but
    // it isn't Sendable, so Swift 6 needs the explicit vouch. We only ever READ (parse), so
    // there is no shared mutable state in practice.
    nonisolated(unsafe) static let iso8601 = ISO8601DateFormatter()

    /// The rail's timestamps, parsed to a Date. Callers keep their own fallback.
    static func date(_ raw: String) -> Date? { iso8601.date(from: raw) }
}
