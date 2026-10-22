import Foundation

/// The intake's voice — lowercase like the shipped register. Phone/code copy lives with
/// the verification screens.
enum OnboardingFixtures {
    static let namePrompt = "what should co call you?"
    static let nameSub = "co is the friend in your pocket who actually remembers."
    static let namePlaceholder = "your name"

    static let skipLabel = "skip"
    static let nextLabel = "next"
    static let backAccessibilityLabel = "Back"

    static let sampleAnswers = OnboardingAnswers(name: "Sam")
}
