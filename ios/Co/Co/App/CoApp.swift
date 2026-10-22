import SwiftUI

/// The user's appearance choice — read before the root view draws; the shell applies it as `preferredColorScheme`.
enum CoAppearance: String, CaseIterable, Identifiable, Codable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    /// nil = follow the system; the shell's `preferredColorScheme` accepts exactly that.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

@main
struct CoApp: App {
    // `preferredColorScheme` is owned by the shell via `CoAppearance` (key "coAppearance") — the old
    // `coDarkMode`, which had no control to change it, stays retired.

    @State private var session = AppSession()

    init() {
        // Large titles are UIKit's navigation bar — the app's title face reaches them via the
        // appearance proxy, not a SwiftUI `.font`.
        CoNavigationBarAppearance.apply()
    }

    var body: some Scene {
        WindowGroup {
            CoRootView(session: session)
        }
    }
}

private struct CoRootView: View {
    @Bindable var session: AppSession

    var body: some View {
        Group {
            if session.showsShell, let api = session.api {
                MemberExperience(api: api)
                    .id(session.relationshipGeneration)
            } else if session.stage == .launching {
                // Status check in flight — showing the intake here made returning members watch the name
                // screen flash before the shell appeared.
                LaunchingView()
            } else {
                // Fresh members walk the intake (name → verify); existing relationships never see it —
                // showsShell flips once start() finds them.
                OnboardingFlow(session: session) { answers in
                    Task { await session.finishIntake(with: answers) }
                }
            }
        }
        .animation(CoMotion.morph, value: session.stage)
        .task { await session.start() }
        .onOpenURL { url in Task { await session.connect(url) } }
    }
}

/// The pre-identity beat — same wash as onboarding, seen for however long the status round-trip takes.
private struct LaunchingView: View {
    var body: some View {
        ZStack {
            OnbWashBackground()
            VStack(spacing: CoSpacing.l) {
                CoLoadingView(size: 120)
            }
        }
        .preferredColorScheme(.light)
    }
}

/// Owns the member-scoped stores and live call together — changing identity reconstructs this
/// boundary so nothing leaks across relationships.
private struct MemberExperience: View {
    let api: any CoAPI
    @State private var voice: VoiceSession

    init(api: any CoAPI) {
        self.api = api
        _voice = State(initialValue: VoiceSession(api: api))
    }

    var body: some View {
        AppShellView(api: api)
            .environment(voice)
    }
}
