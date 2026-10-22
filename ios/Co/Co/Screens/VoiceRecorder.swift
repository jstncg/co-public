import AVFoundation
import Speech
import SwiftUI

// The composer's other face: hold the mic and the pill becomes ChatGPT's dictation bar
// (Justin, 2026-08-04) — the metering is real, not a timer-driven fake.

/// The mic, its level trail, and the clock — the take's temp file is deleted the instant it ends.
@Observable
@MainActor
final class VoiceRecorder {
    /// The take's whole life — nothing else in the composer needs more than which of these four it's in.
    enum Phase {
        case idle, recording, paused, transcribing
    }

    /// One sample per tick, newest LAST. The bar draws the tail that fits.
    private(set) var levels: [CGFloat] = []
    private(set) var seconds: Double = 0
    /// Dev/screenshot hook (same family as `-coChatSeed`): simctl can't drive a mic tap or permission grant.
    private(set) var phase: Phase = {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-coTranscribing") { return .transcribing }
        return args.contains("-coRecording") ? .recording : .idle
    }()

    /// Up for everything but idle — the take isn't finished until there are words.
    var isActive: Bool { phase != .idle }
    var isPaused: Bool { phase == .paused }
    var isTranscribing: Bool { phase == .transcribing }

    /// 20Hz — fast enough speech reads as motion, slow enough the dots interpolate instead of strobe.
    static let tick: Double = 0.05
    /// How many dots the trail holds — ~2s of history, enough to reach both ends of the bar.
    static let capacity = 42

    private var recorder: AVAudioRecorder?
    private var meterTask: Task<Void, Never>?

    /// False means the mic never opened (permission refused or no input) — caller stays on the text composer.
    func start() async -> Bool {
        guard await AVAudioApplication.requestRecordPermission() else { return false }
        do {
            try AVAudioSession.sharedInstance().setCategory(.record, mode: .measurement)
            try AVAudioSession.sharedInstance().setActive(true)
            let take = try AVAudioRecorder(url: Self.scratchFile, settings: [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
            ])
            take.isMeteringEnabled = true
            guard take.record() else { return false }
            recorder = take
        } catch {
            return false
        }
        levels = []
        seconds = 0
        phase = .recording
        meterTask = Task { await self.meter() }
        return true
    }

    func resume() {
        recorder?.record()
        phase = .recording
    }

    /// nil means nothing to transcribe (no permission, no recognizer, or silence) — caller falls
    /// back to sending the take as a voice message.
    func finish() async -> String? {
        guard let recorder else { return nil }
        let url = recorder.url
        endSession()
        phase = .transcribing
        defer {
            phase = .idle
            try? FileManager.default.removeItem(at: url)
        }
        guard let text = await Self.transcript(of: url),
              !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return text
    }

    /// Throws the take away without reading it.
    func cancel() {
        let url = recorder?.url
        endSession()
        if let url { try? FileManager.default.removeItem(at: url) }
        phase = .idle
        seconds = 0
    }

    /// Stops the hardware and the meter but leaves the file alone — `finish` still needs it.
    private func endSession() {
        meterTask?.cancel()
        meterTask = nil
        recorder?.stop()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        levels = []
    }

    /// `nonisolated` is load-bearing, not tidiness (Justin, 2026-08-04 — this crashed): Speech
    /// calls these handlers off the main actor, and a @MainActor closure traps on arrival.
    nonisolated private static func transcript(of url: URL) async -> String? {
        guard await canTranscribe(),
              let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else { return nil }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        let once = ResumeOnce()
        return await withCheckedContinuation { continuation in
            recognizer.recognitionTask(with: request) { result, _ in
                // Partials arrive until one is final (or a failure arrives with none) — hands back exactly one answer.
                guard result?.isFinal ?? true, once.claim() else { return }
                continuation.resume(returning: result?.bestTranscription.formattedString)
            }
        }
    }

    nonisolated private static func canTranscribe() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }

    private func meter() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(Self.tick))
            // Paused holds the trail exactly where it stopped — the frozen tail IS the feedback the mic is off.
            guard let recorder, recorder.isRecording else { continue }
            recorder.updateMeters()
            // PEAK, not average (Justin, 2026-08-04) — averaging flattens exactly the transients that
            // make a voice look like a voice.
            levels.append(Self.level(fromDecibels: recorder.peakPower(forChannel: 0)))
            if levels.count > Self.capacity { levels.removeFirst(levels.count - Self.capacity) }
            seconds = recorder.currentTime
        }
    }

    private static let scratchFile = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("co-take.m4a")

    /// dBFS window is −42 (silence) to 0 (loudest); the <1 exponent expands the quiet end where
    /// conversational distance lives (−50/1.4 barely moved — Justin, 2026-08-04).
    static func level(fromDecibels decibels: Float) -> CGFloat {
        let floor: Float = -42
        let clamped = min(0, max(floor, decibels))
        return CGFloat(pow((clamped - floor) / -floor, 0.75))
    }

    /// m:ss, always two digits of seconds — a voice note's length, not a duration string.
    static func clock(_ seconds: Double) -> String {
        let whole = Int(seconds.rounded(.down))
        return String(format: "%d:%02d", whole / 60, whole % 60)
    }
}

/// Handler can fire more than once, from more than one queue — resuming a continuation twice is a crash.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !claimed else { return false }
        claimed = true
        return true
    }
}

/// The mic as a dictation control, filled blue while listening and a plain glyph at rest —
/// a colored disc in a search field reads as a button you must press (Justin, 2026-08-04).
struct CoDictationButton: View {
    @Binding var text: String
    /// Called before recording, so the field can take focus and show what arrives.
    var onStart: () -> Void = {}

    @State private var recorder = VoiceRecorder()

    var body: some View {
        Button {
            switch recorder.phase {
            case .idle: Task { await listen() }
            case .recording, .paused: Task { await stop() }
            case .transcribing: break
            }
        } label: {
            switch recorder.phase {
            case .transcribing:
                CoSpinner(size: CoControl.barIcon, tint: CoColor.textSecondary.color)
                    .frame(width: CoControl.barGlyph, height: CoControl.barGlyph)
            case .recording, .paused:
                Image(systemName: "mic.fill")
                    .font(.system(size: CoControl.barIcon - 2, weight: .semibold))
                    .foregroundStyle(CoColor.textOnAccent.color)
                    .frame(width: CoControl.barGlyph, height: CoControl.barGlyph)
                    .background(Circle().fill(CoColor.action.color))
            case .idle:
                Image(systemName: "mic.fill")
                    .font(.system(size: CoControl.barIcon + 1, weight: .regular))
                    .foregroundStyle(CoColor.textSecondary.color)
                    .frame(width: CoControl.barGlyph, height: CoControl.barGlyph)
            }
        }
        .buttonStyle(CoPressStyle())
        .contentShape(Circle().inset(by: -CoControl.reach(CoControl.barGlyph)))
        .animation(CoMotion.morph, value: recorder.phase)
        .accessibilityLabel(recorder.isActive ? "Stop dictation" : "Dictate")
    }

    private func listen() async {
        onStart()
        _ = await recorder.start()
    }

    private func stop() async {
        guard let spoken = await recorder.finish() else { return }
        text = text.isEmpty ? spoken : text + " " + spoken
    }
}

/// Not the system pinwheel — a spoked wheel from a different platform decade (Justin, 2026-08-04).
/// Linear speed: a spinner never arrives, so easing is wrong here.
struct CoSpinner: View {
    var size: CGFloat = 16
    var lineWidth: CGFloat = 2
    var tint: Color = CoColor.textSecondary.color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var turning = false

    var body: some View {
        Circle()
            .trim(from: 0, to: 0.28)
            .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
            .frame(width: size, height: size)
            .rotationEffect(.degrees(turning ? 360 : 0))
            .animation(reduceMotion ? nil :
                .linear(duration: 0.85).repeatForever(autoreverses: false), value: turning)
            .onAppear { turning = true }
            .accessibilityHidden(true)
    }
}

/// Two channels, not one: opacity says "sound is happening", height says how loud
/// (Justin, 2026-08-04) — newest sample at the right, scrolling left as it grows.
struct CoLevelTrail: View {
    let levels: [CGFloat]
    let isPaused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The tallest a peak gets — sized to the pill, not the loudest sound, so it can't outgrow its container.
    private static let peakHeight: CGFloat = 26

    var body: some View {
        // Decorative geometry, off the 4-base ladder on purpose: this gap scales with the
        // meter, not with the page.
        HStack(spacing: 2.2) {  // design: DESIGN_SYSTEM.md §0.4
            ForEach(0..<VoiceRecorder.capacity, id: \.self) { slot in
                let level = level(at: slot)
                Capsule()
                    .fill(CoColor.textPrimary.color)
                    .frame(width: 3, height: 3 + (reduceMotion ? 0 : level * Self.peakHeight))
                    .opacity(0.16 + 0.74 * level)
                    // Tweens between 20Hz samples so the trail breathes instead of stepping (linear: continuous motion).
                    .animation(.linear(duration: VoiceRecorder.tick), value: level)
            }
        }
        // Fixed height so a loud moment grows the bars, never the pill around them.
        .frame(maxWidth: .infinity, minHeight: Self.peakHeight + 3)
        .opacity(isPaused ? 0.45 : 1)
        .animation(CoMotion.fast, value: isPaused)
        .accessibilityLabel(isPaused ? "Recording paused" : "Recording")
    }

    /// Right-aligned: slot `capacity - 1` is always newest; slots the take hasn't reached sit at the floor.
    private func level(at slot: Int) -> CGFloat {
        let index = slot - (VoiceRecorder.capacity - levels.count)
        return levels.indices.contains(index) ? levels[index] : 0
    }
}
