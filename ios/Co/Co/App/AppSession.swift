import Foundation

@Observable
@MainActor
final class AppSession {
    enum Stage: Equatable {
        case launching
        case phone
        case code(phoneLast4: String)
        case ready
        case unavailable
    }

    private(set) var stage: Stage = .launching
    private(set) var api: (any CoAPI)?
    /// SwiftUI identity for the member-scoped experience — bumping it forces every store to
    /// rebuild around the new API instead of retaining stale relationship state.
    private(set) var relationshipGeneration = 0
    private(set) var isWorking = false
    private(set) var errorMessage: String?

    /// True when this launch found an existing relationship (keychain, status, or deep link) —
    /// those members skip straight to the shell instead of running intake.
    private(set) var hadRelationshipAtLaunch = false
    private(set) var intakeFinished = false

    var showsShell: Bool {
        stage == .ready && (intakeFinished || hadRelationshipAtLaunch)
    }

    private var auth: (any CoAuthProviding)?
    private var phoneAPI: PhoneLinkAPI?
    private var challenge: PhoneLinkChallenge?
    private var challengePhoneNumber: String?
    private var configuration: CoRuntimeConfiguration?

    func start() async {
        guard stage == .launching else { return }
        let arguments = ProcessInfo.processInfo.arguments

        if let api = Self.debugAPIOverride(arguments) {
            hadRelationshipAtLaunch = true   // the demo member IS a relationship; no intake
            becomeReady(with: api)
            return
        }

        if let link = RelationshipLinkStore.load() {
            hadRelationshipAtLaunch = true
            becomeReady(with: RailCoAPI(baseURL: link.worldURL))
            return
        }

        #if DEBUG
        if arguments.contains("-coPhoneOnboardingPreview") {
            stage = .phone
            return
        }
        #endif

        guard let configuration = CoRuntimeConfiguration.bundled else {
            errorMessage = "this build isn't connected to co yet"
            stage = .unavailable
            return
        }
        self.configuration = configuration
        let auth = SupabaseCoAuth(url: configuration.supabaseURL,
                                   publishableKey: configuration.supabasePublishableKey)
        self.auth = auth
        isWorking = true
        defer { isWorking = false }
        do {
            try await auth.prepare()
            let phoneAPI = PhoneLinkAPI(baseURL: configuration.apiBaseURL,
                                        accessToken: { await auth.accessToken() })
            self.phoneAPI = phoneAPI
            let status = try await phoneAPI.status()
            if status.linked {
                hadRelationshipAtLaunch = true
                if await !adoptRailWorld(from: status) {
                    becomeReady(with: liveAPI(configuration: configuration, auth: auth))
                }
            } else {
                stage = .phone
            }
        } catch {
            errorMessage = "co couldn't get the line ready, try again in a moment"
            stage = .unavailable
        }
    }

    func requestCode(phoneInput: String) async {
        guard stage == .phone, let phoneAPI, let phone = PhoneNumberInput.e164(phoneInput) else {
            errorMessage = "add the country code, like +1"
            return
        }
        errorMessage = nil
        isWorking = true
        defer { isWorking = false }
        do {
            let challenge = try await phoneAPI.request(phoneNumber: phone)
            self.challenge = challenge
            challengePhoneNumber = phone
            stage = .code(phoneLast4: challenge.phoneLast4)
        } catch PhoneLinkAPIError.rejected(429) {
            errorMessage = "too many tries for now, give it a few minutes"
        } catch {
            errorMessage = "that text didn't go through, check the number and try again"
        }
    }

    func verify(code: String) async {
        guard case .code = stage, let phoneAPI, let challenge, let challengePhoneNumber,
              code.count == 6, code.allSatisfy({ $0.isNumber }),
              let configuration, let auth
        else { return }
        errorMessage = nil
        isWorking = true
        defer { isWorking = false }
        do {
            try await phoneAPI.verify(challengeId: challenge.challengeId, code: code,
                                      phoneNumber: challengePhoneNumber)
            let status = try await phoneAPI.status()
            guard status.linked else { throw PhoneLinkAPIError.malformedResponse }
            if await !adoptRailWorld(from: status) {
                becomeReady(with: liveAPI(configuration: configuration, auth: auth))
            }
        } catch PhoneLinkAPIError.rejected(422) {
            errorMessage = "that code didn't match, try the newest one"
        } catch PhoneLinkAPIError.rejected(503) {
            errorMessage = "co couldn't finish linking that number, try again in a moment"
        } catch {
            errorMessage = "something interrupted that, try the code again"
        }
    }

    func useAnotherNumber() {
        challenge = nil
        challengePhoneNumber = nil
        errorMessage = nil
        stage = .phone
    }

    func retry() async {
        guard stage == .unavailable else { return }
        errorMessage = nil
        stage = .launching
        await start()
    }

    /// iMessage-first onboarding lands here — the link is validated before it can replace the
    /// current member; an existing relationship, so no questionnaire.
    func connect(_ incoming: URL) async {
        guard let link = RelationshipLink.incoming(incoming) else { return }
        let railAPI = RailCoAPI(baseURL: link.worldURL)
        guard (try? await railAPI.home()) != nil else {
            errorMessage = "that co link isn't available anymore"
            return
        }
        do {
            try RelationshipLinkStore.save(link)
            hadRelationshipAtLaunch = true
            becomeReady(with: railAPI)
        } catch {
            errorMessage = "this phone couldn't keep the private link"
        }
    }

    /// The intake's answer ships to the rail to seed the graph — best-effort, a hiccup just logs and moves on.
    func finishIntake(with answers: OnboardingAnswers) async {
        intakeFinished = true
        guard let phoneAPI else { return }
        let payload = answers.wirePayload
        guard !payload.isEmpty else { return }
        do {
            try await phoneAPI.submitOnboarding(answers: payload)
        } catch {
            // Seeding is a gift, not a gate.
        }
    }

    /// Adopts the member's RAIL world when offered — probed first so a bad URL degrades to the
    /// V2 door instead of breaking, and saved to Keychain so the next launch short-circuits.
    private func adoptRailWorld(from status: PhoneLinkStatus) async -> Bool {
        guard let raw = status.worldURL, let url = URL(string: raw),
              let link = RelationshipLink.normalized(url) else { return false }
        let railAPI = RailCoAPI(baseURL: link.worldURL)
        guard (try? await railAPI.home()) != nil else { return false }
        try? RelationshipLinkStore.save(link)
        becomeReady(with: railAPI)
        return true
    }

    private func liveAPI(configuration: CoRuntimeConfiguration,
                         auth: any CoAuthProviding) -> LiveCoAPI {
        LiveCoAPI(baseURL: configuration.apiBaseURL,
                   accessToken: { await auth.accessToken() })
    }

    /// The Debug launch hooks, both ahead of any keychain link a previous run left behind:
    /// `-coFixtures` is the offline demo member; `-coWorldURL http://127.0.0.1:8099/w/<slug>`
    /// points the app at a local rail (pairing needs a phone number and an edge round-trip
    /// the simulator does not have). Release builds compile to nil.
    private static func debugAPIOverride(_ arguments: [String]) -> (any CoAPI)? {
        #if DEBUG
        if arguments.contains("-coFixtures") { return MockCoAPI() }
        if let i = arguments.firstIndex(of: "-coWorldURL"), i + 1 < arguments.count,
           let url = URL(string: arguments[i + 1]) {
            return RailCoAPI(baseURL: url)
        }
        #endif
        return nil
    }

    private func becomeReady(with api: any CoAPI) {
        self.api = api
        relationshipGeneration += 1
        errorMessage = nil
        stage = .ready
    }
}
