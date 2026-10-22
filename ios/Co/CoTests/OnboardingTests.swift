import Testing
import Foundation
@testable import Co

@MainActor struct OnboardingStoreTests {
    @Test func advanceWalksAllThreeSteps() {
        let store = OnboardingStore()
        #expect(store.step == .name)
        #expect(store.advance())
        #expect(store.step == .phone)
        #expect(store.advance())
        #expect(store.step == .code)
        #expect(!store.advance())          // nothing after code — verify success ends the flow
    }
    /// Verification is real: no proven number, no tenant, no app — phone/code never skip.
    @Test func phoneAndCodeAreNotSkippable() {
        #expect(!OnboardingStep.phone.isSkippable)
        #expect(!OnboardingStep.code.isSkippable)
        let store = OnboardingStore(step: .phone)
        store.skip()
        #expect(store.step == .phone)
    }
    /// Skipping the name still goes THROUGH verification.
    @Test func skipOnNameLandsOnPhone() {
        let store = OnboardingStore(step: .name)
        store.skip()
        #expect(store.step == .phone)
    }
    @Test func backFromCodeReturnsToPhone() {
        let store = OnboardingStore(step: .code)
        store.back()
        #expect(store.step == .phone)
    }
    @Test func progressCoversAllSteps() {
        #expect(OnboardingStep.name.progress == (1, 3))
        #expect(OnboardingStep.code.progress == (3, 3))
    }
    @Test func blankNameRendersFriend() {
        #expect(OnboardingAnswers().displayName == "friend")
    }
}

struct OnboardingWireTests {
    /// A skipped name never ships — an absent answer is not a fact.
    @Test func payloadCarriesOnlyAnswered() {
        var answers = OnboardingAnswers()
        answers.name = "  Sam  "
        #expect(answers.wirePayload == ["name": "Sam"])
    }
    @Test func emptyIntakeShipsNothing() {
        #expect(OnboardingAnswers().wirePayload.isEmpty)
    }
}
