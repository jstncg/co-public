import SwiftUI
import VariableBlur

/// The same progressive-blur surface `StickyBlurHeader` lays under a page head, extracted so
/// the chat (which owns its own ScrollView and can't host the package's) wears an identical blur.
struct CoHeaderBlur: View {
    /// How far down the page the veil reaches. The default is one bar plus the fade; the note
    /// page passes its own head height, because its head carries the date line under the
    /// controls and a veil that stopped at the bar would leave the written lines running
    /// sharp-edged behind it.
    var height: CGFloat = CoControl.bar + CoBlur.headerFade
    /// Which edge it hangs from. The bottom one dissolves the page into the app footer — the
    /// system's `.soft` scroll edge effect alone was too weak to read as a dissolve (Justin,
    /// 2026-08-11), and its `.hard` sibling is an opaque band, not a blur.
    var edge: VerticalEdge = .top

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let totalHeight = height
        let isTop = edge == .top
        ZStack(alignment: isTop ? .top : .bottom) {
            VariableBlurView(maxBlurRadius: CoBlur.headerRadius,
                             direction: isTop ? .blurredTopClearBottom : .blurredBottomClearTop)
            LinearGradient(
                stops: [
                    .init(color: tint.opacity(CoBlur.headerTintTop), location: 0),
                    // The header's mid-stop is a fixed 90pt down. The footer is shorter, so
                    // the same absolute stop would leave the tint to fall off a cliff in its
                    // last few points and draw an edge; proportional keeps the ramp smooth.
                    .init(color: tint.opacity(CoBlur.headerTintMiddle),
                          location: isTop ? 90 / totalHeight : 0.6),
                    .init(color: tint.opacity(0), location: 1),
                ],
                startPoint: isTop ? .top : .bottom,
                endPoint: isTop ? .bottom : .top)
        }
        // The bottom veil overshoots past the bar into the home-indicator strip. It is at FULL
        // blur down there, so overshooting costs nothing and stopping short is visible: the last
        // row was still landing sharp under the footer (sim, 2026-08-11).
        .frame(height: isTop ? totalHeight : totalHeight + CoBlur.headerFade)
        .padding(.bottom, isTop ? 0 : -CoBlur.headerFade)
        .ignoresSafeArea(edges: isTop ? .top : .bottom)
        .allowsHitTesting(false)
    }

    private var tint: Color {
        colorScheme == .dark ? .black : .white
    }
}

/// Settings keeps its own nav bar, so the title face still reaches UIKit through the
/// appearance proxy. Called once at launch (CoApp).
enum CoNavigationBarAppearance {
    static func apply() {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithTransparentBackground()
        if let large = UIFont(name: CoType.titleFace, size: 34) {
            appearance.largeTitleTextAttributes[.font] = large
        }
        if let inline = UIFont(name: CoType.face(.semibold), size: 17) {
            appearance.titleTextAttributes[.font] = inline
        }
        UINavigationBar.appearance().standardAppearance = appearance
        UINavigationBar.appearance().scrollEdgeAppearance = appearance
        UINavigationBar.appearance().compactAppearance = appearance

        // NOT the tab bar — iOS 26 Liquid Glass ignores UITabBarItem title attributes
        // (tried 8/4), and the only lever that works replaces the glass material AppShellView needs.
    }
}
