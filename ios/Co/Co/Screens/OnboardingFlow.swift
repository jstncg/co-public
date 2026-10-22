import SwiftUI

/// The intake: name → REAL phone verify → in. Three screens, founder-cut from fifteen
/// (8/7, twice: "rot and way too long", then "forget even what's the vision"). Everything
/// about the person is learned in the relationship — the product's own thesis.
///
/// Two state machines meet here and the session's is the truth for auth: the flow renders
/// phone/code, but only `session.stage` moves them — a challenge that was actually sent, a
/// code that actually verified. Verify success IS the finish: `onFinish` fires on `.ready`.
struct OnboardingFlow: View {
    @Bindable var session: AppSession
    let onFinish: (OnboardingAnswers) -> Void
    @State private var store = OnboardingStore.atLaunch()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            OnbWashBackground()
            content
        }
        .font(CoType.style(.body))
        .preferredColorScheme(.light)
        // morph, not the timing curve: screen pushes are interruptible motion, and a
        // spring keeps velocity where a curve restarts cold (ANIMATION_VOCABULARY).
        .animation(CoMotion.morph, value: store.step)
        .animation(CoMotion.morph, value: session.stage)
        .onChange(of: session.stage) { _, stage in
            // Auth truth arrived — move the flow to match it.
            switch stage {
            case .code where store.step == .phone:
                store.advance()                    // the challenge exists; show the code boxes
            case .ready:
                onFinish(store.answers)            // verified — the intake is over
            default:
                break
            }
        }
    }

    @ViewBuilder private var content: some View {
        if session.stage == .unavailable {
            unavailablePage
        } else {
            VStack(spacing: 0) {
                chromeHeader
                screen
                    .id(store.step)
                    .transition(pushTransition)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    @ViewBuilder private var screen: some View {
        switch store.step {
        case .name: NameScreen(store: store, advance: { store.advance() })
        case .phone:
            if session.stage == .launching {
                quietProgress                      // status check still in flight
            } else {
                PhoneVerifyScreen(session: session)
            }
        case .code:
            if case let .code(last4) = session.stage {
                CodeVerifyScreen(session: session, phoneLast4: last4)
            } else {
                PhoneVerifyScreen(session: session)
            }
        }
    }

    /// Back chevron · accent progress capsule · n/3 · skip (name only).
    private var chromeHeader: some View {
        HStack(spacing: CoSpacing.m) {
            if store.step != .name {
                Button { store.back() } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: CoControl.discIcon, weight: .semibold))
                        .foregroundStyle(OnboardingTheme.text)
                        .frame(width: CoControl.disc, height: CoControl.disc)
                        .glassEffect(.regular.interactive(), in: Circle())
                }
                .buttonStyle(CoPressStyle())
                .accessibilityLabel(OnboardingFixtures.backAccessibilityLabel)
            }
            let p = store.step.progress
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(OnboardingTheme.text.opacity(0.15))
                    Capsule().fill(OnboardingTheme.accent)
                        .frame(width: geo.size.width * CGFloat(p.index) / CGFloat(p.total))
                }
            }
            .frame(height: 6)
            .animation(CoMotion.standard, value: p.index)
            Text("\(p.index)/\(p.total)")
                .font(OnboardingTheme.caption).monospacedDigit()
                .foregroundStyle(OnboardingTheme.textDim)
            if store.step.isSkippable {
                Button(OnboardingFixtures.skipLabel) { store.skip() }
                    .font(OnboardingTheme.caption)
                    .foregroundStyle(OnboardingTheme.textDim)
                    .frame(minWidth: 44, minHeight: 44)
                    .buttonStyle(CoPressStyle())
            }
        }
        .padding(.horizontal, 16)
    }

    private var unavailablePage: some View {
        VStack(spacing: CoSpacing.l) {
            Spacer()
            // The apology is on the face too — this is the one screen where co failed.
            CoMascot(state: .sad, size: 140)
            Text("I couldn't get the line ready")
                .font(OnboardingTheme.title)
                .foregroundStyle(OnboardingTheme.text)
                .multilineTextAlignment(.center)
            if let message = session.errorMessage {
                Text(message)
                    .font(OnboardingTheme.body)
                    .foregroundStyle(OnboardingTheme.textDim)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            OnbPrimaryButton(label: "Try again") {
                Task { await session.retry() }
            }
        }
        .padding(.horizontal, CoSpacing.l)
        .padding(.bottom, CoSpacing.xl)
    }

    private var quietProgress: some View {
        VStack(spacing: CoSpacing.l) {
            CoLoadingView(size: 120)
        }
    }

    private var pushTransition: AnyTransition {
        guard !reduceMotion else { return .opacity }
        let back = store.isMovingBack
        return .asymmetric(
            insertion: .move(edge: back ? .leading : .trailing).combined(with: .opacity),
            removal: .move(edge: back ? .trailing : .leading).combined(with: .opacity))
    }
}
