import Foundation

/// Onboarding's whole state for one run: which screen, and the name. Session-only —
/// the answer ships to the rail when verification completes, and the graph is its home.
@Observable
@MainActor
final class OnboardingStore {
    private(set) var step: OnboardingStep
    var answers: OnboardingAnswers

    /// Which way the last move went, so the screen transition pushes the direction the user
    /// actually travelled.
    private(set) var isMovingBack = false

    init(step: OnboardingStep = .name, answers: OnboardingAnswers = OnboardingAnswers()) {
        self.step = step
        self.answers = answers
    }

    /// Advances toward verification. The flow ends on verify success (session-driven),
    /// never on a tap — so there is no "past the end" here.
    @discardableResult
    func advance() -> Bool {
        guard let next = step.next else { return false }
        isMovingBack = false
        step = next
        return true
    }

    func back() {
        guard let previous = step.previous else { return }
        isMovingBack = true
        step = previous
    }

    /// Skip only exists on name, and it still goes THROUGH verification.
    func skip() {
        guard step.isSkippable else { return }
        isMovingBack = false
        if let next = step.next { step = next }
    }

    // MARK: - launch hooks

    /// Dev/screenshot hook (`simctl` cannot tap): `-coOnboarding` → screen 1 empty,
    /// `-coOnboarding 2` → phone with the sample name filled in.
    static var isRequestedAtLaunch: Bool {
        ProcessInfo.processInfo.arguments.contains("-coOnboarding")
    }

    private static var launchStepNumber: Int? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-coOnboarding"), i + 1 < args.count else {
            return nil
        }
        return Int(args[i + 1])
    }

    static func atLaunch() -> OnboardingStore {
        guard let raw = launchStepNumber, let step = OnboardingStep(rawValue: raw) else {
            return OnboardingStore()
        }
        return OnboardingStore(step: step,
                               answers: step > .name ? OnboardingFixtures.sampleAnswers
                                                     : OnboardingAnswers())
    }
}
