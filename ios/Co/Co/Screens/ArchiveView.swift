import SwiftUI

/// Archive — everything kept, as pools: one wide card per shelf, saves fanned inside it,
/// name under the card, count under that.
///
/// Named `ProfileView` until 2026-08-11, from a "profile" screen that stopped existing in v0.7.
/// The tab is Archive, the store is `ArchiveStore`, and the file now says so too.
struct ArchiveView: View {
    var settingsNamespace: Namespace.ID
    var onSettings: () -> Void = {}

    @Environment(ArchiveStore.self) private var archive
    /// AlbumDetailView → MemoryDetailView renders off a FeedStore; archive's own data
    /// lives in `archive`, this covers the memory detail's write paths (note/remove).
    @Environment(FeedStore.self) private var feed

    @State private var openAlbum: ArchiveAlbum?
    @Namespace private var pools
    /// v0.8: the field moved to the shell's footer, so the query is shared with the other pages
    /// rather than page-local. Only one page is ever on screen to read it.
    @Environment(CoSearch.self) private var search
    private var query: String { search.text }

    var body: some View {
        // Its own ScrollView (DS §5.3). Until 2026-08-11 this page borrowed `coPageChrome`'s —
        // a modifier whose title and controls were both switched off, kept only for the
        // progressive blur it drew. The shell already draws that veil for every tab, so Archive
        // was wearing two and frosting deeper than Home and Tasks for no reason anyone chose.
        ScrollView {
            content
        }
        .scrollIndicators(.hidden)
        // The system's own bottom effect, on the scroll view itself (DS §5.3). Setting it
        // on the shell's Group did not reach here: these modifiers configure the scroll
        // view they are attached to, they do not travel down the tree to find one.
        .scrollEdgeEffectHidden(true, for: .top)
        .scrollEdgeEffectHidden(true, for: .bottom)
        .background(CoPageField())
        .task {
            await archive.load()
            let args = ProcessInfo.processInfo.arguments
            if let i = args.firstIndex(of: "-coAlbum"), i + 1 < args.count {
                openAlbum = archive.albums.first { $0.name == args[i + 1] }
            }
        }
        .fullScreenCover(item: $openAlbum) { album in
            AlbumDetailView(album: album)
                .environment(feed)
                .navigationTransition(.zoom(sourceID: album.id, in: pools))
        }
    }

    private var content: some View {
        // An empty archive is a different truth than a search with no hits — "matches “”" read as broken copy.
        let searching = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return Group {
            if !archive.hasLoaded {
                // The one screen with a real round-trip behind it, so the one screen that earns
                // a skeleton. Home and Tasks read local stores — a skeleton there would be a
                // loading state for something that was never loading.
                poolSkeleton
            } else if matchingAlbums.isEmpty, searching {
                EditorialEmptyState(
                    title: "No results",
                    line: "Nothing in your archive matches \u{201C}\(query)\u{201D}.")
                    .padding(.top, CoSpacing.xxl)
            } else if matchingAlbums.isEmpty {
                EditorialEmptyState(
                    title: "Nothing kept yet",
                    line: "Anything you send co — links, photos, thoughts — gets kept here, on shelves of its own.")
                    .padding(.top, CoSpacing.xxl)
            } else {
                // Lead pool full width, everything after runs two across — the size
                // change says "start here".
                LazyVStack(spacing: PoolMetrics.rowGap) {
                    if let lead = matchingAlbums.first {
                        poolButton(lead, aspect: PoolMetrics.leadAspect)
                    }
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: PoolMetrics.columnGap),
                                        GridItem(.flexible(), spacing: PoolMetrics.columnGap)],
                              spacing: PoolMetrics.rowGap) {
                        ForEach(matchingAlbums.dropFirst()) { album in
                            poolButton(album, aspect: 1)
                        }
                    }
                }
                .padding(.horizontal, PoolMetrics.margin)
                .padding(.top, PoolMetrics.topInset)
                .padding(.bottom, CoSpacing.xxl)
            }
        }
        .scrollIndicators(.hidden)
    }

    /// The shelves' own shape, greyed — the page does not change layout when the real ones land.
    private var poolSkeleton: some View {
        LazyVStack(spacing: PoolMetrics.rowGap) {
            PoolCard(album: Self.placeholderAlbum, aspect: PoolMetrics.leadAspect)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: PoolMetrics.columnGap),
                                GridItem(.flexible(), spacing: PoolMetrics.columnGap)],
                      spacing: PoolMetrics.rowGap) {
                ForEach(0..<4, id: \.self) { _ in
                    PoolCard(album: Self.placeholderAlbum, aspect: 1)
                }
            }
        }
        .padding(.horizontal, PoolMetrics.margin)
        .padding(.top, PoolMetrics.topInset)
        .redacted(reason: .placeholder)
        .accessibilityHidden(true)
    }

    private static let placeholderAlbum = ArchiveAlbum(name: "Loading", items: [])

    private func poolButton(_ album: ArchiveAlbum, aspect: CGFloat) -> some View {
        Button { openAlbum = album } label: {
            PoolCard(album: album, aspect: aspect)
        }
        .buttonStyle(CoPressStyle())
        .accessibilityLabel("\(album.name), \(album.items.count) saved")
        .matchedTransitionSource(id: album.id, in: pools)
    }

    private var matchingAlbums: [ArchiveAlbum] {
        ArchiveAlbum.matching(archive.albums, query: query)
    }
}

struct ArchiveAlbum: Identifiable, Equatable {
    let name: String
    let items: [FeedItem]

    var id: String { name }

    static func kind(for sourceType: String) -> FeedItem.Kind {
        switch sourceType {
        case "image", "screenshot": return .photo
        case "voice", "call": return .quote
        case "youtube", "podcast", "short_video", "video": return .podcast
        default: return .post
        }
    }

    /// Count desc, then name, so the page doesn't reshuffle between visits. Untagged
    /// saves gather in "everything else". Lives here (not on ArchiveView) because the +
    /// sheet files posts into these same shelves.
    static func fold(_ items: [FeedItem]) -> [ArchiveAlbum] {
        var byTag: [String: [FeedItem]] = [:]
        var untagged: [FeedItem] = []
        for item in items where item.isArchived {
            if item.tags.isEmpty { untagged.append(item) }
            for tag in item.tags { byTag[tag, default: []].append(item) }
        }
        var result = byTag.map { ArchiveAlbum(name: $0.key, items: $0.value) }
            .sorted { ($1.items.count, $0.name) < ($0.items.count, $1.name) }
        if !untagged.isEmpty {
            result.append(ArchiveAlbum(name: "everything else", items: untagged))
        }
        return result
    }

    /// A shelf matches if its name matches or anything ON it does — "sauna" must surface
    /// the shelf holding a sauna note, not just one named that.
    static func matching(_ albums: [ArchiveAlbum], query: String) -> [ArchiveAlbum] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return albums }
        return albums.filter { album in
            album.name.localizedCaseInsensitiveContains(needle)
                || album.items.contains { $0.matches(needle) }
        }
    }
}

extension ArchiveAlbum {
    init(bucket: ArchiveBucket) {
        self.init(name: Self.shelfName(bucket.name),
                  items: bucket.items.map(FeedItem.init(archiveItem:)))
    }

    /// Rooms carry the member's own theme names; the source-type fallback carries wire keys
    /// ("social_post") that must never render as titles.
    ///
    /// Ported from `ProfileView` on main (Dennis, main@1e9033d). This branch retires that screen,
    /// and taking the branch wholesale would have quietly put the wire keys back on the shelves —
    /// the archive is the one surface where the fallback shape is what a new member sees first.
    static func shelfName(_ raw: String) -> String {
        let known: [String: String] = [
            "social_post": "posts", "url": "links", "youtube": "videos",
            "short_video": "clips", "video": "videos", "image": "images",
            "screenshot": "screenshots", "text": "notes", "voice": "voice notes",
            "podcast": "podcasts", "document": "documents",
        ]
        return known[raw] ?? raw.replacingOccurrences(of: "_", with: " ")
    }
}

/// Proportions are local (aspects, fan geometry); SPACING is not. Archive used to sit on a
/// 32pt margin while Home and Tasks sat on 16, so the page edge moved when the member changed
/// tabs (Justin, 2026-08-10: consistent padding from the sides of the screen).
private enum PoolMetrics {
    static let margin: CGFloat = CoSpacing.l
    static let topInset: CGFloat = CoSpacing.l
    static let rowGap: CGFloat = CoSpacing.l
    static let columnGap: CGFloat = CoSpacing.l
    static let leadAspect: CGFloat = 2.05
    static let cardRadius: CGFloat = CoRadius.card
    static let captionGap: CGFloat = CoSpacing.s
    static let countGap: CGFloat = CoSpacing.xs
    static func fanHeight(aspect: CGFloat) -> CGFloat { aspect > 1.5 ? 0.38 : 0.5 }
    static let fanStep: CGFloat = 0.52
    static let fanWidth: CGFloat = 0.78
    static let fanCount = 4
}

private struct PoolCard: View {
    let album: ArchiveAlbum
    let aspect: CGFloat

    var body: some View {
        VStack(spacing: PoolMetrics.captionGap) {
            ZStack {
                RoundedRectangle(cornerRadius: PoolMetrics.cardRadius, style: .continuous)
                    .fill(CoColor.contentCard.color)
                PoolFan(items: Array(album.items.prefix(PoolMetrics.fanCount)),
                        heightShare: PoolMetrics.fanHeight(aspect: aspect))
            }
            .aspectRatio(aspect, contentMode: .fit)
            .coCardShadow()

            VStack(spacing: PoolMetrics.countGap) {
                Text(album.name.capitalized)
                    .font(CoType.style(.footnote))
                    .foregroundStyle(CoColor.textPrimary.color)
                    .lineLimit(1)
                Text("\(album.items.count)")
                    .font(CoType.style(.footnote))
                    .foregroundStyle(CoColor.textSecondary.color)
            }
        }
    }
}

/// Overlapping saves, each tilted its own way. Angles are a fixed table, not random — a
/// pool that re-shuffles its cover on every rebuild reads as a glitch.
private struct PoolFan: View {
    let items: [FeedItem]
    let heightShare: CGFloat

    private static let angles: [Double] = [-5, 9, 4, -2]
    private static let rises: [CGFloat] = [3, -4, 2, -3]

    var body: some View {
        GeometryReader { proxy in
            let span = CGFloat(max(items.count - 1, 0)) * PoolMetrics.fanStep + 1
            let height = min(proxy.size.height * heightShare,
                             proxy.size.width * PoolMetrics.fanWidth / span)
            let step = height * PoolMetrics.fanStep
            ZStack {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    PoolChip(item: item, height: height)
                        .rotationEffect(.degrees(Self.angles[index % Self.angles.count]))
                        .offset(x: (CGFloat(index) - CGFloat(items.count - 1) / 2) * step,
                                y: Self.rises[index % Self.rises.count])
                        .zIndex(Double(index))
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
    }
}

private struct PoolChip: View {
    let item: FeedItem
    let height: CGFloat

    private var isMedia: Bool { item.kind.isMedia }
    private var width: CGFloat { height * min(max(item.aspectRatio, 0.62), 1.1) }
    private var radius: CGFloat { height * 0.1 }

    var body: some View {
        Group {
            if isMedia {
                ZStack {
                    CoWash(seed: item.id)
                    Image(systemName: item.kind.glyph)
                        .font(.system(size: height * 0.2, weight: .light))
                        .foregroundStyle(FeedWash.glyphTint(for: item.id))
                }
            } else {
                Text(item.text ?? item.title)
                    .font(.custom(CoType.face(.regular), fixedSize: height * 0.08))
                    .foregroundStyle(CoColor.textPrimary.color.opacity(0.75))
                    .multilineTextAlignment(.leading)
                    .padding(height * 0.08)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .background(CoColor.contentCard.color)
            }
        }
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .stroke(CoColor.borderDefault.color, lineWidth: 0.5)
        )
    }
}

private enum BoardMetrics {
    static let margin: CGFloat = CoSpacing.l
    static let gap: CGFloat = CoSpacing.l
    static let tile: CGFloat = 3.0 / 4.0
}

/// When one tile opens, every other tile is pushed radially away and tilted; dragging the
/// memory away pulls them home. Push is computed from where tiles actually are
/// (`onGeometryChange`), so the spread reads as displacement, not a canned animation.
/// Transform only (offset + rotation) — layout never touches, so the board never
/// re-lays-out mid-gesture. Reduce Motion drops the scatter entirely.
private struct BoardScatter: ViewModifier {
    let id: String
    let focusID: String
    let isOpen: Bool
    let progress: CGFloat
    @Binding var frames: [String: CGRect]

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let space = "coAlbumBoard"

    private var isFocus: Bool { id == focusID }
    private var amount: CGFloat { isOpen && !reduceMotion ? 1 - progress : 0 }

    /// Radially away from the opened tile, farther the farther out it already is.
    private var push: CGSize {
        guard !isFocus, let mine = frames[id], let focus = frames[focusID] else { return .zero }
        let dx = mine.midX - focus.midX
        let dy = mine.midY - focus.midY
        let distance = max(hypot(dx, dy), 1)
        let magnitude = 26 + distance * 0.18
        return CGSize(width: dx / distance * magnitude, height: dy / distance * magnitude)
    }

    /// Deterministic from the id (not random, and not `hashValue`, which is per-process
    /// seeded) — a board that re-tilts on every rebuild reads as a glitch.
    private var tilt: Double {
        guard !isFocus else { return 0 }
        let seed = id.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }
        return Double(seed % 11) - 5
    }

    private var delay: Double {
        guard let mine = frames[id], let focus = frames[focusID] else { return 0 }
        return min(Double(hypot(mine.midX - focus.midX, mine.midY - focus.midY)) / 900, 1) * 0.12
    }

    func body(content: Content) -> some View {
        content
            .offset(x: push.width * amount, y: push.height * amount)
            .rotationEffect(.degrees(tilt * Double(amount)))
            .onGeometryChange(for: CGRect.self) { proxy in
                proxy.frame(in: .named(Self.space))
            } action: { frames[id] = $0 }
            .animation(reduceMotion ? nil
                                    : .spring(duration: 0.45, bounce: 0.18).delay(delay),
                       value: isOpen)
    }
}

/// One shelf, opened: saves as a masonry board under a ✕ and a floating search bar.
private struct AlbumDetailView: View {
    let album: ArchiveAlbum

    @Environment(\.dismiss) private var dismiss
    @Environment(FeedStore.self) private var store


    @State private var opened: SelectedFeedItem?
    @State private var currentID = ""
    @State private var dismissProgress: CGFloat = 0
    @State private var tileFrames: [String: CGRect] = [:]
    /// Window-space tile frames, same space the open card is measured in, so the card can
    /// aim its shrink back at the slot it came from.
    @State private var tileGlobalFrame: [String: CGRect] = [:]
    @Namespace private var board
    @State private var query = ""
    @FocusState private var searching: Bool

    var body: some View {
        // `CoHeaderBlur`, not the `StickyBlurHeader` package (DS §5.3). Both drew the same veil
        // from the same four knobs, but this screen was the last caller of the package version —
        // and one veil with two implementations is two veils the next time someone tunes one.
        ScrollView {
            content
        }
        .scrollIndicators(.hidden)
        // Veil first, head second — reversed, the overlay wraps the head too and frosts the ✕
        // and the shelf name (sim, 2026-08-11). Same order as the shell and the note page.
        .overlay(alignment: .top) { CoHeaderBlur() }
        .safeAreaInset(edge: .top, spacing: CoSpacing.m) { head }
        .background(CoPageField())
        .scrollEdgeEffectHidden(true, for: .top)
        .scrollEdgeEffectHidden(true, for: .bottom)
        .safeAreaBar(edge: .bottom, spacing: 0) { bottomBar }
        .task {
            guard ProcessInfo.processInfo.arguments.contains("-coMemory"),
                  let first = album.items.first else { return }
            currentID = first.id
            opened = SelectedFeedItem(id: first.id)
        }
        .fullScreenCover(item: $opened, onDismiss: { dismissProgress = 0 }) { _ in
            MemoryDetailView(focusFrame: tileGlobalFrame[currentID], items: matching,
                             currentID: $currentID, dismissProgress: $dismissProgress)
                .environment(store)
        }
    }

    private var matching: [FeedItem] {
        album.items.filter { $0.matches(query) }
    }

    private var content: some View {
        Group {
            if matching.isEmpty {
                EditorialEmptyState(
                    title: "No results",
                    line: "Nothing in \(album.name) matches \u{201C}\(query)\u{201D}.")
                    .padding(.top, CoSpacing.xxl)
            } else {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(),
                                                             spacing: BoardMetrics.gap),
                                         count: 3),
                          spacing: BoardMetrics.gap) {
                    ForEach(matching) { item in
                        Button {
                            currentID = item.id
                            opened = SelectedFeedItem(id: item.id)
                        } label: {
                            // Blank while its memory is open — the card coming home needs
                            // an empty slot to fall into, not a copy of itself.
                            Color.clear
                                .aspectRatio(BoardMetrics.tile, contentMode: .fit)
                                .overlay {
                                    if opened?.id == item.id {
                                        Color.clear
                                    } else {
                                        ArchiveTile(item: item, textLineLimit: 4)
                                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                                    }
                                }
                                .clipShape(RoundedRectangle(cornerRadius: CoRadius.card,
                                                            style: .continuous))
                                .coCardShadow()
                        }
                        .buttonStyle(CoPressStyle())
                        .accessibilityLabel(item.title)
                        .matchedTransitionSource(id: item.id, in: board)
                        .onGeometryChange(for: CGRect.self) { proxy in
                            proxy.frame(in: .global)
                        } action: { tileGlobalFrame[item.id] = $0 }
                        .modifier(BoardScatter(id: item.id, focusID: currentID,
                                               isOpen: opened != nil, progress: dismissProgress,
                                               frames: $tileFrames))
                    }
                }
                .padding(.horizontal, BoardMetrics.margin)
                .padding(.top, CoSpacing.s)
                .coordinateSpace(name: BoardScatter.space)
            }
        }
        .scrollIndicators(.hidden)
    }

    private var head: some View {
        ZStack {
            Text(album.name.capitalized)
                .font(CoType.style(.headline, .semibold))
                .foregroundStyle(CoColor.titlePrimary.color)
                .lineLimit(1)

            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: CoControl.discIcon, weight: .semibold))
                        .foregroundStyle(CoColor.textPrimary.color)
                        .frame(width: CoSpacing.touchTarget, height: CoSpacing.touchTarget)
                        .contentShape(Circle())
                }
                .buttonStyle(CoPressStyle())
                .glassEffect(.regular.interactive(), in: Circle())
                .accessibilityLabel("Close \(album.name)")

                Spacer(minLength: 0)
            }
        }
        .frame(height: CoSpacing.touchTarget)
        .padding(.horizontal, CoSpacing.l)
    }

    private var bottomBar: some View {
        HStack(spacing: CoSpacing.s) {
            CoGlassSearchField(text: $query, focused: $searching,
                               showsDictation: true, onClose: {})
            if !searching { addMenu }
        }
        .padding(.horizontal, CoSpacing.l)
        .padding(.bottom, CoSpacing.s)
        .animation(CoMotion.morph, value: searching)
    }

    /// The four ways something gets into a pool. `ponytail`: every item is inert — wire to
    /// the capture flow when one exists.
    private var addMenu: some View {
        Menu {
            Button {} label: { Label("Type", systemImage: "keyboard") }
            Button {} label: { Label("Voice", systemImage: "mic") }
            Button {} label: { Label("Upload", systemImage: "photo.on.rectangle") }
            Button {} label: { Label("Link", systemImage: "link") }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: CoControl.discIcon, weight: .medium))
                .foregroundStyle(CoColor.textPrimary.color)
                .frame(width: CoSpacing.touchTarget + CoSpacing.s,
                       height: CoSpacing.touchTarget + CoSpacing.s)
                .contentShape(Circle())
        }
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel("Add to \(album.name)")
        .transition(.move(edge: .trailing).combined(with: .opacity))
    }
}
