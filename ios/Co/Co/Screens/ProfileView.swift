import SwiftUI

// Profile is co's working theory of the member, not a second feed (Justin, 2026-08-26). The
// Archive is the library — everything co has collected; this page is the librarian's model of
// the reader: who you are, your people, your tastes. It holds only CONCLUSIONS about the
// member, it stays small, and a slot co has not earned yet says so instead of pretending.
//
// The facts ride the rail's `me` block (orbit/goals/patterns → RailCoAPI.profileFacts);
// fixtures seed the store in Debug like every other Home surface (`AppShellView.init`).

struct ProfileView: View {
    @Environment(NotesStore.self) private var store
    @Environment(CoSearch.self) private var search

    var body: some View {
        ScrollView {
            if facts.isEmpty, search.isActive {
                EditorialEmptyState(
                    title: "No results",
                    line: "Nothing on Profile matches \u{201C}\(search.text)\u{201D}.")
            } else {
                VStack(alignment: .leading, spacing: CoSpacing.m) {
                    ForEach(facts) { fact in
                        ProfileFactCard(fact: fact)
                    }
                }
                .padding(.horizontal, CoSpacing.l)
                .padding(.top, CoSpacing.s)
                .padding(.bottom, CoSpacing.xxl)
            }
        }
        .scrollIndicators(.hidden)
        .scrollEdgeEffectHidden(true, for: .top)
        .scrollEdgeEffectHidden(true, for: .bottom)
        .background(CoPageField())
    }

    private var facts: [ProfileFact] {
        guard search.isActive else { return store.profile }
        return store.profile.filter { search.matches($0.title, $0.line) }
    }
}

/// A belief, or the space where one will go. The empty state is on the CARD, not on the page —
/// a page-level "nothing yet" would hide the shape of what co is trying to learn.
struct ProfileFactCard: View {
    let fact: ProfileFact

    private var isEmpty: Bool { fact.line.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: CoSpacing.s) {
            HStack(spacing: CoSpacing.s) {
                Image(systemName: fact.symbol)
                    .font(.system(size: CoControl.rowIcon, weight: .medium))
                    .foregroundStyle(CoColor.textSecondary.color)
                Text(fact.title)
                    .font(CoType.style(.subheadline, .semibold))
                    .foregroundStyle(CoColor.textPrimary.color)
            }

            Text(isEmpty
                 ? "co will fill this in as it learns more about you."
                 : fact.line)
                .font(CoType.style(.callout))
                .foregroundStyle(isEmpty ? CoColor.textSecondary.color : CoColor.textPrimary.color)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(CoSpacing.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .coCard(dashed: isEmpty)
        .accessibilityElement(children: .combine)
    }
}
