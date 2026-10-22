import SwiftUI

// Custom co components (design/COMPONENTS.md Class C, v0.1 set).

/// Stub states that read authored, not missing. No background
/// wash: the masked `accentSubtle` ramp went 2026-08-01 (TEXTURE.md §2) — a blue fading to
/// clear is a gradient in a blue. The type carries the state on its own.
struct EditorialEmptyState: View {
    let title: String
    let line: String
    /// The way out. An empty state that only describes emptiness leaves the member holding a
    /// dead end (2026-08-10) — where there is a next step, it belongs on the screen that has
    /// nothing else on it. Optional because some empty states genuinely have no verb.
    var actionLabel: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: CoSpacing.m) {
            Text(title)
                .font(CoType.style(.title3, .semibold))
                .foregroundStyle(CoColor.titlePrimary.color)
                .multilineTextAlignment(.center)
            Text(line)
                .font(CoType.style(.subheadline))
                .foregroundStyle(CoColor.textSecondary.color)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 300)

            if let actionLabel, let action {
                Button(action: action) {
                    Text(actionLabel)
                        .font(CoType.style(.subheadline, .semibold))
                        .foregroundStyle(CoColor.textPrimary.color)
                        .padding(.horizontal, CoSpacing.l)
                        .frame(height: CoSpacing.touchTarget)
                        .contentShape(Capsule())
                }
                .buttonStyle(CoPressStyle())
                .glassEffect(.regular.interactive(), in: Capsule())
                .padding(.top, CoSpacing.s)
            }
        }
        .padding(.horizontal, CoSpacing.xl)
        // Optical offset, not spacing: it lifts the block into the upper third of the page.
        .padding(.bottom, CoSpacing.touchTarget * 2)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }
}
