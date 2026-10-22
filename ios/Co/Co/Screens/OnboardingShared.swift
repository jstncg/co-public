import SwiftUI

/// Onboarding's shared chrome, aliased into CoColor/CoType so it can't drift from the system again.
enum OnboardingTheme {
    static let text = CoColor.textPrimary.color
    // The AA-safe secondary role, not a grey primitive: systemGray dips to ~1.5:1 on the
    // slate blobs, which is what §2.6 darkened `textSecondary` away from.
    static let textDim = CoColor.textSecondary.color
    static let accent = CoColor.accent.color
    static let accentText = CoColor.actionText.color

    /// On the ramp since 2026-08-11 (DS §3.2/§3.3). Onboarding used to size by number —
    /// `title(32)`, `control(17)`, `control(14)` — and pick the nearest Dynamic Type style to
    /// anchor to, which is the ramp with extra steps and a different answer. The prompt is
    /// `.title` 28 semibold now, not Inter Bold 32: the display face is for numerals.
    static let title = CoType.style(.title, .semibold)
    static let body = CoType.style(.body)
    static let control = CoType.style(.body)
    static let controlEmphasis = CoType.style(.body, .semibold)
    /// The quiet rung under a control: the n/3 counter, the resend line.
    static let caption = CoType.style(.footnote)
}

/// White background, matching the app's page (Justin, 2026-08-06: "remove cream, switch to white").
struct OnbWashBackground: View {
    var body: some View {
        CoColor.appBackground.color.ignoresSafeArea()
    }
}

// `MascotPlaceholder` — a rounded rect with two capsule eyes and a capsule mouth — was retired
// 2026-08-17 for `CoMascot` (Design/Mascot.swift), which is the real face: 25 expressions, 18
// silhouettes and 39 states. Its `blinking` flag became the `working` state's blink cadence,
// and its bob became the expression cadence, which is life the bob only imitated.

/// Prompt centered up top, content, one footer action. The shape of every chrome screen.
struct OnbPage<Content: View, Footer: View>: View {
    let prompt: String
    var subline: String?
    @ViewBuilder var content: () -> Content
    @ViewBuilder var footer: () -> Footer

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: CoSpacing.m) {
                Text(prompt)
                    .font(OnboardingTheme.title)
                    .foregroundStyle(OnboardingTheme.text)
                if let subline {
                    Text(subline).font(OnboardingTheme.body)
                        .foregroundStyle(OnboardingTheme.textDim)
                }
            }
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity)
            .padding(.top, CoSpacing.xl)
            content().padding(.top, CoSpacing.xxl)
            Spacer(minLength: 16)
            footer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.horizontal, CoSpacing.l)
        .padding(.bottom, CoSpacing.xl)
    }
}

/// The one loud control per screen: an accent-tinted liquid-glass capsule.
struct OnbPrimaryButton: View {
    let label: String
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(OnboardingTheme.controlEmphasis)
                .foregroundStyle(isEnabled ? CoColor.textOnAccent.color : OnboardingTheme.textDim)
                .frame(maxWidth: .infinity, minHeight: CoControl.barFocused)
        }
        .glassEffect(isEnabled ? .regular.tint(OnboardingTheme.accent.opacity(0.85)).interactive()
                               : .regular,
                     in: Capsule())
        .buttonStyle(CoPressStyle())
        .disabled(!isEnabled)
        .animation(CoMotion.standard, value: isEnabled)
    }
}

/// The translucent sibling (welcome's "log in", paywall's "not now").
struct OnbGhostButton: View {
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(OnboardingTheme.control)
                .foregroundStyle(OnboardingTheme.text.opacity(0.7))
                .frame(maxWidth: .infinity, minHeight: CoControl.barFocused)
        }
        // interactive(): the ghost presses like its primary sibling (DS §6).
        .glassEffect(.regular.interactive(), in: Capsule())
        .buttonStyle(CoPressStyle())
    }
}

/// Liquid-glass option pill (Mobbin 9ac6c2f0); selected = accent tint + accent text, labels
/// sit left.
struct OnbGlassPill: View {
    let label: String
    var isSelected = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(OnboardingTheme.control)
                .foregroundStyle(isSelected ? OnboardingTheme.accentText : OnboardingTheme.text)
                .padding(.horizontal, CoSpacing.xl)
                .frame(maxWidth: .infinity, minHeight: CoControl.barFocused, alignment: .leading)
        }
        .glassEffect(isSelected ? .regular.tint(OnboardingTheme.accent.opacity(0.25)).interactive()
                                : .regular.interactive(),
                     in: Capsule())
        .buttonStyle(CoPressStyle())
    }
}

/// Pill's bigger sibling (Mobbin 1df5f317) — square card for the 2x2 commitment grid.
struct OnbGlassCard: View {
    let title: String
    let caption: String
    var isSelected = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: CoSpacing.xs) {
                Text(title)
                    .font(OnboardingTheme.controlEmphasis)
                    .foregroundStyle(isSelected ? OnboardingTheme.accentText : OnboardingTheme.text)
                Text(caption)
                    .font(OnboardingTheme.caption)
                    .foregroundStyle(OnboardingTheme.textDim)
            }
            .multilineTextAlignment(.leading)
            .padding(CoSpacing.cardPadding)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .aspectRatio(1, contentMode: .fit)
        .glassEffect(isSelected ? .regular.tint(OnboardingTheme.accent.opacity(0.25)).interactive()
                                : .regular.interactive(),
                     in: RoundedRectangle(cornerRadius: CoRadius.card, style: .continuous))
        .buttonStyle(CoPressStyle())
    }
}

/// The alive loading state (founder, 8/9: "rather have blinking than a spinning wheel") — the
/// mascot blinks instead of a spinner: "a machine is working" vs "someone's here, listening."
struct CoLoadingView: View {
    var size: CGFloat = 120

    var body: some View {
        // `working`, not `loading`: the source gives `loading` no blink cadence at all, and a
        // face that holds its lids open is the spinner problem again. `working` cycles four
        // concentrating faces every 1.8–3.2s and blinks every 2.8–5.5s.
        CoMascot(state: .working, size: size)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // The face hides itself; this container is the element the reader hears.
            .accessibilityElement()
            .accessibilityLabel("Loading")
    }
}
