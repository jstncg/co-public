import SwiftUI

struct AppShellView: View {
    /// The user's appearance (system by default) — held here so it applies above every tab and sheet.
    @AppStorage("coAppearance") private var appearanceRaw = CoAppearance.system.rawValue

    @State private var selection: CoTab
    /// Both are sheets over the still shell, not destinations (Justin, 2026-08-03: plan tab is gone).
    @State private var showChat = false
    @State private var showSettings = false
    /// Where to hand selection back to when the Co circle is tapped.
    @State private var lastDestination: CoTab = .home

    /// The gear's zoom source, so settings grows out of the button that opened it.
    @Namespace private var gear

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // Tab stores live here, not on the screens — the tab switch unmounts the inactive subtree,
    // which would destroy and rebuild a screen-owned `@State` store every time.
    @State private var feedStore = FeedStore()
    @State private var chatStore = ChatStore()
    @State private var archiveStore = ArchiveStore()
    @State private var notesStore = NotesStore()
    /// One query for all three pages, since the field that types it now lives in the shell.
    @State private var search = CoSearch()
    /// The quick-note composer takes the footer's slot, on whichever page is showing.
    @State private var composing = false
    /// True when the chat was opened by the Ask Co bar, which lands in voice, not in the thread.
    @State private var askInVoice = false
    /// Kept past `init` because Home's shelves are the one thing no store fetches for
    /// itself — `NotesStore` is local-first and has no api of its own, and giving it a
    /// client would mean two `app.json` fetches for one screen.
    private let api: any CoAPI

    init(api: any CoAPI = CoAPIEnvironment.current()) {
        self.api = api
        _feedStore = State(initialValue: FeedStore(api: api))
        _archiveStore = State(initialValue: ArchiveStore(api: api))
        _chatStore = State(initialValue: ChatStore(api: api))
        let args = ProcessInfo.processInfo.arguments
        // Home and Tasks have no rail endpoint yet, so fixtures are the only thing that fills
        // them. ON BY DEFAULT in Debug (Justin, 2026-08-11): tapping the icon on a simulator
        // passes no launch arguments, so an opt-in flag meant the app came up empty every time
        // it was not started by a script — which is most of the time. `-coNoFixtures` opts out.
        // Release is unaffected: a shipped build shows the member's own pages, empty or not.
        #if DEBUG
        let fixtures = !args.contains("-coNoFixtures")
        #else
        let fixtures = args.contains("-coFixtures")
        #endif
        _notesStore = State(initialValue: NotesStore(seed: fixtures ? NotesFixtures.board : nil,
                                                    forYou: fixtures ? HomeFixtures.forYou : [],
                                                    recap: fixtures ? HomeFixtures.recap : [],
                                                    profile: fixtures ? HomeFixtures.profile : [],
                                                    watches: fixtures ? HomeFixtures.watches : []))
        if let i = args.firstIndex(of: "-coTab"), i + 1 < args.count,
           let tab = CoTab(rawValue: args[i + 1]) {
            _selection = State(initialValue: tab)
            _lastDestination = State(initialValue: tab)
        } else {
            _selection = State(initialValue: .home)
        }
    }

    @ViewBuilder
    var body: some View {
        ZStack {
            shell.transition(.opacity)

            // The chat just fades in (Justin, 2026-08-03: "dont make it an expand, just fade in") — always
            // mounted, never inserted/removed, since tearing it down on close read as a chop (Justin, 2026-08-04).
            CoChatView(onClose: { showChat = false; askInVoice = false },
                       isActive: showChat, opensInVoice: askInVoice)
                .environment(chatStore)
                // It EXPANDS from the middle of the screen, it does not fade (Justin,
                // 2026-08-11). A crossfade reads as a swap between two screens; a centre-
                // anchored scale-in reads as the thing the tap just opened. `morph` because
                // the gesture is interruptible — closing mid-open keeps its velocity.
                // 0.92, not 0.88: Emil's floor for an entrance is 0.9 — below it the thing
                // reads as arriving from nowhere rather than growing into place. Centre anchor
                // because this is a modal, and modals are the one surface that is NOT
                // origin-aware; they belong to the screen, not to the button that opened them.
                .scaleEffect(showChat || reduceMotion ? 1 : 0.92, anchor: .center)
                .opacity(showChat ? 1 : 0)
                .allowsHitTesting(showChat)
                .animation(reduceMotion ? CoMotion.fast : CoMotion.morph, value: showChat)
        }
        // Every `Text` without its own font inherits Inter from here.
        .font(CoType.style(.body))
        // nil means "follow the system", which is the case for `.system`.
        .preferredColorScheme(CoAppearance(rawValue: appearanceRaw)?.colorScheme)
    }

    /// The app's bottom row, or the quick-note card when the member is writing one. Either way
    /// it occupies the same slot, so the page never jumps between the two.
    @ViewBuilder
    private var footer: some View {
        if composing {
            QuickNoteComposer(
                onAdd: { notesStore.addToToday($0) },
                onClose: { composing = false })
                .padding(.horizontal, CoSpacing.m)
                .padding(.bottom, CoSpacing.s)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        } else {
            CoAppFooter(onAsk: { askInVoice = true; showChat = true })
                .environment(search)
        }
    }

    private var shell: some View {
        // v0.7 (Justin, 2026-08-10): the bar is a hand-built row at the TOP, not the iOS 26
        // bottom `TabView`. `Tab` cannot host a leading button in its own row, and Home now owns
        // the bottom edge for search / mic / new note.
        //
        // v0.9 (Justin, 2026-08-11): the bar is an INSET, not a row in a VStack. As a VStack row
        // it owned an opaque band of page that nothing could scroll beneath, so its glass had
        // only flat cream to refract and read as painted plastic. Glass needs something moving
        // behind it or it is not glass. Now the page runs full height, content passes under the
        // bar, and `CoHeaderBlur` — the same veil the task transcript wears — dissolves it.
        Group {
            switch selection {
            case .home:
                NotesHomeView(onNewNote: { composing = true })
            case .archive:
                ArchiveView(settingsNamespace: gear, onSettings: { showSettings = true })
            case .profile:
                ProfileView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(CoColor.appBackground.color)
        // The veil sits above the page and below the bar, so the content dissolves upward
        // instead of being chopped by the bar's edge.
        .overlay(alignment: .top) { CoHeaderBlur() }
        // The edge treatments are NOT here (DS §5.3). `scrollEdgeEffectStyle` configures the
        // scroll view it is attached to; on this Group it attaches to nothing and silently does
        // nothing, which is exactly how it looked when it was tried here (sim, 2026-08-11).
        // Each screen sets it on its own ScrollView, the way `FeedView` did before it.
        // `m` 12 nominal, ~18 optical (DS §4.4b): 12 here, plus the 2pt of dead space under the
        // pill's paint, plus the label's own line-box leading. `l` 16 was tried and read as too
        // far because it rendered at ~22 — a gap against TYPE is measured from the cap height,
        // not from the layout box. Calibrated to `pillHeight` 40 in a 44 row; if the pills go
        // back to a full 44 this returns to `l`.
        //
        // Set once here so Home, Tasks and Archive all clear the bar by the same amount — a
        // per-screen top padding is how three screens end up three different distances down.
        .safeAreaInset(edge: .top, spacing: CoSpacing.m) {
            CoTopTabBar(selection: $selection,
                        onLeading: { showSettings = true },
                        leadingNamespace: gear)
        }
        // Search, Ask Co and new note belong to the app, not to Home (Justin, 2026-08-10),
        // so they are mounted once here and every page inherits them.
        //
        // `safeAreaBar`, not `safeAreaInset` (2026-08-11). This is what restores the footer blur
        // the app had before the redesign: back then the bottom was a native `TabView`, and iOS
        // draws its scroll edge effect under things it KNOWS are bars. `safeAreaInset` is plain
        // layout — the footer was just a view sitting in the safe area, so the system had no
        // reason to dissolve anything beneath it. `scrollEdgeEffectStyle` on the scroll views
        // was configuring an effect that had no bar to attach to.
        // The veil belongs to the BAR, not to the page (DS §5.3). As an overlay on the page it
        // stopped where the page stopped and left a sharp band of content behind the footer —
        // the dissolve has to reach the bottom of the screen, which is the bar's territory.
        // Same `VariableBlurView` the header wears, flipped, off the same knobs.
        .safeAreaBar(edge: .bottom) {
            footer.background(alignment: .bottom) {
                CoHeaderBlur(height: CoControl.barFocused + CoBlur.footerFade, edge: .bottom)
            }
        }
        .tint(CoColor.accent.color)
        .environment(search)
        .onChange(of: selection) { _, current in lastDestination = current }
        .task {
            let args = ProcessInfo.processInfo.arguments
            // Dev/screenshot hooks: these pages need taps simctl cannot drive.
            if args.contains("-coSettings") { showSettings = true }
            if args.contains("-coChat") { showChat = true }
            // Home's data rides `app.json` with everything else, so it is fetched here — the
            // shell is where both stores already live and the only place that holds the api.
            // A failed or empty fetch changes nothing: the stores keep whatever they were
            // seeded with, which is what makes the fixture path survive an older rail.
            if let home = try? await api.home() {
                notesStore.apply(forYou: home.forYou)
                notesStore.apply(recap: home.recap)
                notesStore.apply(profile: home.profile)
                notesStore.apply(watches: home.watching)
            }
        }
        .environment(feedStore)
        .environment(chatStore)
        .environment(archiveStore)
        .environment(notesStore)
        // `.environment` on an ancestor doesn't reliably reach a cover's presented content, so it's
        // applied directly to the cover's root view. Full screen, not a half-height card (Justin, 2026-08-03).
        .fullScreenCover(isPresented: $showSettings) {
            SettingsView(onClose: { showSettings = false })
                .navigationTransition(.zoom(sourceID: "settings", in: gear))
        }
    }

}
