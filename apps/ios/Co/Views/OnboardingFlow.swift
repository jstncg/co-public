// OnboardingFlow.swift — the first 60 seconds (goal.md §7)
// must feel like using co, not configuring it. copy is verbatim from §7.
// no feature carousel. no avatar. no personality quiz. account only after value.

import SwiftUI
import AuthenticationServices

struct OnboardingFlow: View {
    enum Step {
        case promise
        case chooseMoment
        case exampleComprehension   // "show me an example": maya's reel
        case captureText            // "a thought in my head"
        case captureLink            // "a link or video" / "something i saved"
        case whyTap
        case personalResponse
        case account
        case covenant
    }

    let onFinished: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(ToastCenter.self) private var toasts

    @State private var step: Step = .promise
    @State private var usedExample = false
    @State private var capturedText = ""
    @State private var whyChoice: String?

    var body: some View {
        ZStack {
            CoTheme.paper.ignoresSafeArea()
            Group {
                switch step {
                case .promise: promiseScreen
                case .chooseMoment: chooseMomentScreen
                case .exampleComprehension: exampleScreen
                case .captureText: captureTextScreen
                case .captureLink: captureLinkScreen
                case .whyTap: whyTapScreen
                case .personalResponse: personalResponseScreen
                case .account: accountScreen
                case .covenant: covenantScreen
                }
            }
            .transition(.opacity)
        }
        .animation(.easeInOut(duration: 0.25), value: stepKey)
    }

    private var stepKey: String { String(describing: step) }

    // MARK: screen 1 — promise (§7 verbatim)

    private var promiseScreen: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.l) {
            Spacer()

            Text("send co anything that catches you.")
                .font(CoTheme.title())
                .foregroundStyle(CoTheme.ink)

            Text("a reel. a picture. a thought.\none moment inside a video.")
                .font(CoTheme.body())
                .foregroundStyle(CoTheme.ink)

            Text("co remembers why it mattered\nand helps the right things become real.")
                .font(CoTheme.body())
                .foregroundStyle(CoTheme.ink)

            QuietLoopView()
                .padding(.vertical, CoTheme.Space.m)

            Spacer()

            CoActionButton(label: "send something", prominent: true) {
                step = .chooseMoment
            }
        }
        .padding(CoTheme.Space.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: screen 2 — choose a real first moment (§7 verbatim)

    private var chooseMomentScreen: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.m) {
            Spacer()

            Text("what do you have right now?")
                .font(CoTheme.title())
                .foregroundStyle(CoTheme.ink)
                .padding(.bottom, CoTheme.Space.m)

            onboardingChoice("something i saved") { step = .captureLink }
            onboardingChoice("a thought in my head") { step = .captureText }
            onboardingChoice("a link or video") { step = .captureLink }
            onboardingChoice("show me an example") {
                usedExample = true
                step = .exampleComprehension
            }

            Spacer()
        }
        .padding(CoTheme.Space.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: example path — first media comprehension (§7, maya's reel)

    private var exampleScreen: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.l) {
            Spacer()

            Text("maya shares a reel of six women making ceramics together.")
                .font(CoTheme.caption())
                .foregroundStyle(CoTheme.inkSoft)

            // co first proves it understood the media (verbatim)
            Text("six women meet every thursday to make ceramics.\nthe creator says she joined for pottery\nbut stayed because the group became her community.")
                .font(CoTheme.body())
                .foregroundStyle(CoTheme.ink)
                .padding(CoTheme.Space.m)
                .background(CoTheme.card, in: RoundedRectangle(cornerRadius: CoTheme.cornerRadius))

            Spacer()

            CoActionButton(label: "continue", prominent: true) { step = .whyTap }
        }
        .padding(CoTheme.Space.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: real paths — honest capture, no pretend comprehension

    private var captureTextScreen: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.l) {
            Spacer()

            Text("say it however it comes.")
                .font(CoTheme.title())
                .foregroundStyle(CoTheme.ink)

            TextField("the thought", text: $capturedText, axis: .vertical)
                .lineLimit(3...8)
                .padding(CoTheme.Space.m)
                .background(CoTheme.card, in: RoundedRectangle(cornerRadius: CoTheme.cornerRadius))

            Spacer()

            CoActionButton(label: "keep it", prominent: true) {
                Task {
                    _ = await model.capture(CapturePayload(sourceType: .text, coverage: .text, text: capturedText))
                    step = .whyTap
                }
            }
            .disabled(capturedText.trimmingCharacters(in: .whitespaces).isEmpty)
            .opacity(capturedText.trimmingCharacters(in: .whitespaces).isEmpty ? 0.4 : 1)
        }
        .padding(CoTheme.Space.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var captureLinkScreen: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.l) {
            Spacer()

            Text("paste the link.")
                .font(CoTheme.title())
                .foregroundStyle(CoTheme.ink)

            Text("next time, use the share sheet from any app — that's the fast way in.")
                .font(CoTheme.caption())
                .foregroundStyle(CoTheme.inkSoft)

            TextField("https://…", text: $capturedText)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(CoTheme.Space.m)
                .background(CoTheme.card, in: RoundedRectangle(cornerRadius: CoTheme.cornerRadius))

            Spacer()

            CoActionButton(label: "keep it", prominent: true) {
                Task {
                    let trimmed = capturedText.trimmingCharacters(in: .whitespaces)
                    let url = URL(string: trimmed)
                    // a co world link PAIRS the app (8/4 — before this, no UI path ever paired;
                    // fresh installs were demo-locked forever)
                    if let u = url, trimmed.range(of: "/w/[0-9a-f]{20}", options: .regularExpression) != nil {
                        Pairing.set(u)
                        await model.repair()
                        model.toasts.show("paired — this world is yours now")
                    } else {
                        _ = await model.capture(CapturePayload(sourceType: .url, coverage: .urlOnly, url: url))
                    }
                    step = .whyTap
                }
            }
            .disabled(capturedText.trimmingCharacters(in: .whitespaces).isEmpty)
            .opacity(capturedText.trimmingCharacters(in: .whitespaces).isEmpty ? 0.4 : 1)
        }
        .padding(CoTheme.Space.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: one light question (§7 verbatim)

    private var whyTapScreen: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.m) {
            Spacer()

            Text("what pulled you in most?")
                .font(CoTheme.title())
                .foregroundStyle(CoTheme.ink)
                .padding(.bottom, CoTheme.Space.m)

            ForEach(
                ["making something", "the people in the room", "going somewhere regularly",
                 "how their life feels", "just fun to watch"],
                id: \.self
            ) { option in
                onboardingChoice(option) {
                    whyChoice = option
                    step = .personalResponse
                }
            }

            Spacer()
        }
        .padding(CoTheme.Space.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: first personal response (§7)

    private var personalResponseScreen: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.l) {
            Spacer()

            Text("got it.")
                .font(CoTheme.title())
                .foregroundStyle(CoTheme.ink)

            if usedExample {
                // verbatim §7 — the example path earned this specific line
                Text("the pottery was the setting.\nthe room was the part you wanted.")
                    .font(CoTheme.body())
                    .foregroundStyle(CoTheme.ink)
                Text("i’ll remember that distinction.")
                    .font(CoTheme.body())
                    .foregroundStyle(CoTheme.ink)
            } else {
                // real capture in demo mode: honest about what co has
                Text("“\(whyChoice ?? "that")” is the part i’ll keep with it —\nthe part that usually gets lost.")
                    .font(CoTheme.body())
                    .foregroundStyle(CoTheme.ink)
                Text("i haven’t looked inside it yet. that happens on the next sync.")
                    .font(CoTheme.caption())
                    .foregroundStyle(CoTheme.inkSoft)
            }

            Spacer()

            HStack(spacing: CoTheme.Space.s) {
                CoActionButton(label: "find a door like this") {
                    toasts.comingInBeta()
                }
                CoActionButton(label: "just keep it", prominent: true) {
                    step = .account
                }
            }
        }
        .padding(CoTheme.Space.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: account after value (§7)

    private var accountScreen: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.l) {
            Spacer()

            Text("keep building this with co?")
                .font(CoTheme.title())
                .foregroundStyle(CoTheme.ink)

            // scaffold: native sign in with apple. the anonymous first moment is
            // preserved on account creation. BLOCKED: supabase project — the
            // authorization result has nowhere to go yet, so we say so.
            SignInWithAppleButton(.continue) { request in
                request.requestedScopes = []
            } onCompletion: { _ in
                toasts.show("sign-in isn’t wired to a backend yet. your moment stays on this device.")
                step = .covenant
            }
            .signInWithAppleButtonStyle(.black)
            .frame(height: 50)
            .clipShape(RoundedRectangle(cornerRadius: CoTheme.cornerRadius))

            Button("not yet") { step = .covenant }
                .font(CoTheme.body())
                .foregroundStyle(CoTheme.inkSoft)

            Spacer()
        }
        .padding(CoTheme.Space.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: visible covenant (§7 verbatim)

    private var covenantScreen: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.l) {
            Spacer()

            Text("your life is not inventory.")
                .font(CoTheme.title())
                .foregroundStyle(CoTheme.ink)

            VStack(alignment: .leading, spacing: CoTheme.Space.s) {
                covenantLine("co sees only what you send or ask it to watch")
                covenantLine("your private material is not sold")
                covenantLine("your content is not used to train a shared co model by default")
                covenantLine("every personal pattern has receipts")
                covenantLine("you can export or delete anything")
            }

            Spacer()

            CoActionButton(label: "enter co", prominent: true) {
                onFinished()
            }
        }
        .padding(CoTheme.Space.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func covenantLine(_ text: String) -> some View {
        Text("• \(text)")
            .font(CoTheme.body())
            .foregroundStyle(CoTheme.ink)
    }

    private func onboardingChoice(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(CoTheme.body())
                .foregroundStyle(CoTheme.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(CoTheme.Space.m)
                .background(CoTheme.card, in: RoundedRectangle(cornerRadius: CoTheme.cornerRadius))
                .overlay(
                    RoundedRectangle(cornerRadius: CoTheme.cornerRadius)
                        .strokeBorder(CoTheme.hairline, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - the quiet looping sequence on the promise screen (§7)

struct QuietLoopView: View {
    private let pairs: [(kind: String, why: String)] = [
        ("reel", "“the people in the room”"),
        ("voice", "“something i want to change”"),
        ("photo", "“how i want home to feel”"),
        ("podcast", "“tell me when this idea develops”"),
    ]

    @State private var index = 0

    var body: some View {
        HStack(spacing: CoTheme.Space.s) {
            Text(pairs[index].kind)
                .font(CoTheme.caption())
                .foregroundStyle(CoTheme.inkSoft)
            Image(systemName: "arrow.right")
                .font(.caption2)
                .foregroundStyle(CoTheme.inkSoft)
            Text(pairs[index].why)
                .font(CoTheme.caption())
                .foregroundStyle(CoTheme.ink)
        }
        .id(index)
        .transition(.opacity)
        .animation(.easeInOut(duration: 0.4), value: index)
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2.4))
                index = (index + 1) % pairs.count
            }
        }
    }
}

#Preview {
    OnboardingFlow(onFinished: {})
        .environment(previewModel())
        .environment(ToastCenter())
}
