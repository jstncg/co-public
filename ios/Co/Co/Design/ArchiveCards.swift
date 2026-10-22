import SwiftUI

// The card vocabulary Archive draws with. Extracted from `FeedView.swift` when the retired
// v0.6 Home was deleted (2026-08-10) — that file's own note said to move these out first, and
// these five types were the only reason it still compiled into the app.

struct SelectedFeedItem: Identifiable, Equatable {
    let id: String
}

/// A board tile. Media saves are bare washes; text saves stay small paper objects.
struct ArchiveTile: View {
    let item: FeedItem
    var textLineLimit: Int?

    var body: some View {
        if item.kind.isMedia {
            FeedMedia(item: item, glyphSize: FeedMedia.tileGlyph)
                .clipShape(RoundedRectangle(cornerRadius: CoRadius.card, style: .continuous))
        } else {
            FeedTile(item: item, showsTags: false, textLineLimit: textLineLimit)
        }
    }
}

struct FeedTile: View {
    let item: FeedItem
    var showsTags: Bool = true
    var textLineLimit: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if item.kind.isMedia {
                FeedMedia(item: item, glyphSize: FeedMedia.tileGlyph)
            }

            VStack(alignment: .leading, spacing: CoSpacing.s) {
                if item.kind == .quote {
                    Image(systemName: "quote.opening")
                        .font(.system(size: CoControl.rowIcon, weight: .semibold))
                        .foregroundStyle(CoColor.accent.color)
                }

                if let text = item.text {
                    Text(text)
                        .font(CoType.style(.subheadline))
                        .foregroundStyle(CoColor.textPrimary.color)
                        .multilineTextAlignment(.leading)
                        .lineLimit(textLineLimit)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let attribution = item.attribution {
                    Text(attribution)
                        .font(CoType.style(.caption))
                        .foregroundStyle(CoColor.textSecondary.color)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if showsTags, item.isArchived, !item.tags.isEmpty {
                    Text(item.tags.joined(separator: "  ·  ").uppercased())
                        .font(CoType.label)
                        .tracking(CoType.labelTracking)
                        .foregroundStyle(CoColor.actionText.color)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(CoSpacing.cardPadding)
        }
        .background(CoColor.contentCard.color)
        .clipShape(RoundedRectangle(cornerRadius: CoRadius.card, style: .continuous))
    }
}

/// The artifact's face when there is a thumb; the wash + glyph otherwise, and on any failed
/// fetch — never a broken frame.
struct FeedMedia: View {
    /// Decorative, not chrome — it scales with the tile, so it sits outside the `CoControl`
    /// glyph ladder on purpose.
    static let tileGlyph: CGFloat = 26

    let item: FeedItem
    var glyphSize: CGFloat = FeedMedia.tileGlyph
    var aspect: CGFloat?

    var body: some View {
        ZStack {
            CoWash(seed: item.id)
            Image(systemName: item.kind.glyph)
                .font(.system(size: glyphSize, weight: .light))
                .foregroundStyle(FeedWash.glyphTint(for: item.id))
            if let imageURL = item.imageURL {
                AsyncImage(url: imageURL) { phase in
                    if case let .success(image) = phase {
                        image.resizable().scaledToFill()
                            .transition(.opacity)
                    }
                }
            }
        }
        .aspectRatio(aspect ?? item.aspectRatio, contentMode: .fit)
        .clipped()
    }
}

/// Metal wash (Design/WashShader.metal): deterministic per seed, static — imagery, not motion.
struct CoWash: View {
    let seed: String
    /// nil = the seeded pick from `FeedWash`. Home hands its own pastel triple in — the page
    /// gradient is chrome-adjacent and must not change palette when a fixture id does.
    var palette: [CoTone]? = nil

    var body: some View {
        let palette = palette ?? FeedWash.palette(for: seed)
        Rectangle()
            .fill(palette[0].color)
            .visualEffect { content, proxy in
                content.colorEffect(ShaderLibrary.coWash(
                    .float2(proxy.size),
                    .float(FeedWash.scalarSeed(for: seed)),
                    .float(0.06),
                    .color(palette[0].color),
                    .color(palette[1].color),
                    .color(palette[2].color)))
            }
    }
}

/// The page's weather: three pastel fields breathing into each other off the same shader every
/// wash uses — soft and diagonal, nothing a linear gradient can fake. One fixed palette, not
/// the seeded pick: the page must not change colour when a fixture id does.
///
/// A white veil thins downward over the wash (Justin, 2026-08-26: "top closer to white,
/// the pink at the bottom") — the head of the page is paper, the colour gathers under it.
struct CoPageField: View {
    var body: some View {
        CoWash(seed: "home-aurora",
               palette: [CoColor.auroraIce, CoColor.auroraBlue, CoColor.auroraNavy])  // design: DESIGN_SYSTEM.md §5.4
            // The veil owns most of the page now (Justin, 2026-08-27: "white much more
            // prevalent, navy only near the bottom") — near-opaque at the top, still holding
            // past the middle, releasing the colour only in the last stretch.
            .overlay(LinearGradient(
                stops: [.init(color: CoColor.white.color.opacity(0.92), location: 0),   // design: DESIGN_SYSTEM.md §5.4
                        .init(color: CoColor.white.color.opacity(0.6), location: 0.55),  // design: DESIGN_SYSTEM.md §5.4
                        .init(color: .clear, location: 0.92)],
                startPoint: .top, endPoint: .bottom))
            .ignoresSafeArea()
    }
}

enum FeedWash {
    /// The one surface that reaches the primitive ramp directly: a wash stands in for a
    /// photograph, and photographs are not chrome.
    private static let palettes: [[CoTone]] = [
        [CoColor.watercolor, CoColor.readFill, CoColor.eventFill],   // design: DESIGN_SYSTEM.md §5.4
        [CoColor.steel, CoColor.listenFill, CoColor.powder],         // design: DESIGN_SYSTEM.md §5.4
        [CoColor.washedSlate, CoColor.watchFill, CoColor.eventFill], // design: DESIGN_SYSTEM.md §5.4
        [CoColor.steel, CoColor.eventFill, CoColor.readDeep],        // design: DESIGN_SYSTEM.md §5.4
        [CoColor.watercolor, CoColor.mist, CoColor.listenDeep],      // design: DESIGN_SYSTEM.md §5.4
        [CoColor.steel, CoColor.readFill, CoColor.powder],           // design: DESIGN_SYSTEM.md §5.4
    ]

    static func palette(for id: String) -> [CoTone] {
        palettes[index(for: id)]
    }

    static func scalarSeed(for id: String) -> Float {
        Float(id.unicodeScalars.reduce(7) { $0 &+ Int($1.value) &* 31 } % 997) / 997.0
    }

    static func glyphTint(for id: String) -> Color {
        CoColor.white.color.opacity(0.85)  // design: DESIGN_SYSTEM.md §5.4
    }

    /// `hashValue` is per-process seeded in Swift — this stays stable across cold starts.
    private static func index(for id: String) -> Int {
        id.unicodeScalars.reduce(0) { $0 &+ Int($1.value) } % palettes.count
    }
}
