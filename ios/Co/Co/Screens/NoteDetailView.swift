import SwiftUI

/// A page, opened. Same numeral, same weekday, same rule as the card it grew out of — only the
/// body becomes editable (Justin, 2026-08-10: "clicking it will expand into an identical
/// interface"). Edits write straight back to the store on every keystroke pause.
struct NoteDetailView: View {
    let noteID: String

    @Environment(NotesStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var body_ = ""
    @State private var loaded = false
    /// Measured, not guessed: the head's height changes with the date line and with Dynamic Type,
    /// and the veil has to reach the bottom of whatever it actually is.
    @State private var headHeight: CGFloat = CoControl.bar

    private var note: Note? { store.notes.first { $0.id == noteID } }

    var body: some View {
        // One editor over the whole page, not a row per line — the member is writing, and a
        // list of text fields makes them think about structure they did not ask for.
        //
        // v1.1 (2026-08-11): the head is an INSET over the editor, not a row above it (DS
        // §5.2b). As a `VStack` row it owned an opaque band the text could never reach, so its
        // two glass capsules were refracting flat `appBackground` — a blurred picture of a
        // colour, which is what made this page's chrome read as plastic while every other
        // screen's read as glass. The written lines now run under it and dissolve through the
        // same veil the rest of the app wears.
        TextEditor(text: $body_)
            .font(CoType.style(.body))
            .foregroundStyle(CoColor.textPrimary.color)
            .scrollContentBackground(.hidden)
            .padding(.horizontal, CoSpacing.m)
            .onChange(of: body_) { _, new in
                guard loaded else { return }
                store.update(noteID: noteID, lines: Self.lines(from: new))
            }
            // Veil FIRST, head second — the same order the shell uses. Reversed, the overlay
            // wraps the head as well as the page and frosts the controls themselves: the back
            // chevron came out at about half strength (sim, 2026-08-11).
            .overlay(alignment: .top) { CoHeaderBlur(height: headHeight + CoBlur.headerFade) }
            .safeAreaInset(edge: .top, spacing: CoSpacing.l) {
                pageHead
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headHeight = $0 }
            }
            .background(CoColor.appBackground.color)
            // `safeAreaBar`: the system only draws its edge effect under things it knows are
            // bars (see AppShellView).
            .safeAreaBar(edge: .bottom) { footer }
        .task {
            body_ = (note?.lines ?? []).joined(separator: "\n\n")
            loaded = true
        }
    }

    /// The floating chrome plus the note's own date line. The date line is pinned rather than
    /// scrolled: it names the page, and a page's name does not leave when you scroll it.
    private var pageHead: some View {
        VStack(alignment: .leading, spacing: CoSpacing.l) {
            head

            if let note {
                NoteDateLine(note: note, numeralSize: 44, showsChevron: true)
                    .padding(.horizontal, CoSpacing.l)
            }

            Divider()
                .overlay(CoColor.borderDefault.color)
                .padding(.horizontal, CoSpacing.l)
        }
        .padding(.top, CoSpacing.s)
    }

    private var head: some View {
        HStack {
            circleButton("chevron.left", label: "Back") { dismiss() }
                .discSurface()

            Spacer()

            // Two glyphs in one capsule, the way the reference groups them.
            HStack(spacing: 0) {
                circleButton("info.circle", label: "Note info") {}
                circleButton("ellipsis.circle", label: "More") {}
            }
            .glassEffect(.regular.interactive(), in: Capsule())
        }
        .padding(.horizontal, CoSpacing.l)
    }

    private var footer: some View {
        HStack {
            HStack(spacing: 0) {
                circleButton("doc.text.magnifyingglass", label: "Find in note") {}
                circleButton("highlighter", label: "Highlight") {}
            }
            .glassEffect(.regular.interactive(), in: Capsule())

            Spacer()

            circleButton("plus", label: "Insert") {}
                .discSurface()
        }
        .padding(.horizontal, CoSpacing.l)
        .padding(.bottom, CoSpacing.s)
    }

    private func circleButton(_ symbol: String, label: String,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: CoControl.discIcon, weight: .medium))
                .foregroundStyle(CoColor.textPrimary.color)
                .frame(width: CoSpacing.touchTarget, height: CoSpacing.touchTarget)
                .contentShape(Circle())
        }
        .buttonStyle(CoPressStyle())
        .accessibilityLabel(label)
    }

    /// Blank lines separate entries in the editor, so round-tripping never silently merges two
    /// deposits into one line or leaves empty ones behind.
    static func lines(from text: String) -> [String] {
        text.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
}

/// The numeral and the weekday. It lived in `NotesHomeView` until 2026-08-12, beside the row and
/// the thumbnail it shared a page with; Home stopped being a list of pages that day and this is
/// now its only caller, so it moved to the screen that draws it.
struct NoteDateLine: View {
    let note: Note
    var numeralSize: CGFloat
    var showsChevron = false

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            HStack(spacing: CoSpacing.xs) {
                Text(note.dayNumeral)
                    .font(.custom(CoType.titleFace, size: numeralSize, relativeTo: .largeTitle))
                    .foregroundStyle(CoColor.textPrimary.color)
                if showsChevron {
                    Image(systemName: "chevron.down")
                        .font(.system(size: CoControl.chevron, weight: .semibold))
                        .foregroundStyle(CoColor.textSecondary.color)
                }
            }

            Spacer(minLength: CoSpacing.s)

            VStack(alignment: .trailing, spacing: 0) {
                Text(note.weekdayName)
                    .font(CoType.style(.footnote, .semibold))
                    .foregroundStyle(CoColor.textPrimary.color)
                Text(note.monthDay)
                    .font(CoType.style(.footnote, .semibold))
                    .foregroundStyle(CoColor.textSecondary.color)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.7)
        }
    }
}

/// The back button's own surface, matched to the head's other controls. Glass, not paper —
/// this chrome floats over the page it edits, and a shadowed white disc on a white page read
/// as a second sheet rather than a control (2026-08-10).
private extension View {
    func discSurface() -> some View {
        glassEffect(.regular.interactive(), in: Circle())
    }
}
