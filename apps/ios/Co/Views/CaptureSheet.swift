// CaptureSheet.swift — quick thought capture (goal.md §10.3)
// large voice button · text field · optional camera / selected photos.
// deliberately NO blank "ask anything" box.
// the why question appears only AFTER the item is safely queued (§10.2/§11).

import SwiftUI
import PhotosUI
import AVFoundation

struct CaptureSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.dismiss) private var dismiss

    @State private var recorder = VoiceRecorder()
    @State private var text = ""
    @State private var photoItem: PhotosPickerItem?
    @State private var photoData: Data?
    @State private var cameraImage: UIImage?
    @State private var showCamera = false

    /// set once the capture is queued; drives the why-tap step
    @State private var queuedItemID: String?
    @State private var queuedWasVoice = false

    var body: some View {
        NavigationStack {
            Group {
                if queuedItemID != nil {
                    WhyTapView(
                        prompt: "what made you keep this?",
                        options: whyOptions,
                        onAnswer: { answer in finishWhy(answer) },
                        onSaveQuietly: { finishWhy(nil) }
                    )
                } else {
                    captureForm
                }
            }
            .background(CoTheme.paper)
            .navigationTitle("catch something")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    /// general why-tap (goal.md §11 "dynamic why-tap", general set)
    private var whyOptions: [String] {
        ["i want this", "this feels like me", "i want to understand it", "keep me posted", "just saving"]
    }

    // MARK: form

    private var captureForm: some View {
        VStack(spacing: CoTheme.Space.l) {
            Spacer(minLength: CoTheme.Space.s)

            // large voice button — the primary gesture
            Button {
                Task { await toggleRecording() }
            } label: {
                VStack(spacing: CoTheme.Space.s) {
                    Image(systemName: recorder.isRecording ? "stop.fill" : "waveform")
                        .font(.system(size: 34, weight: .medium))
                    Text(recorder.isRecording ? "listening… tap to stop" : "say it")
                        .font(CoTheme.caption())
                }
                .foregroundStyle(CoTheme.paper)
                .frame(width: 132, height: 132)
                .background(recorder.isRecording ? CoTheme.ink : CoTheme.clay, in: Circle())
            }
            .buttonStyle(.plain)

            if let denied = recorder.permissionNote {
                Text(denied)
                    .font(CoTheme.caption())
                    .foregroundStyle(CoTheme.inkSoft)
            }

            TextField("or type the thought", text: $text, axis: .vertical)
                .lineLimit(3...6)
                .padding(CoTheme.Space.m)
                .background(CoTheme.card, in: RoundedRectangle(cornerRadius: CoTheme.cornerRadius))
                .overlay(
                    RoundedRectangle(cornerRadius: CoTheme.cornerRadius)
                        .strokeBorder(CoTheme.hairline, lineWidth: 1)
                )

            HStack(spacing: CoTheme.Space.m) {
                // selected media only — never a full library grab (§25.2)
                PhotosPicker(selection: $photoItem, matching: .images) {
                    Label("photo", systemImage: "photo.on.rectangle")
                        .font(CoTheme.caption())
                }
                Button {
                    showCamera = true
                } label: {
                    Label("camera", systemImage: "camera")
                        .font(CoTheme.caption())
                }
                if photoData != nil || cameraImage != nil {
                    Label("1 attached", systemImage: "paperclip")
                        .font(CoTheme.caption())
                        .foregroundStyle(CoTheme.inkSoft)
                }
            }
            .foregroundStyle(CoTheme.ink)

            Spacer()

            CoActionButton(label: "keep it", prominent: true) {
                Task { await queueCapture() }
            }
            .disabled(!hasContent)
            .opacity(hasContent ? 1 : 0.4)
        }
        .padding(CoTheme.Space.l)
        .onChange(of: photoItem) { _, newItem in
            Task {
                photoData = try? await newItem?.loadTransferable(type: Data.self)
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker(image: $cameraImage)
                .ignoresSafeArea()
        }
    }

    private var hasContent: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || photoData != nil || cameraImage != nil || recorder.finishedFileURL != nil
    }

    // MARK: actions

    private func toggleRecording() async {
        if recorder.isRecording {
            recorder.stop()
        } else {
            await recorder.start()
        }
    }

    private func queueCapture() async {
        if recorder.isRecording { recorder.stop() }

        var payload: CapturePayload
        if let voiceURL = recorder.finishedFileURL {
            // voice: transcript happens server-side; raw audio deleted after
            // transcription by default (§11 voice handling)
            queuedWasVoice = true
            payload = CapturePayload(sourceType: .voice, coverage: .fullMedia)
            if let data = try? Data(contentsOf: voiceURL),
               let name = try? model.outbox?.storeAttachment(data, fileExtension: "m4a") {
                payload.attachmentFilenames = [name]
            }
            recorder.discardLocalFile()
        } else if let imageData = cameraImage?.jpegData(compressionQuality: 0.85) ?? photoData {
            payload = CapturePayload(sourceType: .image, coverage: .image)
            if let name = try? model.outbox?.storeAttachment(imageData, fileExtension: "jpg") {
                payload.attachmentFilenames = [name]
            }
            let note = text.trimmingCharacters(in: .whitespacesAndNewlines)
            payload.userNote = note.isEmpty ? nil : note
        } else {
            payload = CapturePayload(sourceType: .text, coverage: .text, text: text)
        }

        queuedItemID = await model.capture(payload)
        if queuedItemID == nil {
            // outbox unavailable — say so instead of silently dropping
            toasts.show("couldn't queue this. try again.")
        }
    }

    private func finishWhy(_ answer: String?) {
        if let answer, let id = queuedItemID {
            try? model.outbox?.attachWhy(itemID: id, answer: answer)
        }
        toasts.show(queuedWasVoice ? "kept. transcribing next sync." : "kept.")
        dismiss()
    }
}

// MARK: - why-tap (asked after queuing; never a capture tax)

struct WhyTapView: View {
    let prompt: String
    let options: [String]
    let onAnswer: (String) -> Void
    let onSaveQuietly: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.m) {
            Text("saved.")
                .font(CoTheme.caption())
                .foregroundStyle(CoTheme.inkSoft)

            Text(prompt)
                .font(CoTheme.title())
                .foregroundStyle(CoTheme.ink)

            ForEach(options, id: \.self) { option in
                Button {
                    onAnswer(option)
                } label: {
                    Text(option)
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

            Button("save quietly", action: onSaveQuietly)
                .font(CoTheme.caption())
                .foregroundStyle(CoTheme.inkSoft)
                .padding(.top, CoTheme.Space.s)
        }
        .padding(CoTheme.Space.l)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - voice recorder scaffold (AVFoundation)

@Observable
@MainActor
final class VoiceRecorder {
    private var recorder: AVAudioRecorder?
    var isRecording = false
    var finishedFileURL: URL?
    var permissionNote: String?

    func start() async {
        guard await AVAudioApplication.requestRecordPermission() else {
            permissionNote = "mic is off for co. enable it in settings if you want voice notes."
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default)
            try session.setActive(true)

            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("co-voice-\(UUID().uuidString).m4a")
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ]
            recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder?.record()
            isRecording = true
            finishedFileURL = nil
        } catch {
            permissionNote = "couldn't start recording."
        }
    }

    func stop() {
        recorder?.stop()
        finishedFileURL = recorder?.url
        recorder = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    /// raw audio is deleted locally once handed to the outbox (default retention)
    func discardLocalFile() {
        if let url = finishedFileURL {
            try? FileManager.default.removeItem(at: url)
        }
        finishedFileURL = nil
    }
}

// MARK: - camera (optional, §10.3)

struct CameraPicker: UIViewControllerRepresentable {
    @Binding var image: UIImage?
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            parent.image = info[.originalImage] as? UIImage
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

#Preview {
    CaptureSheet()
        .environment(previewModel())
        .environment(ToastCenter())
}
