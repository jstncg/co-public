import SwiftUI

// The three screens: name → real phone verify. Verification copy and behavior are
// the shipped intake's, verbatim. The flow ends on verify success — nothing is asked after.

private struct OnbField: View {
    let placeholder: String
    @Binding var text: String
    var keyboard: UIKeyboardType = .default
    var contentType: UITextContentType?

    var body: some View {
        TextField("", text: $text,
                  prompt: Text(placeholder).foregroundStyle(OnboardingTheme.textDim))
            .font(OnboardingTheme.control)
            .foregroundStyle(OnboardingTheme.text)
            .multilineTextAlignment(.center)
            .tint(OnboardingTheme.accent)
            .keyboardType(keyboard)
            .textContentType(contentType)
            .padding(.horizontal, CoSpacing.l)
            .frame(minHeight: 56)
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: CoRadius.card, style: .continuous))
    }
}

struct NameScreen: View {
    @Bindable var store: OnboardingStore
    let advance: () -> Void

    var body: some View {
        OnbPage(prompt: OnboardingFixtures.namePrompt,
                subline: OnboardingFixtures.nameSub, content: {
            OnbField(placeholder: OnboardingFixtures.namePlaceholder,
                     text: $store.answers.name, contentType: .givenName)
        }, footer: {
            OnbPrimaryButton(label: OnboardingFixtures.nextLabel,
                             isEnabled: !store.answers.name.trimmingCharacters(in: .whitespaces).isEmpty,
                             action: advance)
        })
    }
}

/// The real thing: one number, one proof that it is yours. `advance` is session-driven —
/// the flow moves when the challenge actually exists, never on the tap.
struct PhoneVerifyScreen: View {
    @Bindable var session: AppSession
    @State private var phone = ""
    @FocusState private var focused: Bool

    var body: some View {
        OnbPage(prompt: "what number can i text you at?",
                subline: "reach me here or in iMessage, same me either way",
                content: {
            OnbField(placeholder: "+1 555 555 0123", text: $phone,
                     keyboard: .phonePad, contentType: .telephoneNumber)
                .focused($focused)
                .onSubmit { requestCode() }
        }, footer: {
            VStack(spacing: CoSpacing.m) {
                OnbInlineStatus(message: session.errorMessage)
                OnbPrimaryButton(label: session.isWorking ? "Sending…" : "Text me a code",
                                 isEnabled: PhoneNumberInput.e164(phone) != nil && !session.isWorking,
                                 action: requestCode)
            }
        })
        // Focus AFTER the step transition settles — asking mid-morph races iOS 26's
        // out-of-process keyboard scene ("No scene exists…"), and every tap then stalls on
        // 600ms fence timeouts. Same law as the search hook's delayed focus.
        .task {
            try? await Task.sleep(for: .milliseconds(450))
            focused = true
        }
    }

    private func requestCode() {
        Task { await session.requestCode(phoneInput: phone) }
    }
}

/// ONE real, visible code field — no fake digit boxes. The boxes were an overlay on a
/// clear-text TextField, which broke twice at once: the overlay spilled over neighboring
/// text, and iOS AutoFill REFUSES to insert a texted code into a field it considers
/// hidden (anti-code-stealing protection), so tapping the QuickType suggestion did
/// nothing. A visible field gets the autofill, and six digits verify themselves.
struct CodeVerifyScreen: View {
    @Bindable var session: AppSession
    let phoneLast4: String
    @State private var code = ""
    @FocusState private var focused: Bool

    var body: some View {
        OnbPage(prompt: "just making sure it's you",
                subline: "i sent a six-digit code to the number ending in \(phoneLast4)",
                content: {
            TextField("", text: $code,
                      prompt: Text("123456").foregroundStyle(OnboardingTheme.textDim))
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel("Verification code")
                .focused($focused)
                .font(OnboardingTheme.controlEmphasis).monospacedDigit()
                .foregroundStyle(OnboardingTheme.text)
                .multilineTextAlignment(.center)
                .tint(OnboardingTheme.accent)
                .kerning(6)
                .padding(.horizontal, CoSpacing.l)
                .frame(minHeight: 64)
                .glassEffect(.regular, in: RoundedRectangle(cornerRadius: CoRadius.card, style: .continuous))
                .onChange(of: code) { _, newValue in
                    code = String(newValue.filter { $0.isNumber }.prefix(6))
                    // Autofill lands all six at once — verify without a second tap.
                    if code.count == 6 && !session.isWorking {
                        Task { await session.verify(code: code) }
                    }
                }
        }, footer: {
            VStack(spacing: CoSpacing.m) {
                OnbInlineStatus(message: session.errorMessage)
                OnbPrimaryButton(label: session.isWorking ? "Checking…" : "That's me",
                                 isEnabled: code.count == 6 && !session.isWorking) {
                    Task { await session.verify(code: code) }
                }
                OnbGhostButton(label: "Use another number") {
                    code = ""
                    session.useAnotherNumber()
                }
            }
        })
        // Focus AFTER the step transition settles — asking mid-morph races iOS 26's
        // out-of-process keyboard scene ("No scene exists…"), and every tap then stalls on
        // 600ms fence timeouts. Same law as the search hook's delayed focus.
        .task {
            try? await Task.sleep(for: .milliseconds(450))
            focused = true
        }
    }
}

/// The inline error line both verify screens share.
struct OnbInlineStatus: View {
    let message: String?

    var body: some View {
        if let message {
            Text(message)
                .font(OnboardingTheme.caption)
                .foregroundStyle(OnboardingTheme.textDim)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
