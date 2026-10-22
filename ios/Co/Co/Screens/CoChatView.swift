import PhotosUI
import SwiftUI
import UIKit

// Ask Co — the slide-up chat card. One continuous thread, never a conversation list,
// hydrated from both iMessage and native app turns.

@Observable
@MainActor
final class ChatStore {
    struct Message: Identifiable, Equatable {
        let id: String
        let isCo: Bool
        let text: String

        init(id: String = UUID().uuidString.lowercased(), isCo: Bool, text: String) {
            self.id = id
            self.isCo = isCo
            self.text = text
        }
    }

    private(set) var messages: [Message]
    private(set) var isThinking = false
    /// Ordered drain of pending turns — lets tests await real work, and two quick sends
    /// can never race into an invisible cancelled answer.
    private(set) var replyTask: Task<Void, Never>?
    private(set) var isLoadingHistory = false
    private var pendingLines: [String] = []

    private let api: CoAPI

    init(api: CoAPI = CoAPIEnvironment.current(),
         messages: [Message] = ChatStore.launchSeed) {
        self.api = api
        self.messages = messages
        isThinking = ProcessInfo.processInfo.arguments.contains("-coThinking")
    }

    func loadHistory() async {
        guard !isLoadingHistory else { return }
        isLoadingHistory = true
        defer { isLoadingHistory = false }
        do {
            let history = try await api.chatHistory()
            apply(history, preservingLocal: isThinking)
        } catch {
            // Thread stays usable if history is briefly unavailable; a later open retries.
        }
    }

    func ask(_ text: String) {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return }
        messages.append(Message(isCo: false, text: line))
        pendingLines.append(line)
        startPendingTurns()
    }

    private func startPendingTurns() {
        guard replyTask == nil else { return }
        isThinking = true
        replyTask = Task { [weak self] in
            guard let self else { return }
            while !self.pendingLines.isEmpty {
                let line = self.pendingLines.removeFirst()
                let reply: String
                var reachedServer = false
                do {
                    reply = try await self.api.chat(line)
                    reachedServer = true
                } catch {
                    reply = "something interrupted that, try again"
                }
                if reachedServer {
                    do {
                        let history = try await self.api.chatHistory()
                        if history.isEmpty {
                            self.messages.append(Message(isCo: true, text: reply))
                        } else {
                            self.apply(history, preservingLocal: !self.pendingLines.isEmpty)
                        }
                    } catch {
                        self.messages.append(Message(isCo: true, text: reply))
                    }
                } else {
                    self.messages.append(Message(isCo: true, text: reply))
                }
            }
            self.isThinking = false
            self.replyTask = nil
        }
    }

    func commitTranscript(_ lines: [VoiceSession.Line]) {
        guard !lines.isEmpty else { return }
        let new = lines.map { Message(isCo: $0.isCo, text: $0.text) }
        messages.append(contentsOf: new)
    }

    func sendVoice(seconds: Double) {
        _ = seconds
        messages.append(Message(isCo: true, text: Self.voiceUnavailable))
    }

    func attach(_ name: String) {
        _ = name
        messages.append(Message(isCo: true, text: Self.attachmentUnavailable))
    }

    static let voiceUnavailable = "voice notes aren't connected yet"

    static let attachmentUnavailable = "attachments aren't connected yet"

    private func apply(_ history: [CoChatMessage], preservingLocal: Bool) {
        // An empty fetch is no information, never an eraser — a transient empty history must not
        // wipe a thread the member is looking at (Dennis, main@1e9033d). Ported here rather than to
        // the call sites: the poller already guarded itself, `loadHistory` did not, and this is the
        // one funnel both go through, so the guard cannot be missed by a third caller later.
        if history.isEmpty && !messages.isEmpty { return }
        let existing = messages
        messages = history.map { Message(id: $0.id, isCo: $0.isCo, text: $0.text) }
        guard preservingLocal else { return }
        var serverPairs = Dictionary(grouping: messages, by: { "\($0.isCo):\($0.text)" })
            .mapValues(\.count)
        for message in existing {
            let key = "\(message.isCo):\(message.text)"
            if let count = serverPairs[key], count > 0 {
                serverPairs[key] = count - 1
            } else {
                messages.append(message)
            }
        }
    }

    /// `-coChatSeed`: a photographable exchange for screenshots.
    static var launchSeed: [Message] {
        guard ProcessInfo.processInfo.arguments.contains("-coChatSeed") else { return [] }
        return [
            Message(isCo: false, text: "What did you find on the sauna suppliers?"),
            Message(isCo: true, text: "Three quotes so far. The local mill is cheapest "
                + "at $2.1k with pickup in Vaughan, and the price holds through the end "
                + "of the month. The full comparison is in your feed."),
        ]
    }
}

struct CoChatView: View {
    var onClose: () -> Void
    /// Whether the chat is on screen. The view is always mounted (never torn down), so
    /// this is the open signal — every open resets to the plain thread.
    var isActive: Bool = true
    /// True when the member came in through the Ask Co bar, which is a call, not a thread —
    /// it lands in voice mode with the line already open (Justin, 2026-08-10).
    var opensInVoice: Bool = false

    @Environment(ChatStore.self) private var chat
    @Environment(VoiceSession.self) private var voice
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var draft = ""
    @FocusState private var focused: Bool
    @State private var scrolledID: ChatStore.Message.ID?
    /// At the composer (the tail) vs scrolled up into history — gates the down-arrow.
    @State private var isAtTail = true
    /// Whether docked voice mode is still following the live tail; scrolling away from it
    /// turns this off so history can be read while new lines keep appending below.
    @State private var liveFollower = true
    /// True while a programmatic pin is animating, so the scroll detector doesn't read
    /// our own pin as the user's finger.
    @State private var isPinning = false
    /// Ownership token for the pin window: a newer `pin(to:)` supersedes an older one, so
    /// an overlapping pin's delayed clear can't stomp a still-settling one.
    @State private var pinToken = 0
    /// Voice is a MODE of this screen, not a separate one. The thread shows in `thread` and
    /// `docked`; `voice` is the mascot alone (Justin, 2026-08-11).
    ///
    /// Dev/screenshot hook. Read once as a static: it is also consulted when the screen becomes
    /// active, where the initial value alone was being overwritten back to `.thread` — the flag
    /// opened voice for one frame and then lost it (sim, 2026-08-11).
    private static let flagOpensVoice =
        ProcessInfo.processInfo.arguments.contains("-coVoice")
    @State private var stage: Stage = CoChatView.flagOpensVoice ? .voice : .thread
    @State private var pulsing = false
    /// The orb's position relative to home, rubber-banded — a physical thing you drag and
    /// release; the release direction picks the mode.
    @State private var pull: CGSize = .zero
    @State private var recorder = VoiceRecorder()

    /// Contact disc in the thread, orb in voice — one view at two sizes.
    enum Stage {
        case thread, voice, docked

        var isVoice: Bool { self != .thread }
        var below: Stage { self == .thread ? .voice : .docked }
        var above: Stage { self == .docked ? .voice : .thread }
    }

    private var discSize: CGFloat {
        switch stage {
        case .thread: 64
        case .voice: 190
        case .docked: 104
        }
    }

    private var faceSize: CGFloat { stage == .voice ? 190 : discSize * 0.62 }

    /// The call, on co's face. In the thread it is a still contact disc and rests; in voice it
    /// is the only thing on screen, so it carries the phase the transcript would otherwise have
    /// to say out loud: connecting, listening, working on a reply, talking, or lost.
    ///
    /// `.speaking` maps to `dictating`, which the source gives no blink cadence — if the face
    /// reads frozen through a long reply, `working` is the one-word swap.
    private var mascotState: MascotState {
        guard stage.isVoice else { return .resting }
        switch voice.phase {
        case .idle: return .idle
        case .connecting: return .spawning
        case .listening: return voice.coIsGenerating ? .thinking : .listening
        case .speaking: return .dictating
        case .failed: return .confused
        }
    }

    private static let tailID = "__tail__"
    private static let headerInset: CGFloat = 108

    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { page in
                ZStack(alignment: .top) {
                    // Voice mode is the mascot and nothing else (Justin, 2026-08-11). The thread
                    // used to keep rendering behind the orb — history and live transcript both —
                    // which made a call look like a chat someone had scrolled up in. Hidden, not
                    // unmounted: the scroll position survives the round trip, and `docked` is
                    // still where you go to read what was said.
                    thread
                        .opacity(stage == .voice ? 0 : 1)
                        .allowsHitTesting(stage != .voice)
                        .animation(reduceMotion ? nil : CoMotion.standard, value: stage)

                    contactBlock
                        .frame(width: page.size.width)
                        .padding(.top, CoSpacing.s)
                        .offset(y: restingOffset(in: page.size.height))
                }
                // `.top` matters — without it the frame centers the block and the offset
                // pushes it off the bottom.
                .frame(width: page.size.width, height: page.size.height, alignment: .top)
                .overlay(alignment: .top) {
                    CoHeaderBlur()
                }
                .overlay(alignment: .bottom) {
                    if stage == .thread && !isAtTail {
                        Button {
                            withAnimation(reduceMotion ? nil : CoMotion.morph) {
                                scrolledID = Self.tailID
                            }
                        } label: {
                            Image(systemName: "chevron.down")
                                .font(.system(size: CoControl.discIcon, weight: .semibold))
                                .foregroundStyle(CoColor.textPrimary.color)
                                .frame(width: CoControl.disc, height: CoControl.disc)
                        }
                        .glassEffect(.regular.interactive(), in: Circle())
                        .buttonStyle(CoPressStyle())
                        .padding(.bottom, CoSpacing.m)
                        .transition(.opacity.combined(with: .offset(y: 8)))
                        .accessibilityLabel("Scroll to latest")
                    }
                }
                .animation(reduceMotion ? nil : CoMotion.fast, value: isAtTail)
            }

            CoComposer(draft: $draft, focused: $focused,
                        trailing: stage.isVoice ? .exit : .voice,
                        recorder: recorder,
                        onSend: send,
                        onTrailing: { go(to: stage.isVoice ? .thread : .voice) },
                        onVoiceMessage: { chat.sendVoice(seconds: $0) },
                        onAttachment: { chat.attach($0) })
                .padding(.horizontal, CoSpacing.l)
                .padding(.vertical, CoSpacing.m)
        }
        .overlay(alignment: .topLeading) {
            topBar.padding(.top, CoSpacing.s)
        }
        .background(CoColor.appBackground.color.ignoresSafeArea())
        // Swipe down anywhere above the bar dismisses the keyboard — `.scrollDismissesKeyboard`
        // alone only covers drags starting on the thread.
        .simultaneousGesture(
            DragGesture(minimumDistance: 24)
                .onEnded { drag in
                    guard focused, drag.translation.height > 40,
                          abs(drag.translation.height) > abs(drag.translation.width)
                    else { return }
                    focused = false
                }
        )
        .sensoryFeedback(.impact(flexibility: .soft), trigger: stage)
        // `-coVoice` opens the call the same way a hand-pulled entry does.
        .task {
            if isActive { await chat.loadHistory() }
            if stage.isVoice {
                liveFollower = true
                pin(to: newestContentID)
                await voice.start(history: chat.messages.suffix(12).map { CoChatMessage(id: $0.id, isCo: $0.isCo, text: $0.text, sentAt: nil, transport: nil) })
            }
        }
        .onChange(of: isActive) { _, nowActive in
            if nowActive {
                Task { await chat.loadHistory() }
                stage = (opensInVoice || Self.flagOpensVoice) ? .voice : .thread
                pull = .zero
                focused = false
                scrolledID = Self.tailID
                if opensInVoice || Self.flagOpensVoice {
                    liveFollower = true
                    Task {
                        await voice.start(history: chat.messages.suffix(12).map {
                            CoChatMessage(id: $0.id, isCo: $0.isCo, text: $0.text,
                                          sentAt: nil, transport: nil)
                        })
                    }
                }
            } else if stage.isVoice {
                // Only end the call when actually closing, not on foreground/re-open.
                chat.commitTranscript(voice.takeTranscript())
                voice.end()
            }
        }
        .onChange(of: voice.phase) {
            // Breathing is the WAIT affordance only; once audio flows the orb runs on
            // `level` — a timer pulse over real speech is the lie this screen avoids.
            if voice.phase == .connecting {
                startPulse()
            } else {
                withAnimation(CoMotion.standard) { pulsing = false }
            }
            // A call that fails to open must not throw you out of voice mode — the
            // screen stands on its own; only the audio is missing.
            if case .failed = voice.phase { startPulse() }
        }
    }

    private var topBar: some View {
        Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: CoControl.discIcon, weight: .semibold))
                    .foregroundStyle(CoColor.textPrimary.color)
                    .frame(width: CoControl.disc, height: CoControl.disc)
                    .contentShape(Circle().inset(by: -CoControl.reach(CoControl.disc)))
            }
        .buttonStyle(CoPressStyle())
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel("Close")
        .padding(.horizontal, CoSpacing.l)
    }

    private var contactBlock: some View {
        VStack(spacing: CoSpacing.s) {
            ZStack {
                Circle()
                    .fill(.clear)
                    .glassEffect(.regular, in: Circle())
                    .opacity(stage == .thread ? 1 : 0)
                CoMascot(state: mascotState, size: faceSize, animated: stage.isVoice)
            }
            .frame(width: discSize, height: discSize)
            // Light EMISSION, not elevation: the orb glows while it is listening, which is the one
            // thing §5.1's shadow ban is not about. It reaches 0 the moment voice ends.
            .shadow(color: CoColor.action.color.opacity(stage.isVoice ? 0.32 : 0), radius: 36)  // design: DESIGN_SYSTEM.md §5.1
            .scaleEffect(orbScale)
            // Linear, not springy: anything with lag reads instantly against real audio.
            .animation(reduceMotion ? nil : .linear(duration: 0.05), value: voice.level)
            .modifier(PlaydohStretch(pull: pull, reduceMotion: reduceMotion))
            .contentShape(Circle())
            .gesture(pullGesture)

            if stage == .thread {
                Text("Co")
                    .font(CoType.style(.subheadline, .semibold))
                    .foregroundStyle(CoColor.textPrimary.color)
                    .padding(.horizontal, CoSpacing.m)
                    .padding(.vertical, CoSpacing.xs + 2)
                    .glassEffect(.regular, in: Capsule())
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Co")
    }

    private var thread: some View {
        ScrollView {
            VStack(spacing: CoSpacing.xl + CoSpacing.xs) {
                ForEach(chat.messages) { message in
                    MessageRow(message: message)
                        .transition(.offset(y: 60).combined(with: .opacity))
                }

                if stage.isVoice {
                    ForEach(voice.transcript) { line in
                        MessageRow(message: .init(id: line.id.uuidString, isCo: line.isCo, text: line.text))
                            .transition(.opacity)
                    }

                    if voice.coIsGenerating && voice.activeAgentLineID == nil {
                        CoThinkingRow()
                            .transition(.offset(y: 12).combined(with: .opacity))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                if chat.isThinking && stage == .thread {
                    CoThinkingRow()
                        .transition(.offset(y: 12).combined(with: .opacity))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Color.clear
                    .frame(height: stage.isVoice ? discSize + CoSpacing.xl : CoSpacing.s)
                    .containerRelativeFrame(.vertical) { height, _ in
                        stage.isVoice ? height * 0.2 : CoSpacing.s
                    }
                    .id(Self.tailID)
            }
            .animation(reduceMotion ? nil : CoMotion.morph, value: chat.messages.count)
            .animation(reduceMotion ? nil : CoMotion.morph, value: chat.isThinking)
            .scrollTargetLayout()
            .padding(.horizontal, CoSpacing.l)
            .padding(.top, Self.headerInset)
            .padding(.bottom, CoSpacing.m)
        }
        // Text hugs the bottom, iMessage-style; voice keeps the top anchor its live-follow needs.
        .defaultScrollAnchor(stage.isVoice ? .top : .bottom)
        .scrollEdgeEffectHidden(true, for: .top)
        .scrollEdgeEffectHidden(true, for: .bottom)
        .scrollPosition(id: $scrolledID, anchor: stage.isVoice ? .top : .bottom)
        .onChange(of: chat.messages.count) { old, new in
            guard stage == .thread, new > 0 else { return }
            if old == 0 {
                scrolledID = Self.tailID
            } else {
                withAnimation(reduceMotion ? nil : CoMotion.morph) { scrolledID = Self.tailID }
            }
        }
        .onChange(of: voice.transcript.count) {
            guard stage.isVoice, liveFollower, let last = voice.transcript.last else { return }
            pin(to: last.id.uuidString)
        }
        .onChange(of: scrolledID) { _, newValue in
            if stage == .thread {
                isAtTail = newValue == nil || newValue == Self.tailID
                    || newValue == chat.messages.last?.id
                return
            }
            guard stage.isVoice, !isPinning else { return }
            if newValue == Self.tailID || newValue == liveTailUUID {
                liveFollower = true
            } else {
                liveFollower = false
            }
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func pin(to id: ChatStore.Message.ID?) {
        guard let id else { return }
        pinToken &+= 1
        let token = pinToken
        isPinning = true
        withAnimation(reduceMotion ? nil : CoMotion.fast) { scrolledID = id }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            guard token == pinToken else { return }
            isPinning = false
        }
    }

    private var liveTailUUID: ChatStore.Message.ID? {
        voice.transcript.last?.id.uuidString
    }

    /// The newest thing on the page — NOT the tail spacer, which would push the whole
    /// thread above the fold instead of pinning to it.
    private var newestContentID: ChatStore.Message.ID? {
        if let last = voice.transcript.last { return last.id.uuidString }
        if let last = chat.messages.last { return last.id }
        return Self.tailID
    }

    private var pullGesture: some Gesture {
        // minimumDistance 0 so this recognizer also sees taps — two recognizers on one
        // view meant drags swallowed every tap.
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                pull = CoPull.banded(value.translation)
            }
            .onEnded { value in
                let travelled = hypot(value.translation.width, value.translation.height)
                // A flick counts as a full pull via predicted velocity, not raw distance.
                let thrown = value.predictedEndTranslation.height
                withAnimation(reduceMotion ? nil : CoMotion.elastic) { pull = .zero }
                guard travelled > CoPull.tapSlop else { return go(to: stage.below) }
                if thrown > CoPull.threshold { go(to: stage.below) }
                if thrown < -CoPull.threshold { go(to: stage.above) }
            }
    }

    private func go(to next: Stage) {
        guard next != stage else { return }
        let previous = stage
        focused = false
        withAnimation(reduceMotion ? nil : CoMotion.morph) {
            stage = next
        }
        if next.isVoice && !previous.isVoice {
            Task { await voice.start(history: chat.messages.suffix(12).map { CoChatMessage(id: $0.id, isCo: $0.isCo, text: $0.text, sentAt: nil, transport: nil) }) }
            liveFollower = true
            pin(to: newestContentID)
        } else if !next.isVoice && previous.isVoice {
            chat.commitTranscript(voice.takeTranscript())
            voice.end()
            liveFollower = true
        }
    }

    private func restingOffset(in height: CGFloat) -> CGFloat {
        switch stage {
        case .thread: 0
        case .voice: (height - discSize) / 2 - CoSpacing.s
        case .docked: height - discSize - CoSpacing.s
        }
    }

    private var orbScale: CGFloat {
        if pulsing { return 1.05 }
        return stage.isVoice ? 1 + voice.level * 0.18 : 1
    }

    private func startPulse() {
        guard !reduceMotion else { return }
        withAnimation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true)) {
            pulsing = true
        }
    }

    private func send() {
        focused = false
        chat.ask(draft)
        draft = ""
    }

}

enum CoPull {
    static let threshold: CGFloat = 60
    static let tapSlop: CGFloat = 10
    static let sideLimit: CGFloat = 110
    static let verticalLimit: CGFloat = 220
    static let stretchSpan: CGFloat = 130
    static let maxStretch: CGFloat = 0.32

    static func banded(_ translation: CGSize) -> CGSize {
        CGSize(width: band(translation.width, limit: sideLimit),
               height: band(translation.height, limit: verticalLimit))
    }

    /// iOS's overscroll curve: resistance grows with distance, asymptotes to `limit`.
    static func band(_ distance: CGFloat, limit: CGFloat) -> CGFloat {
        let pulled = (1 - 1 / (abs(distance) * 0.55 / limit + 1)) * limit
        return distance < 0 ? -pulled : pulled
    }

    static func stretch(for pull: CGSize) -> CGFloat {
        let distance = sqrt(pull.width * pull.width + pull.height * pull.height)
        return maxStretch * min(distance / stretchSpan, 1)
    }
}

/// Squash & stretch along the pull axis — dough, not an icon sliding around.
private struct PlaydohStretch: ViewModifier {
    let pull: CGSize
    let reduceMotion: Bool

    func body(content: Content) -> some View {
        let stretch = reduceMotion ? 0 : CoPull.stretch(for: pull)
        let axis = Angle.radians(atan2(pull.height, pull.width))
        content
            .rotationEffect(-axis)
            .scaleEffect(x: 1 + stretch, y: 1 - stretch * 0.7, anchor: .center)
            .rotationEffect(axis)
            .offset(pull)
    }
}

/// One composer, shared by thread and voice. Only the trailing disc differs.
struct CoComposer: View {
    enum Trailing {
        case voice
        case exit
    }

    @Binding var draft: String
    @FocusState.Binding var focused: Bool
    let trailing: Trailing
    var recorder: VoiceRecorder
    var onSend: () -> Void
    var onTrailing: () -> Void
    var onVoiceMessage: (Double) -> Void
    var onAttachment: (String) -> Void

    @State private var showAttach = false
    @State private var showCamera = false
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var pickedPhoto: PhotosPickerItem?

    private var isEmpty: Bool {
        draft.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        HStack(spacing: CoSpacing.m) {
            switch recorder.phase {
            case .idle: textFace
            case .recording, .paused: recordingFace
            case .transcribing: transcribingFace
            }
        }
        .padding(.horizontal, CoSpacing.l)
        .padding(.vertical, CoSpacing.s)
        .frame(maxWidth: .infinity)
        .glassEffect(.regular.interactive(), in: Capsule())
        .animation(CoMotion.morph, value: recorder.phase)
        .overlay(alignment: .topLeading) {
            if showAttach {
                attachPanel
                    .offset(y: -(Self.attachPanelHeight + CoSpacing.s))
                    .transition(.scale(scale: 0.9, anchor: .bottomLeading)
                        .combined(with: .opacity))
            }
        }
        .background {
            if showAttach {
                Color.clear
                    .frame(width: 2000, height: 2000)
                    .contentShape(Rectangle())
                    .onTapGesture { closeAttach() }
            }
        }
        .photosPicker(isPresented: $showPhotos, selection: $pickedPhoto, matching: .images)
        .onChange(of: pickedPhoto) {
            guard pickedPhoto != nil else { return }
            pickedPhoto = nil
            onAttachment("a photo")
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item]) { result in
            guard case .success(let url) = result else { return }
            onAttachment(url.lastPathComponent)
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraCapture { onAttachment("a photo") }
                .ignoresSafeArea()
        }
    }

    @ViewBuilder
    private var textFace: some View {
        Button {
            focused = false
            withAnimation(CoMotion.morph) { showAttach.toggle() }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: CoControl.barIcon + 3, weight: .regular))
                .foregroundStyle(CoColor.textSecondary.color)
                .rotationEffect(.degrees(showAttach ? 45 : 0))
                .frame(width: CoControl.barGlyph, height: CoControl.barGlyph)
                .contentShape(Rectangle().inset(by: -CoControl.reach(CoControl.barGlyph)))
        }
        .buttonStyle(CoPressStyle())
        .accessibilityLabel("Attach")

        TextField("Ask Co", text: $draft, axis: .vertical)
            .lineLimit(1...4)
            .focused($focused)
            .onSubmit(onSend)

        if isEmpty {
            Button { Task { await startRecording() } } label: {
                Image(systemName: "mic.fill")
                    .font(.system(size: CoControl.barIcon + 1, weight: .regular))
                    .foregroundStyle(CoColor.textSecondary.color)
                    .frame(width: CoControl.barGlyph, height: CoControl.barGlyph)
                    .contentShape(Rectangle().inset(by: -CoControl.reach(CoControl.barGlyph)))
            }
            .buttonStyle(CoPressStyle())
            .accessibilityLabel("Record a voice message")

            Button(action: onTrailing) { trailingDisc }
                .buttonStyle(CoPressStyle())
                .accessibilityLabel(trailing == .voice ? "Voice mode" : "Leave voice mode")
        } else {
            Button(action: onSend) {
                disc("arrow.up", fill: CoColor.textPrimary.color,
                     tint: CoColor.claritySurface.color)
            }
            .buttonStyle(CoPressStyle())
            .accessibilityLabel("Send")
        }
    }

    @ViewBuilder
    private var recordingFace: some View {
        Button { recorder.cancel() } label: {
            disc("xmark", fill: CoColor.accentSecondary.color, tint: CoColor.textPrimary.color)
        }
        .buttonStyle(CoPressStyle())
        .accessibilityLabel("Discard recording")

        CoLevelTrail(levels: recorder.levels, isPaused: recorder.isPaused)

        // Stop ends the take and starts reading it; mic resumes a paused one.
        Button {
            if recorder.isPaused { recorder.resume() } else { Task { await transcribe() } }
        } label: {
            disc(recorder.isPaused ? "mic.fill" : "square.fill",
                 fill: CoColor.accentSecondary.color, tint: CoColor.textPrimary.color)
        }
        .buttonStyle(CoPressStyle())
        .accessibilityLabel(recorder.isPaused ? "Resume recording" : "Stop and transcribe")

        Button { Task { await transcribe() } } label: {
            disc("arrow.up", fill: CoColor.action.color, tint: CoColor.textOnAccent.color)
        }
        .buttonStyle(CoPressStyle())
        .accessibilityLabel("Send voice message")
    }

    @ViewBuilder
    private var transcribingFace: some View {
        Button { recorder.cancel() } label: {
            disc("xmark", fill: CoColor.accentSecondary.color, tint: CoColor.textPrimary.color)
        }
        .buttonStyle(CoPressStyle())
        .accessibilityLabel("Discard recording")

        Text("Transcribing")
            .font(CoType.style(.body))
            .foregroundStyle(CoColor.textSecondary.color)
            .frame(maxWidth: .infinity)

        CoSpinner()
            .frame(width: CoControl.barDisc, height: CoControl.barDisc)
            .background(Circle().fill(CoColor.accentSecondary.color))

        disc("arrow.up", fill: CoColor.borderStrong.color, tint: CoColor.claritySurface.color)
            .accessibilityHidden(true)
    }

    private static let attachRowHeight: CGFloat = CoSpacing.touchTarget + 8
    private static let attachPanelHeight: CGFloat = attachRowHeight * 3 + CoSpacing.s * 2

    private var attachPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            attachRow("camera", "Camera") { showCamera = true }
            attachRow("photo", "Photos") { showPhotos = true }
            attachRow("paperclip", "Files") { showFiles = true }
        }
        .padding(CoSpacing.s)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: CoRadius.sheet, style: .continuous))
    }

    private func attachRow(_ symbol: String, _ label: String,
                           action: @escaping () -> Void) -> some View {
        Button {
            closeAttach()
            action()
        } label: {
            HStack(spacing: CoSpacing.m) {
                Image(systemName: symbol)
                    .font(.system(size: CoControl.barIcon + 1, weight: .regular))
                    .foregroundStyle(CoColor.textPrimary.color)
                    .frame(width: CoSpacing.touchTarget - 8, height: CoSpacing.touchTarget - 8)
                    .background(Circle().fill(CoColor.accentSecondary.color))
                Text(label)
                    .font(CoType.style(.body))
                    .foregroundStyle(CoColor.textPrimary.color)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, CoSpacing.s)
            .frame(width: 196, height: Self.attachRowHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(CoPressStyle())
    }

    private func closeAttach() {
        withAnimation(CoMotion.morph) { showAttach = false }
    }

    private func startRecording() async {
        focused = false
        guard await recorder.start() else { return }
    }

    /// Reads the take; if nothing could be transcribed, sends it as a voice message
    /// instead of losing it.
    private func transcribe() async {
        let length = recorder.seconds
        if let text = await recorder.finish() {
            draft = draft.isEmpty ? text : draft + " " + text
            focused = true
        } else {
            onVoiceMessage(length)
        }
    }

    @ViewBuilder
    private var trailingDisc: some View {
        switch trailing {
        case .voice:
            disc("waveform", fill: CoColor.action.color, tint: CoColor.textOnAccent.color)
        case .exit:
            disc("xmark", fill: CoColor.textPrimary.color, tint: CoColor.claritySurface.color)
        }
    }

    private func disc(_ symbol: String, fill: Color, tint: Color) -> some View {
        Image(systemName: symbol)
            .font(.system(size: CoControl.barIcon, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: CoControl.barDisc, height: CoControl.barDisc)
            .background(Circle().fill(fill))
            .contentShape(Circle().inset(by: -CoControl.reach(CoControl.barDisc)))
    }
}

/// SwiftUI has no camera view; falls back to the library on a simulator.
struct CameraCapture: UIViewControllerRepresentable {
    var onCapture: () -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera)
            ? .camera : .photoLibrary
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    @MainActor
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let parent: CameraCapture

        init(_ parent: CameraCapture) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            parent.onCapture()
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

private struct CoThinkingRow: View {
    var body: some View {
        ShimmerLabel(text: "Co is thinking")
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Co is thinking")
    }
}

private struct ShimmerLabel: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sweep: CGFloat = -1

    private var label: some View {
        Text(text).font(CoType.style(.subheadline, .medium))
    }

    var body: some View {
        label
            .foregroundStyle(CoColor.textSecondary.color)
            .overlay {
                GeometryReader { geo in
                    LinearGradient(colors: [.clear, CoColor.textPrimary.color,
                                            CoColor.textPrimary.color, .clear],
                                   startPoint: .leading, endPoint: .trailing)
                        .frame(width: Self.sweepWidth)
                        .offset(x: sweep * (geo.size.width + Self.sweepWidth))
                }
                .mask(label)
                .allowsHitTesting(false)
            }
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.linear(duration: Self.sweepDuration).repeatForever(autoreverses: false)) {
                    sweep = 1
                }
            }
    }

    private static let sweepWidth: CGFloat = 76
    static let sweepDuration: Double = 1.3
}

private struct MessageRow: View {
    let message: ChatStore.Message

    var body: some View {
        if message.isCo {
            Text(message.text)
                .font(CoType.style(.body))
                .foregroundStyle(CoColor.textPrimary.color)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            HStack(spacing: 0) {
                Spacer(minLength: 48)
                Text(message.text)
                    .font(CoType.style(.body))
                    .foregroundStyle(CoColor.textOnAccent.color)
                    .padding(.horizontal, CoSpacing.l)
                    .padding(.vertical, CoSpacing.s + 2)
                    .background(CoColor.action.color,
                                in: RoundedRectangle(cornerRadius: CoRadius.bubble,
                                                     style: .continuous))
            }
        }
    }
}
