// App.swift — app entry, model wiring, tab shell (goal.md §10.1)
//
// four tabs: catches · taking shape · you should know · me.
// deliberately NO chat tab — contextual input lives inside items and patterns.

import SwiftUI

@main
struct CoApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(model.toasts)
                .tint(CoTheme.ink)
                .background(CoTheme.paper)
        }
    }
}

// MARK: - app model

@Observable
@MainActor
final class AppModel {
    /// paired → the real homebase client; unpaired → demo mode (the seeded maya journey).
    var api: any CoAPI = RouterAPI.paired() ?? MockAPI()

    /// called after Pairing.set — swap demo for the real client without a relaunch
    func repair() async {
        api = RouterAPI.paired() ?? MockAPI()
        await refreshAll()
    }
    var isPaired: Bool { Pairing.link != nil }
    let toasts = ToastCenter()
    let outbox: Outbox?

    var catches: [Moment] = []
    var today = TodayModel(read: nil, oneThing: nil, setup: [], then: nil, done: false)
    var overnight: OvernightModel? = nil
    var rooms: [RoomModel] = []
    var staff: [StaffEntry] = []
    /// the flagship loop's output half — what changed in their week, still reversible
    var lived = LivedState(live: [], proposed: [], settled: 0, endorsed: 0)
    var patterns: [PatternCard] = []
    var radar = RadarState(newItems: [], waiting: [], watching: [])
    var me = MeModel(
        whatKeepsCatchingYou: [], thingsYouWantMoreOf: [],
        standardsCoIsLearning: [], watching: [], hypothesesCoIsTesting: []
    )
    var privacy = PrivacySettings()

    init() {
        outbox = try? Outbox()
        // dev fast-path (8/4): CO_PAIR_LINK env pairs at launch — combined with
        // -hasEnteredCo YES -skippedPairing YES launch args, you land straight in
        // your own world with zero onboarding taps.
        if let s = ProcessInfo.processInfo.environment["CO_PAIR_LINK"], let u = URL(string: s) {
            Pairing.set(u)
            api = RouterAPI.paired() ?? MockAPI()
        }
    }

    func refreshAll() async {
        // mock api never throws; the real client will surface errors honestly.
        catches = (try? await api.fetchCatches()) ?? []
        today = (try? await api.fetchToday()) ?? today
        overnight = (try? await api.fetchOvernight()) ?? nil
        patterns = (try? await api.fetchPatterns()) ?? []
        radar = (try? await api.fetchRadar()) ?? radar
        me = (try? await api.fetchMe()) ?? me
        rooms = (try? await api.fetchRooms()) ?? []
        staff = (try? await api.fetchStaff()) ?? []
        lived = (try? await api.fetchLived()) ?? lived
    }

    /// After the member accepts, undoes, or closes a lived test — the surface must show the
    /// new truth immediately, because the undo has to feel like it actually took.
    func refreshLived() async {
        lived = (try? await api.fetchLived()) ?? lived
    }

    /// queue a capture, then hand it to the api (demo: immediate local echo).
    /// returns the outbox item id so the why-tap can attach its answer.
    func capture(_ payload: CapturePayload) async -> String? {
        let itemID = try? outbox?.enqueue(payload)
        await drainOutboxOnce()
        return itemID
    }

    /// minimal drainer: uploads pending items via the api seam.
    /// the real client replaces this with a background-url-session pipeline.
    func drainOutboxOnce() async {
        guard let outbox else { return }
        while let item = try? outbox.dequeue() {
            do {
                try await api.uploadCapture(item.decodedPayload())
                try? outbox.markDone(itemID: item.id)
            } catch {
                try? outbox.markFailed(itemID: item.id, error: "\(error)")
                break
            }
        }
        catches = (try? await api.fetchCatches()) ?? catches
    }
}

// MARK: - root: onboarding, then tabs

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(ToastCenter.self) private var toasts
    @AppStorage("hasEnteredCo") private var hasEnteredCo = false
    @AppStorage("skippedPairing") private var skippedPairing = false

    var body: some View {
        Group {
            if hasEnteredCo {
                if model.isPaired || skippedPairing {
                    MainTabView()
                } else {
                    ConnectView(onDone: { skippedPairing = true })
                }
            } else {
                OnboardingFlow(onFinished: { hasEnteredCo = true })
            }
        }
        .task { await model.refreshAll() }
        .toastOverlay(toasts)
    }
}

struct MainTabView: View {
    @State private var selected: Int = Int(ProcessInfo.processInfo.environment["CO_DEBUG_TAB"] ?? "0") ?? 0

    var body: some View {
        TabView(selection: $selected) {
            Tab("today", systemImage: "sun.max", value: 0) {
                TodayView()
            }
            Tab("world", systemImage: "square.grid.2x2", value: 1) {
                CatchesView()
            }
            Tab("talk", systemImage: "bubble.left", value: 2) {
                TalkView()
            }
            Tab("search", systemImage: "magnifyingglass", value: 3, role: .search) {
                SearchView()
            }
        }
        .preferredColorScheme(.dark)   // the theme is black. keep it simple (8/4)
    }
}

#Preview {
    RootView()
        .environment(AppModel())
        .environment(ToastCenter())
}
