import SwiftUI

// Home is three shelves (Justin, 2026-08-26): WATCHING, FOR YOU, and SINCE YOU WERE LIVING.
// Every shelf scrolls sideways — the page reads as a hand of cards, not a wall — and each
// head's circled chevron opens the shelf as its own page, stacked two columns deep.
//
// WATCHING is what co currently has eyes on for the member — a price, a listing, a thread.
// The moment one FIRES it reaches the member as a text on the rail; the app never plays
// reminder (Justin, 2026-08-27), so this shelf only ever shows the standing eye.
//
// FOR YOU is media co pulled for the member — a video, an article, an episode — the tall
// cards, because a title is the whole pitch.
//
// SINCE YOU WERE LIVING is receipts: what co did while the member was away. Same flat card as
// Watching, but nothing to do except read it.

/// The three shelves, and the page each one opens into.
enum HomeSection: String, Identifiable, CaseIterable {
    case watching = "Watching"
    case forYou = "For you"
    case recap = "Since you were living"

    var id: String { rawValue }
}

struct NotesHomeView: View {
    @Environment(NotesStore.self) private var store
    @Environment(CoSearch.self) private var search

    /// Kept for the empty state's way out, which is still a page the member writes themselves.
    var onNewNote: () -> Void = {}

    /// The For-you card open over the page, if any — media opens OVER the shelf, and a peek
    /// is not a take. A card with no URL never lands here (`ForYouCard` guards the tap).
    @State private var openMedia: ForYouItem?
    /// The shelf that is open as its own page, if any.
    @State private var openSection: HomeSection?

    var body: some View {
        ScrollView {
            if watches.isEmpty, forYou.isEmpty, recap.isEmpty {
                emptyState
            } else {
                VStack(alignment: .leading, spacing: CoSpacing.xl) {
                    if !watches.isEmpty {
                        shelf(.watching) {
                            // Standing watches only (Justin, 2026-08-27): a watch that FIRES
                            // reaches the member as a text on the rail — the app never plays
                            // reminder. These cards read, they do not tap.
                            ForEach(watches) { watch in
                                HomeRowCard(line: watch.label, seed: watch.id, symbol: "eye")
                                    .frame(width: HomeRowCard.rowWidth)
                            }
                        }
                    }

                    if !forYou.isEmpty {
                        shelf(.forYou) {
                            ForEach(forYou) { item in
                                ForYouCard(item: item) { openMedia = item }
                                    .frame(width: ForYouCard.rowWidth)
                            }
                        }
                    }

                    if !recap.isEmpty {
                        shelf(.recap) {
                            ForEach(recap) { item in
                                HomeRowCard(line: item.line, seed: item.id, symbol: item.symbol,
                                            height: HomeRowCard.tallHeight)
                                    .frame(width: HomeRowCard.rowWidth)
                            }
                        }
                    }
                }
                // `xl`, not `m` (Justin, 2026-08-26): the first shelf sat on the bar's heels.
                .padding(.top, CoSpacing.xl)
                .padding(.bottom, CoSpacing.xxl)
            }
        }
        .scrollIndicators(.hidden)
        // The system's own edge effects, on the scroll view itself (DS §5.3). Setting them on the
        // shell's Group did not reach here: these modifiers configure the scroll view they are
        // attached to, they do not travel down the tree to find one.
        .scrollEdgeEffectHidden(true, for: .top)
        .scrollEdgeEffectHidden(true, for: .bottom)
        .background(CoPageField())
        .sheet(item: $openMedia) { item in
            if let url = item.url { CoWebSheet(url: url).ignoresSafeArea() }
        }
        .fullScreenCover(item: $openSection) { section in
            // The arrays ride along rather than the stores: a cover's content does not reliably
            // inherit an ancestor's `.environment`, and the page needs nothing else from them.
            HomeSectionPage(section: section, watches: watches, forYou: forYou, recap: recap,
                            onClose: { openSection = nil })
        }
        .task {
            // Dev/screenshot hook, same law as `-coSettings`: this page needs a tap simctl
            // cannot drive. `watching`, `forYou` or `recap` — the case name, not the title.
            let args = ProcessInfo.processInfo.arguments
            if let i = args.firstIndex(of: "-coHomeSection"), i + 1 < args.count {
                switch args[i + 1] {
                case "watching": openSection = .watching
                case "forYou": openSection = .forYou
                case "recap": openSection = .recap
                default: break
                }
            }
        }
    }

    private var watches: [WatchItem] {
        guard search.isActive else { return store.watches }
        return store.watches.filter { search.matches($0.label, $0.note) }
    }

    private var forYou: [ForYouItem] {
        guard search.isActive else { return store.forYou }
        return store.forYou.filter { search.matches($0.title, $0.source) }
    }

    private var recap: [RecapItem] {
        guard search.isActive else { return store.recap }
        return store.recap.filter { search.matches($0.line) }
    }

    @ViewBuilder
    private var emptyState: some View {
        if search.isActive {
            EditorialEmptyState(
                title: "No results",
                line: "Nothing on Home matches \u{201C}\(search.text)\u{201D}.")
        } else {
            EditorialEmptyState(
                title: "Nothing needs you right now",
                line: "Co fills these shelves as it works: what it watches for you, what it finds for you, and what it did while you were away.",
                actionLabel: "New note",
                action: onNewNote)
        }
    }

    /// A bold head with its circled chevron, then the sideways row. The head is one Button —
    /// title and circle open the same page, so the two cannot promise different things.
    @ViewBuilder
    private func shelf<Content: View>(_ section: HomeSection,
                                      @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: CoSpacing.m) {
            Button { openSection = section } label: {
                HStack(spacing: CoSpacing.s) {
                    // 18, not `title3`'s 20 (Justin, 2026-08-26: "a tiny bit smaller") — still
                    // a head over 15pt cards, no longer shouting over them.
                    Text(section.rawValue)
                        .font(CoType.inter(18, .bold, relativeTo: .title3))
                        .foregroundStyle(CoColor.textPrimary.color)
                    // Bare, no circle behind it — the head is quiet chrome, not a control
                    // competing with its own cards.
                    Image(systemName: "chevron.right")
                        .font(.system(size: CoControl.rowIcon, weight: .semibold))
                        .foregroundStyle(CoColor.textSecondary.color)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(CoPressStyle())
            .padding(.horizontal, CoSpacing.l)
            .accessibilityLabel("\(section.rawValue), show all")
            .accessibilityAddTraits(.isHeader)

            ScrollView(.horizontal) {
                HStack(spacing: CoSpacing.m) { content() }
                    .padding(.horizontal, CoSpacing.l)
            }
            .scrollIndicators(.hidden)
            // The shadows reach past the scroll view's box; clipping them draws every card
            // with a shaved edge.
            .scrollClipDisabled()
        }
    }
}

/// One shelf as its own page: the title, a two-column stack of everything, and the way back in
/// the top right corner.
struct HomeSectionPage: View {
    let section: HomeSection
    let watches: [WatchItem]
    let forYou: [ForYouItem]
    let recap: [RecapItem]
    var onClose: () -> Void

    @State private var openMedia: ForYouItem?

    private static let columns = [GridItem(.flexible(), spacing: CoSpacing.m),
                                  GridItem(.flexible(), spacing: CoSpacing.m)]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: Self.columns, spacing: CoSpacing.m) {
                // One card for all three grids (Justin, 2026-08-27: "they should all look
                // like the expanded For you") — the shelves keep their own shapes, the
                // opened page speaks in one.
                switch section {
                case .watching:
                    // The note is the meta — the one place the card has room to say WHY
                    // this is watched.
                    ForEach(watches) { watch in
                        HomeTallCard(seed: watch.id, title: watch.label,
                                     meta: watch.note, glyph: "eye", titleLines: 3)
                    }
                case .forYou:
                    ForEach(forYou) { item in
                        ForYouCard(item: item, titleLines: 3) { openMedia = item }
                    }
                case .recap:
                    ForEach(recap) { item in
                        HomeTallCard(seed: item.id, title: item.line,
                                     meta: "While you were away", glyph: item.symbol,
                                     titleLines: 3)
                    }
                }
            }
            .padding(.horizontal, CoSpacing.l)
            .padding(.top, CoSpacing.s)
            .padding(.bottom, CoSpacing.xxl)
        }
        .scrollIndicators(.hidden)
        .safeAreaInset(edge: .top, spacing: CoSpacing.m) { head }
        .background(CoPageField())
        .sheet(item: $openMedia) { item in
            if let url = item.url { CoWebSheet(url: url).ignoresSafeArea() }
        }
    }

    private var head: some View {
        HStack(alignment: .center, spacing: CoSpacing.m) {
            Text(section.rawValue)
                .font(CoType.inter(28, .bold, relativeTo: .title))
                .foregroundStyle(CoColor.textPrimary.color)
                .accessibilityAddTraits(.isHeader)

            Spacer(minLength: CoSpacing.s)

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: CoControl.discIcon, weight: .medium))
                    .foregroundStyle(CoColor.textPrimary.color)
                    .frame(width: CoControl.disc, height: CoControl.disc)
                    .contentShape(Circle())
            }
            .buttonStyle(CoPressStyle())
            .glassEffect(.regular.interactive(), in: Circle())
            .accessibilityLabel("Close")
        }
        .padding(.horizontal, CoSpacing.l)
    }
}

/// The flat card Watching and the recap share: one short line, and a square wash on the right
/// wearing the card's glyph (Justin, 2026-08-26: "flatter cards, less text, that square image
/// on the right hand side"). Neither shelf acts — a watch is an eye, a receipt is a fact —
/// so the card draws no press state and promises no tap.
struct HomeRowCard: View {
    let line: String
    let seed: String
    let symbol: String
    var height: CGFloat = Self.height

    /// One width on the shelf so the row reads as a deck; the grid page sizes by column.
    static let rowWidth: CGFloat = 296
    static let height: CGFloat = 88
    /// The recap's rung (Justin, 2026-08-26): taller than Watching, shorter than For you.
    static let tallHeight: CGFloat = 124

    /// The square grows with the card, keeping the same inset all around.
    private var imageSide: CGFloat { height - CoSpacing.m * 2 }

    var body: some View {
        content
            .accessibilityElement(children: .combine)
    }

    private var content: some View {
        HStack(alignment: .center, spacing: CoSpacing.m) {
            Text(line)
                .font(CoType.style(.subheadline, .medium))
                .foregroundStyle(CoColor.textPrimary.color)
                .multilineTextAlignment(.leading)
                .lineLimit(3)

            Spacer(minLength: 0)

            CoWash(seed: seed)
                .frame(width: imageSide, height: imageSide)
                .clipShape(RoundedRectangle(cornerRadius: imageSide * 0.24,
                                            style: .continuous))
                .overlay {
                    Image(systemName: symbol)
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(FeedWash.glyphTint(for: seed))
                }
                .accessibilityHidden(true)
        }
        .padding(CoSpacing.m)
        .frame(height: height)
        .frame(maxWidth: .infinity, alignment: .leading)
        .coCard()
    }
}

/// The tall card. A wash where a thumbnail will one day be, then the title at reading size —
/// the title is the whole pitch, so it gets the room the flat cards do not. Every opened
/// section page speaks in this one shape; the shelves keep their own.
struct HomeTallCard: View {
    let seed: String
    let title: String
    let meta: String
    /// Watch / Read / Listen, worn only by media.
    var chip: ForYouKind? = nil
    /// A centred mark on the wash where there is no chip — the card's identity, said once.
    var glyph: String? = nil
    /// 2 on the shelf, 3 in a grid column — the narrower the card, the more lines a title
    /// needs before it stops truncating mid-word. Reserved either way, so every card on a
    /// surface stays one height.
    var titleLines: Int = 2
    /// nil = a receipt: nothing to open, no press state to promise one.
    var onOpen: (() -> Void)? = nil

    var body: some View {
        if let onOpen {
            Button(action: onOpen) { content }
                .buttonStyle(CoPressStyle())
                .accessibilityLabel("\(title), \(meta)")
        } else {
            content
                .accessibilityElement(children: .combine)
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: CoSpacing.m) {
            // An INSET picture, not a full-bleed top (Justin, 2026-08-26: "a rectangle
            // inside the bubble") — the card frames the wash the way every flat card
            // beside it frames its square, so the shelves speak one language.
            CoWash(seed: seed)
                .frame(height: 132)
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: CoRadius.card - CoSpacing.s,
                                            style: .continuous))
                .overlay {
                    if let glyph {
                        Image(systemName: glyph)
                            .font(.system(size: 28, weight: .semibold))
                            .foregroundStyle(FeedWash.glyphTint(for: seed))
                    }
                }
                .overlay(alignment: .bottomLeading) {
                    if let chip { chipView(chip) }
                }

            VStack(alignment: .leading, spacing: CoSpacing.xs) {
                Text(title)
                    .font(CoType.style(.subheadline, .semibold))
                    .foregroundStyle(CoColor.textPrimary.color)
                    .multilineTextAlignment(.leading)
                    .lineLimit(titleLines, reservesSpace: true)

                Text(meta)
                    .font(CoType.style(.footnote))
                    .foregroundStyle(CoColor.textSecondary.color)
                    .lineLimit(1)
            }
        }
        .padding(CoSpacing.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .coCard()
    }

    /// Watch / Read / Listen, sitting on the wash the way a duration badge sits on a thumbnail.
    private func chipView(_ kind: ForYouKind) -> some View {
        HStack(spacing: CoSpacing.xs) {
            Image(systemName: kind.symbol)
                .font(.system(size: 9, weight: .semibold))
            Text(kind.label)
                .font(CoType.label)
                .tracking(CoType.labelTracking)
                .textCase(.uppercase)
        }
        .foregroundStyle(CoColor.textOnAccent.color)
        .padding(.horizontal, CoSpacing.s)
        .frame(height: 22)
        .background(CoColor.ink.color.opacity(0.55), in: Capsule())  // design: DESIGN_SYSTEM.md §5.4
        .padding(CoSpacing.m)
        .accessibilityHidden(true)
    }
}

/// For-you's face on the shelf and in its grid: the tall card wearing the media chip.
struct ForYouCard: View {
    let item: ForYouItem
    var titleLines: Int = 2
    var onOpen: () -> Void

    /// Narrower than the flat cards and taller — the shelf shows two and a half, not one.
    static let rowWidth: CGFloat = 240

    var body: some View {
        HomeTallCard(seed: item.id, title: item.title,
                     meta: item.length.isEmpty ? item.source : "\(item.source) · \(item.length)",
                     chip: item.kind, titleLines: titleLines,
                     // A find with no URL still draws — it just promises no tap.
                     onOpen: item.url == nil ? nil : onOpen)
            .accessibilityLabel("\(item.kind.label): \(item.title), \(item.source), \(item.length)")
            .accessibilityHint("Opens in co")
    }
}
