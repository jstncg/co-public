import SwiftUI

/// TWO controls at the bottom of EVERY page (Justin, 2026-08-12): search on the left, co's face
/// in the right corner. It lives in the shell, not in a page, so it survives the tab switch and
/// so the query it types can reach whichever page is showing.
///
/// The "Ask Co" bar that used to fill the middle is gone, and so is the new-note disc beside it.
/// The bar was a text-entry shape leading to a voice call, which is the wrong promise for the
/// gesture; the face makes the same promise in a quarter of the width, and a row of two controls
/// leaves the page under it uncovered — which is the whole point of a footer that floats.
struct CoAppFooter: View {
    @Environment(CoSearch.self) private var search

    var onAsk: () -> Void

    @FocusState private var searchFocused: Bool

    var body: some View {
        @Bindable var search = search

        return HStack(spacing: CoSpacing.m) {
            if search.isOpen {
                CoGlassSearchField(text: $search.text, focused: $searchFocused,
                                   onClose: { search.close() })
            } else {
                disc("magnifyingglass", label: "Search") {
                    search.isOpen = true
                    searchFocused = true
                }
                // The two sit at the two corners, not side by side. Nothing occupies the middle,
                // so the last line of the page stays readable between them.
                Spacer(minLength: CoSpacing.m)
                mascotDisc
            }
        }
        .padding(.horizontal, CoSpacing.l)
        .padding(.top, CoSpacing.s)
        .padding(.bottom, CoSpacing.s)
        // NO backdrop (Justin, 2026-08-11). This row used to paint an opaque cream gradient
        // behind itself so the last line of the page would dissolve — but that gradient was
        // exactly what the glass was refracting, which is why the controls read as flat
        // plastic. Glass over a painted ground is not glass. The page now runs under these
        // controls untouched and the material does the separating.
        .animation(CoMotion.morph, value: search.isOpen)
    }

    /// Co's face, and the app's one way into voice. It is a disc the size of the search disc
    /// beside it, not a bigger hero button: two controls of different sizes in a two-control row
    /// read as a control and a decoration.
    ///
    /// The face is NOT animated here. It cycles expressions in onboarding and in voice, where it
    /// is the subject; in the chrome of every page it would be the only thing on screen moving
    /// while nothing happened — and a canvas redrawing at display rate for decoration is worse.
    private var mascotDisc: some View {
        Button(action: onAsk) {
            CoMascot(state: .resting, size: CoControl.barFocused - CoSpacing.m, animated: false)
                .frame(width: CoControl.barFocused, height: CoControl.barFocused)
                .contentShape(Circle())
        }
        .buttonStyle(CoPressStyle())
        // Glass, not paper-plus-shadow: this row floats OVER the page, and the two lifts
        // stacked read as a card sitting on a card (2026-08-10).
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel("Talk to co")
        .accessibilityHint("Opens voice mode")
    }

    private func disc(_ symbol: String, label: String,
                      action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: CoControl.discIcon, weight: .medium))
                .foregroundStyle(CoColor.textPrimary.color)
                .frame(width: CoControl.barFocused, height: CoControl.barFocused)
                .contentShape(Circle())
        }
        .buttonStyle(CoPressStyle())
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel(label)
    }
}

/// THE search field. One shape wherever the app searches: a glass capsule at `barFocused`,
/// magnifier leading, ✕ trailing, inside the same piece of glass.
///
/// There were two until 2026-08-11 — this one in the footer, and `CoSearchField` in the Archive
/// head, which grew 44 → 52 on focus and threw its ✕ out into a detached disc. Both were
/// correct in isolation; together they meant opening a shelf handed the member a differently
/// shaped, differently animated version of the control they had just been using.
struct CoGlassSearchField: View {
    @Binding var text: String
    @FocusState.Binding var focused: Bool
    /// True where the field is the only input on the screen (an opened shelf). The app footer
    /// leaves it off: its mic belongs to Ask Co, and two mics in one row mean neither is voice.
    var showsDictation = false
    var onClose: () -> Void

    var body: some View {
        HStack(spacing: CoSpacing.s) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: CoControl.barIcon, weight: .medium))
                .foregroundStyle(CoColor.textSecondary.color)

            TextField("Search", text: $text)
                .focused($focused)
                .submitLabel(.search)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .foregroundStyle(CoColor.textPrimary.color)

            if showsDictation {
                CoDictationButton(text: $text) { focused = true }
            }

            Button {
                text = ""
                focused = false
                onClose()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: CoControl.barIcon, weight: .semibold))
                    .foregroundStyle(CoColor.textSecondary.color)
                    .contentShape(Circle())
            }
            .accessibilityLabel("Close search")
        }
        .padding(.horizontal, CoSpacing.l)
        .frame(height: CoControl.barFocused)
        .glassEffect(.regular.interactive(), in: Capsule())
    }
}

// `coFloating()` — a soft shadow under every floating control — was retired 2026-08-10 when the
// chrome moved to Liquid Glass. Glass already carries its own separation, so keeping the shadow
// under it drew the lift twice. Content cards separate by surface colour and hairline, not by
// elevation, so nothing else needed it either.
