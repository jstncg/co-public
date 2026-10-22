import Foundation

/// Three screens, no ceremony: who you are → prove your number → in. Founder cuts 8/7:
/// first "rot and way too long" (15 → 4), then "forget even what's the vision" (4 → 3).
/// Everything about the person is learned in the relationship — the product's own thesis.
/// The seed chain accepts any subset of answers, so shipping {name} alone is fully legal.
enum OnboardingStep: Int, CaseIterable, Comparable {
    case name = 1, phone, code

    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
    var next: OnboardingStep? { OnboardingStep(rawValue: rawValue + 1) }
    var previous: OnboardingStep? { OnboardingStep(rawValue: rawValue - 1) }

    /// Name is skippable; verification is not (no proven number, no tenant, no app).
    var isSkippable: Bool { self == .name }

    var progress: (index: Int, total: Int) {
        (rawValue, OnboardingStep.allCases.count)
    }
}

/// What the intake learns. The phone number is NOT here — verification belongs to
/// AppSession/PhoneLinkAPI, and the number never needs a second home.
struct OnboardingAnswers: Equatable {
    var name: String = ""

    /// Every screen that interpolates a name uses this, so a skipped/blank name never renders "hey , ".
    var displayName: String { name.isEmpty ? "friend" : name }

    /// The wire shape for `POST api/v1/onboarding` — only what was actually answered ships.
    var wirePayload: [String: String] {
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        return trimmedName.isEmpty ? [:] : ["name": trimmedName]
    }
}
