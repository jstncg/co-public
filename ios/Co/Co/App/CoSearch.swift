import Foundation

/// One query, shared by every page. The footer moved to the shell in v0.8 (Justin, 2026-08-10:
/// "for the home pages 3 main buttons at the bottom, i want you to bring those to every page"),
/// so the field that types the query no longer lives inside the page that filters on it.
@Observable
@MainActor
final class CoSearch {
    var text = ""
    var isOpen = false

    /// Lowercased and trimmed once, since three pages ask the same question of it.
    var term: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    var isActive: Bool { !term.isEmpty }

    func matches(_ candidates: String...) -> Bool {
        guard isActive else { return true }
        return candidates.contains { $0.lowercased().contains(term) }
    }

    func close() {
        text = ""
        isOpen = false
    }
}
