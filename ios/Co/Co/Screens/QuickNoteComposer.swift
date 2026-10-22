import SwiftUI

/// The card that rides above the keyboard. One field, one verb: what the member types lands on
/// today's page and nowhere else (Justin, 2026-08-10). Empty input cannot be sent, so the page
/// never collects blank lines.
///
/// It lives in Home's footer slot, NOT in a sheet — a sheet's scrim dims the board, and the whole
/// point is watching the line land on today's card.
struct QuickNoteComposer: View {
    var onAdd: (String) -> Void
    var onClose: () -> Void

    @State private var text = ""
    @FocusState private var focused: Bool

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: CoSpacing.m) {
            TextField("Add a quick note...", text: $text, axis: .vertical)
                .font(CoType.style(.title3))
                .foregroundStyle(CoColor.textPrimary.color)
                .focused($focused)
                .lineLimit(2, reservesSpace: true)
                .submitLabel(.done)

            Button {
                onAdd(text)
                text = ""
                focused = false
                onClose()
            } label: {
                HStack(spacing: CoSpacing.s) {
                    Text("Add to Today")
                        .font(CoType.style(.subheadline, .semibold))
                    Image(systemName: "arrow.right")
                        .font(.system(size: CoControl.rowIcon, weight: .medium))
                }
                .foregroundStyle(canSend ? CoColor.textPrimary.color : CoColor.textSecondary.color)
                .padding(.horizontal, CoSpacing.l)
                .frame(height: CoSpacing.touchTarget)
                .background(CoColor.accentSubtle.color, in: Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(CoPressStyle())
            .disabled(!canSend)
        }
        .padding(CoSpacing.l)
        // Glass, matching the chat composer — both are cards that float over a live page, and
        // this one takes the footer's slot, which is glass on every tab.
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: CoRadius.sheet,
                                                    style: .continuous))
        .onAppear { focused = true }
        // Dismissing the keyboard closes the composer, so the footer's three controls come back
        // instead of stranding an open card with nothing to type into.
        .onChange(of: focused) { _, isFocused in
            guard !isFocused, !canSend else { return }
            onClose()
        }
    }
}
