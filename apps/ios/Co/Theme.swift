// Theme.swift — visual identity (goal.md §34)
//
// private · calm · media-first · curious · tasteful · alive without being
// anthropomorphic · lightly opinionated · owned by the user.
// reference: apple photos + are.na + a beautifully edited field notebook.
// the user's own media is the dominant visual identity — the chrome stays quiet.
//
// avoided on purpose: glowing ai orb, robot, avatar, neon dashboard,
// chat bubbles as the whole interface, gamified meters.

import SwiftUI

enum CoTheme {

    // MARK: color tokens — adaptive: the web world's dark palette IS the brand
    // (crypto-app study, research-003 + mobbin pass: Phantom/Family/Base — true-dark ground,
    // ONE accent, lifted borderless cards, hero numerals). Light mode keeps the warm paper.

    private static func adaptive(dark: (Double, Double, Double), light: (Double, Double, Double)) -> Color {
        Color(UIColor { t in
            let c = t.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
        })
    }

    /// the ground — matches the wrapped page / card / icon exactly (#141312)
    static let paper = adaptive(dark: (0.0, 0.0, 0.0), light: (0.980, 0.973, 0.957))
    /// lifted card surface (#1d1c1a) — no borders in dark, the lift is the edge
    static let card = adaptive(dark: (0.082, 0.082, 0.084), light: (1.0, 0.996, 0.988))
    /// primary text (#ece9e4)
    static let ink = adaptive(dark: (0.925, 0.914, 0.894), light: (0.110, 0.102, 0.090))
    /// secondary text (#8a867f)
    static let inkSoft = adaptive(dark: (0.541, 0.525, 0.498), light: (0.420, 0.400, 0.368))
    /// hairlines (barely-there in dark; the cards carry the structure)
    static let hairline = adaptive(dark: (0.173, 0.165, 0.153), light: (0.110, 0.102, 0.090)).opacity(0.9)
    /// THE accent — sage (#8fb8a0), same as every co surface. used sparingly.
    static let clay = adaptive(dark: (0.561, 0.722, 0.627), light: (0.227, 0.373, 0.294))
    /// placeholder wash behind media thumbnails
    static let mediaWash = adaptive(dark: (0.15, 0.145, 0.135), light: (0.910, 0.894, 0.867))

    // MARK: News+ section accents (8/4 — "mix of lots of colors"; each surface owns one)
    static let accentToday = adaptive(dark: (0.98, 0.35, 0.37), light: (0.91, 0.18, 0.26))    // News red
    static let accentWorld = adaptive(dark: (0.42, 0.62, 0.98), light: (0.10, 0.36, 0.86))    // editorial blue
    static let accentMake = adaptive(dark: (0.99, 0.62, 0.30), light: (0.90, 0.42, 0.05))     // overnight orange
    static let accentWatch = adaptive(dark: (0.30, 0.78, 0.72), light: (0.04, 0.52, 0.47))    // watch teal
    static let accentMe = adaptive(dark: (0.78, 0.56, 0.98), light: (0.48, 0.26, 0.82))       // patterns purple

    /// heavy editorial section header (the "Top Stories" move)
    static func sectionHeader() -> Font { .system(size: 26, weight: .heavy) }

    // MARK: spacing tokens

    /// generous whitespace is part of the identity — do not compress.
    enum Space {
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 16
        static let l: CGFloat = 24
        static let xl: CGFloat = 36
    }

    static let cornerRadius: CGFloat = 20     // the crypto-card radius — generous, soft

    /// hero numerals (the balance-number move): huge, rounded, tight
    static func hero() -> Font { .system(size: 44, weight: .bold, design: .rounded) }

    // MARK: type — system fonts only

    /// screen titles: system serif, like a field notebook heading
    static func title() -> Font { .system(.title2, design: .serif, weight: .semibold) }
    /// card headline
    static func headline() -> Font { .system(.body, design: .default, weight: .medium) }
    /// body copy
    static func body() -> Font { .system(.body) }
    /// timestamps, receipts, source rows
    static func caption() -> Font { .system(.footnote) }
}

// MARK: - shared chrome

/// quiet card container used across tabs.
struct CoCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.s) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(CoTheme.Space.m)
        .background(CoTheme.card, in: RoundedRectangle(cornerRadius: CoTheme.cornerRadius))
    }
}

/// small quiet action button ([ open ] [ save ] [ mute ] …)
struct CoActionButton: View {
    let label: String
    var prominent = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(CoTheme.caption().weight(.medium))
                .foregroundStyle(prominent ? CoTheme.paper : CoTheme.ink)
                .padding(.horizontal, CoTheme.Space.m)
                .padding(.vertical, CoTheme.Space.s)
                .background(
                    prominent ? CoTheme.ink : CoTheme.ink.opacity(0.06),
                    in: Capsule()
                )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - hero header (the balance-number move)

/// big numeral + quiet caption — every beautiful crypto app leads with ONE number.
struct CoHero: View {
    let number: String
    let caption: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(number)
                .font(CoTheme.hero())
                .foregroundStyle(CoTheme.ink)
            Text(caption)
                .font(CoTheme.caption())
                .foregroundStyle(CoTheme.inkSoft)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - verb tiles (the action row)

/// four equal rounded tiles with tiny labels — the instantly-learnable verb surface.
struct CoVerbTiles: View {
    struct Verb: Identifiable {
        let id = UUID()
        let label: String
        let symbol: String
        let action: () -> Void
    }

    let verbs: [Verb]

    var body: some View {
        HStack(spacing: CoTheme.Space.s + 2) {
            ForEach(verbs) { v in
                Button(action: v.action) {
                    VStack(spacing: 6) {
                        Image(systemName: v.symbol)
                            .font(.system(size: 19, weight: .semibold))
                            .foregroundStyle(CoTheme.clay)
                        Text(v.label)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(CoTheme.inkSoft)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .coGlass(radius: 16)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - liquid glass (iOS 26) — chrome floats, content stays opaque
// Apple's guidance: glass belongs to the CONTROL layer hovering above content (tiles,
// floating buttons, toasts, chips) — never the content cards themselves. Below 26 the
// solid card surface is the graceful fallback.

struct CoGlass: ViewModifier {
    var radius: CGFloat = 16
    var tinted = false

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(
                tinted ? .regular.tint(CoTheme.clay.opacity(0.35)).interactive()
                       : .regular.interactive(),
                in: .rect(cornerRadius: radius))
        } else {
            content.background(CoTheme.card, in: RoundedRectangle(cornerRadius: radius))
        }
    }
}

struct CoGlassCapsule: ViewModifier {
    var prominent = false

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(
                prominent ? .regular.tint(CoTheme.clay.opacity(0.5)).interactive()
                          : .regular.interactive(),
                in: .capsule)
        } else {
            content.background(prominent ? AnyShapeStyle(CoTheme.clay.opacity(0.35))
                                         : AnyShapeStyle(CoTheme.card), in: Capsule())
        }
    }
}

extension View {
    /// glass for rounded-rect chrome (verb tiles, floating controls)
    func coGlass(radius: CGFloat = 16, tinted: Bool = false) -> some View {
        modifier(CoGlass(radius: radius, tinted: tinted))
    }

    /// glass for capsule chrome (toasts, pills, floating buttons)
    func coGlassCapsule(prominent: Bool = false) -> some View {
        modifier(CoGlassCapsule(prominent: prominent))
    }
}

// MARK: - spark bars (chart as texture — the Family move)

/// quiet weekly bars, sage, no axes: accumulation made visible without a dashboard.
struct CoSparkBars: View {
    /// newest-last counts, any length; renders the last 8
    let counts: [Int]

    /// early life reads as texture, not slabs: always 8 buckets, zero-padded on the left
    private var padded: [Int] {
        let cs = Array(counts.suffix(8))
        return cs.count < 8 ? Array(repeating: 0, count: 8 - cs.count) + cs : cs
    }

    var body: some View {
        let cs = padded
        let mx = max(cs.max() ?? 1, 1)
        HStack(alignment: .bottom, spacing: 5) {
            ForEach(Array(cs.enumerated()), id: \.offset) { _, n in
                RoundedRectangle(cornerRadius: 2.5)
                    .fill(CoTheme.clay.opacity(0.75))
                    .frame(height: max(4, CGFloat(n) / CGFloat(mx) * 34))
                    .frame(maxWidth: .infinity)
            }
        }
        .frame(height: 34, alignment: .bottom)
    }
}

// MARK: - flow layout + orbit tag (the web world's orbit, in the app)

struct CoFlow: Layout {
    var spacingX: CGFloat = 14
    var spacingY: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for sub in subviews {
            let sz = sub.sizeThatFits(.unspecified)
            if x + sz.width > maxW, x > 0 { x = 0; y += rowH + spacingY; rowH = 0 }
            x += sz.width + spacingX
            rowH = max(rowH, sz.height)
        }
        return CGSize(width: maxW, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for sub in subviews {
            let sz = sub.sizeThatFits(.unspecified)
            if x + sz.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += rowH + spacingY; rowH = 0 }
            sub.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += sz.width + spacingX
            rowH = max(rowH, sz.height)
        }
    }
}

/// one orbit word — bold, sage, no chrome (identity, not a filter chip).
struct CoTag: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 17, weight: .bold, design: .rounded))
            .foregroundStyle(CoTheme.clay)
    }
}

/// source receipt pill (radar cards, reads)
struct CoSourcePill: View {
    let label: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "link").font(.system(size: 10, weight: .semibold))
            Text(label).font(.system(size: 12, weight: .medium))
        }
        .foregroundStyle(CoTheme.inkSoft)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(CoTheme.paper, in: Capsule())
    }
}

// MARK: - honest toast
// dead-end actions never pretend: they surface "coming in beta" instead.

@Observable
@MainActor
final class ToastCenter {
    var message: String?
    private var dismissTask: Task<Void, Never>?

    func show(_ message: String) {
        self.message = message
        dismissTask?.cancel()
        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.2))
            guard !Task.isCancelled else { return }
            self?.message = nil
        }
    }

    func comingInBeta() { show("coming in beta") }
}

struct ToastOverlay: ViewModifier {
    let center: ToastCenter

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let message = center.message {
                Text(message)
                    .font(CoTheme.caption())
                    .foregroundStyle(CoTheme.ink)
                    .padding(.horizontal, CoTheme.Space.m)
                    .padding(.vertical, CoTheme.Space.s)
                    .coGlassCapsule()
                    .padding(.bottom, 70)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: center.message == nil)
    }
}

extension View {
    func toastOverlay(_ center: ToastCenter) -> some View {
        modifier(ToastOverlay(center: center))
    }
}
