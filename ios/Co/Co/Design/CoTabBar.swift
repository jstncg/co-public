import SwiftUI

// v0.7 (Justin, 2026-08-10): the tab bar moved to the TOP and became Notion's segmented row —
// one disc on the left, then three pills that share the rest of the width. The selected pill
// carries icon + label and takes every point the others give up; the others shrink to a glyph.
// The iOS 26 bottom `TabView` is gone: it could not hold a leading button in the same row, and
// Home now owns the bottom edge (search / mic / new note).

enum CoTab: String, CaseIterable {
    case home, archive, profile

    /// Every case is a real page now — nothing in this enum is a disguised action.
    static let destinations: [CoTab] = allCases

    var label: String {
        switch self {
        case .home: return "Home"
        case .archive: return "Archive"
        case .profile: return "Profile"
        }
    }

    var symbol: String {
        switch self {
        case .home: return "house"
        case .archive: return "square.stack"
        case .profile: return "person.crop.circle"
        }
    }

    /// The chosen tab fills in, iOS-native.
    var selectedSymbol: String {
        switch self {
        case .home: return "house.fill"
        case .archive: return "square.stack.fill"
        case .profile: return "person.crop.circle.fill"
        }
    }
}

enum CoTabMetrics {
    /// The row's HIT height. Stays on the 44pt touch floor even though the controls inside it
    /// are drawn shorter — the tappable area never shrinks with the paint.
    static let barHeight: CGFloat = CoSpacing.touchTarget
    /// What the pills and the leading disc actually DRAW (Justin, 2026-08-11: "just slightly
    /// thinner"). 4pt off the hit height, so the row reads lighter without a smaller target.
    ///
    /// The 4pt gap is load-bearing beyond this file: centring 40 in 44 leaves 2pt of dead space
    /// under the paint, which is part of why the shell's top inset is `m` 12 rather than `l` 16
    /// (DS §4.4b). Returning this to 44 means returning that inset to 16.
    static let pillHeight: CGFloat = 40
    /// An unselected pill is a glyph with breathing room, nothing more.
    static let restingPillWidth: CGFloat = 60
    static let gap: CGFloat = CoSpacing.s
}

/// The top row: leading disc, then the three destinations.
struct CoTopTabBar: View {
    @Binding var selection: CoTab
    var onLeading: () -> Void
    var leadingNamespace: Namespace.ID

    var body: some View {
        HStack(spacing: CoTabMetrics.gap) {
            leadingDisc

            ForEach(CoTab.destinations, id: \.self) { tab in
                pill(for: tab)
            }
        }
        .frame(height: CoTabMetrics.barHeight)
        .padding(.horizontal, CoSpacing.l)
        .animation(CoMotion.morph, value: selection)
        // The tab's own feedback, so the pills opt out of the generic press impact below.
        .sensoryFeedback(.selection, trigger: selection)
    }

    /// Glass, like every other corner control (Justin, 2026-08-11). It is the one control in
    /// this row that is not a destination, and the material is what separates it — not a
    /// different fill colour.
    private var leadingDisc: some View {
        Button(action: onLeading) {
            Image(systemName: "ellipsis")
                .font(.system(size: CoControl.discIcon, weight: .semibold))
                .foregroundStyle(CoColor.textPrimary.color)
                .frame(width: CoTabMetrics.pillHeight, height: CoTabMetrics.pillHeight)
                .glassEffect(.regular.interactive(), in: Circle())
                // Drawn at 40, tapped at 44 — the hit region outlives the paint.
                .frame(width: CoTabMetrics.barHeight, height: CoTabMetrics.barHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(CoPressStyle())
        .matchedTransitionSource(id: "settings", in: leadingNamespace)
        .accessibilityLabel("Settings")
    }

    private func pill(for tab: CoTab) -> some View {
        let isSelected = tab == selection
        return Button {
            selection = tab
        } label: {
            HStack(spacing: CoSpacing.s) {
                Image(systemName: isSelected ? tab.selectedSymbol : tab.symbol)
                    .font(.system(size: CoControl.barIcon, weight: .medium))
                if isSelected {
                    // 13, not 15: this row is a segmented control, not a page heading, and a
                    // tab label at body size competes with the content under it.
                    Text(tab.label)
                        .font(CoType.style(.footnote, .semibold))
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            .foregroundStyle(isSelected ? CoColor.textPrimary.color : CoColor.textSecondary.color)
            // The selected pill eats the leftover width; the others hold their resting size.
            .frame(maxWidth: isSelected ? .infinity : CoTabMetrics.restingPillWidth)
            .frame(height: CoTabMetrics.pillHeight)
            // PAINTED, not glass (Justin, 2026-08-11). These three were glass for a few hours
            // and the width morph stuttered: the material re-samples what is behind it on every
            // frame, and these pills resize on every frame, so the one animation in the app that
            // must be perfectly smooth was the one paying for it. The leading disc keeps its
            // glass — it never changes size. Selection still reads through three channels
            // (DS §8.3): filled glyph, label appearing, width taken.
            // `contentCard`, not `accentSubtle` (Justin, 2026-08-26): over the aurora the
            // grey pills picked up its tint and read as cream — the row is black and white.
            // The hairline is what keeps a near-white pill legible where the aurora's veil
            // runs to white behind it; without it the row dissolves into the page.
            .background(CoColor.contentCard.color, in: Capsule())
            .overlay(Capsule().stroke(CoColor.borderDefault.color, lineWidth: 0.5))
            // Drawn at 40, tapped at 44 — the hit region outlives the paint.
            .frame(height: CoTabMetrics.barHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(CoPressStyle(haptic: false))
        .accessibilityLabel(tab.label)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

/// Emil: every button gets a spring scale-down plus a soft haptic on press, so it feels physical.
///
/// `haptic: false` is for controls whose OUTCOME carries its own feedback — a tab change fires
/// `.selection`, an approval fires `.success`. Two taps for one gesture reads as a stutter, and
/// a haptic that fires identically for "opened a note" and "deleted a note" is the same as none
/// (2026-08-10: the whole app had one soft impact and nothing else).
struct CoPressStyle: ButtonStyle {
    var haptic = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(CoMotion.morph, value: configuration.isPressed)
            .sensoryFeedback(.impact(flexibility: .soft), trigger: configuration.isPressed) {
                _, pressed in haptic && pressed
            }
    }
}
