import Foundation
import LiveKit
import SwiftUI

/// Voice mode's state machine — the orb binds to `phase`/`level`; nothing else in the app knows LiveKit
/// exists. Also the room's delegate: Co's words stream live, yours fold in at hangup.
@Observable
@MainActor
final class VoiceSession: RoomDelegate {
    enum Phase: Equatable {
        case idle
        case connecting
        case listening
        case speaking
        case failed(String)
    }

    /// One line of the conversation, either side — same shape as the chat thread's message, so
    /// committing a finished call is a straight mapping.
    struct Line: Identifiable, Equatable {
        let id: UUID
        let isCo: Bool
        /// `var` so a streaming Co line can update in place as more of the sentence arrives.
        var text: String
    }

    private(set) var phase: Phase = .idle
    /// 0…1, drives the orb — real audio level, not a timer pulse (same law VoiceRecorder's trail is built on).
    private(set) var level: CGFloat = 0

    /// The call as text, in order — Co's words stream live, yours land once final; `takeTranscript()`
    /// hands the whole thread to chat at hangup.
    private(set) var transcript: [Line] = []
    /// True from your turn ending (or first word landing) until Co's line finalizes — thread shows a loading row.
    private(set) var coIsGenerating = false
    /// The reply line streaming in, or nil before the first word / after the last. Thinking row is
    /// `coIsGenerating && activeAgentLineID == nil` — shimmer and text never coexist.
    private(set) var activeAgentLineID: UUID?
    /// Maps a segment's string key to its Line's UUID, so a streaming update finds and replaces the right row.
    private var agentIDs: [String: UUID] = [:]

    private let api: CoAPI
    private var room: Room?
    private var levels: Task<Void, Never>?
    /// The in-flight connect attempt, held so `end()`/`start()` can cancel it — otherwise a cancelled
    /// connect kept running and overwrote phase after we'd left.
    private var connectTask: Task<Void, Never>?
    /// Generation token — bumped every call; in-flight work checks it before touching shared state.
    private var generation: UInt = 0
    /// Last room torn down — a re-connect waits on it so two rooms never share the audio session.
    private var teardown: Task<Void, Never>?

    init(api: CoAPI) { self.api = api }

    func start(history: [CoChatMessage] = []) async {
        generation &+= 1
        let gen = generation
        connectTask?.cancel()
        connectTask = nil
        transcript = []
        agentIDs = [:]
        coIsGenerating = false
        activeAgentLineID = nil
        phase = .connecting
        // Serializes with any settling disconnect so the new join doesn't race the old room's teardown.
        if let teardown {
            await teardown.value
            self.teardown = nil
        }
        guard gen == generation else { return }
        let attempt = Task { [weak self] in
            _ = await self?.connect(gen: gen, history: history)
        }
        connectTask = attempt
        await attempt.value
    }

    /// One connect attempt — every suspension is followed by a generation check before mutating shared state.
    private func connect(gen: UInt, history: [CoChatMessage]) async {
        do {
            let config = try await api.voiceSession(history: history)
            try Task.checkCancellation()
            guard gen == generation else { return }
            let room = Room(delegate: self)
            self.room = room
            try await room.connect(url: config.serverUrl, token: config.token)
            try Task.checkCancellation()
            guard gen == generation else {
                Task { await room.disconnect() }
                return
            }
            try await room.localParticipant.setMicrophone(enabled: true)
            try Task.checkCancellation()
            guard gen == generation else {
                Task { await room.disconnect() }
                return
            }
            levels = Task { [weak self] in await self?.pollLevels(room, gen: gen) }
            phase = .listening
        } catch is CancellationError {
            // Superseded by `end()` or a newer `start()` — nothing to surface.
        } catch {
            guard gen == generation else { return }
            phase = .failed(String(describing: error))
        }
    }

    func end() {
        generation &+= 1
        connectTask?.cancel()
        connectTask = nil
        levels?.cancel()
        levels = nil
        let room = self.room
        self.room = nil
        level = 0
        transcript = []
        agentIDs = [:]
        coIsGenerating = false
        activeAgentLineID = nil
        phase = .idle
        teardown = Task { await room?.disconnect() }
    }

    // MARK: - RoomDelegate (lifecycle)

    /// Room dropped on its own (network, duplicate-join kick, agent close) — falls to `.failed`, not a fake-live UI.
    nonisolated func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        Task { @MainActor [weak self] in self?.handleDisconnect(room, error: error) }
    }

    /// Initial join failed at the protocol level (not the HTTP pre-stage, that's `start`'s catch) — same surfacing.
    nonisolated func room(_ room: Room, didFailToConnectWithError error: LiveKitError?) {
        Task { @MainActor [weak self] in
            guard let self, room === self.room else { return }
            self.generation &+= 1
            self.levels?.cancel()
            self.levels = nil
            self.phase = .failed(String(describing: error?.errorDescription ?? "couldn't connect"))
        }
    }

    private func handleDisconnect(_ room: Room, error: LiveKitError?) {
        guard room === self.room else { return }
        generation &+= 1
        levels?.cancel()
        levels = nil
        self.room = nil
        phase = .failed(String(describing: error?.localizedDescription ?? "call dropped"))
    }

    /// Consumes the finished call's full thread (both sides) and clears the session for the next one.
    func takeTranscript() -> [Line] {
        let lines = transcript
        transcript = []
        agentIDs = [:]
        coIsGenerating = false
        activeAgentLineID = nil
        return lines
    }

    // MARK: - RoomDelegate (transcription)

    /// Co's words stream live; yours fold in once final. Guarded to the CURRENT room — a segment from a
    /// superseded room (streaming right after `end()`) must not bleed into the next session's transcript.
    nonisolated func room(_ room: Room, participant: Participant,
                          trackPublication: TrackPublication,
                          didReceiveTranscriptionSegments segments: [TranscriptionSegment]) {
        Task { @MainActor [weak self] in
            guard let self, room === self.room else { return }
            self.handle(segments: segments, from: participant)
        }
    }

    private func handle(segments: [TranscriptionSegment], from participant: Participant) {
        for segment in segments where !segment.text.isEmpty {
            let key = segment.id
            if participant.isAgent {
                if let i = transcript.firstIndex(where: { $0.id == agentIDs[key] }) {
                    // Already in the thread — stream the rest in place; last word landing means the reply is done.
                    transcript[i].text = segment.text
                    if segment.isFinal {
                        coIsGenerating = false
                        activeAgentLineID = nil
                    }
                } else {
                    // First word of a reply — takes the shimmer row's spot; they never share the screen.
                    let line = Line(id: UUID(), isCo: true, text: segment.text)
                    agentIDs[key] = line.id
                    activeAgentLineID = segment.isFinal ? nil : line.id
                    coIsGenerating = !segment.isFinal
                    transcript.append(line)
                }
            } else if segment.isFinal {
                // Your turn ended, so the shimmer starts — any line the agent was still streaming is
                // superseded by the next reply's fresh line.
                coIsGenerating = true
                activeAgentLineID = nil
                let key = "u-\(key)"
                guard !transcript.contains(where: { $0.id == agentIDs[key] }) else { continue }
                let line = Line(id: UUID(), isCo: false, text: segment.text)
                agentIDs[key] = line.id
                transcript.append(line)
            }
        }
    }

    /// 20Hz, matching VoiceRecorder.tick so both voice surfaces breathe together — the agent is the
    /// only remote participant, so the orb shows its voice, not yours.
    private func pollLevels(_ room: Room, gen: UInt) async {
        while !Task.isCancelled && gen == generation {
            try? await Task.sleep(for: .seconds(0.05))
            // `try?` swallows cancellation — re-check both before touching phase, or a dead poller
            // overwrites `end()`'s reset.
            guard !Task.isCancelled, gen == generation else { return }
            let agent = room.remoteParticipants.values.first
            let speaking = agent?.isSpeaking ?? false
            phase = speaking ? .speaking : .listening
            let source: Participant? = speaking ? agent : room.localParticipant
            level = CGFloat(min(1, max(0, source?.audioLevel ?? 0)))
        }
    }
}
