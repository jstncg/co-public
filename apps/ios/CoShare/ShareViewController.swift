// ShareViewController.swift — the core habit surface (goal.md §10.2)
//
// contract:
//   1. read what the host app ACTUALLY supplied (url / text / image / movie)
//   2. queue it in the app-group outbox immediately — capture is never at risk
//   3. only then show the one lightweight why question
//   4. complete fast; the app uploads later; NO model inference in here
//
// the extension never claims access to media the host app did not provide:
// coverage is recorded honestly and url-only shares say so to the user.

import UIKit
import SwiftUI
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {

    private let outbox = try? Outbox()
    private var queuedItemID: String?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.980, green: 0.973, blue: 0.957, alpha: 1)
        Task { await ingestAndQueue() }
    }

    // MARK: 1+2 — collect providers, queue immediately

    private func ingestAndQueue() async {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem])?
            .flatMap { $0.attachments ?? [] } ?? []

        var url: URL?
        var text: String?
        var imageData: Data?
        var hasMovie = false

        for provider in providers {
            if url == nil, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                if let data = await loadData(provider, type: UTType.url) {
                    url = URL(dataRepresentation: data, relativeTo: nil)
                }
            } else if text == nil, provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                if let data = await loadData(provider, type: UTType.plainText) {
                    text = String(data: data, encoding: .utf8)
                }
            } else if imageData == nil, provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                imageData = await loadData(provider, type: UTType.image)
            } else if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                // host supplied an actual video file — rare but supported
                hasMovie = true
            }
        }

        // honest coverage (goal.md §27.2)
        let coverage: Coverage
        let sourceType: SourceType
        if hasMovie {
            coverage = .fullMedia
            sourceType = .shortVideo
        } else if imageData != nil {
            coverage = .image
            sourceType = url == nil ? .image : .socialPost
        } else if text != nil {
            coverage = .text
            sourceType = url == nil ? .text : .socialPost
        } else if url != nil {
            coverage = .urlOnly
            sourceType = .url
        } else {
            coverage = .unavailable
            sourceType = .other
        }

        var payload = CapturePayload(sourceType: sourceType, coverage: coverage, url: url, text: text)
        if let imageData, let outbox,
           let name = try? outbox.storeAttachment(imageData, fileExtension: "jpg") {
            payload.attachmentFilenames = [name]
        }

        guard let outbox, let itemID = try? outbox.enqueue(payload) else {
            finish() // nothing we can do; never trap the user in the sheet
            return
        }
        queuedItemID = itemID

        // MARK: 3 — the why question, only after the item is safe
        presentWhyQuestion(coverage: coverage)
    }

    private func loadData(_ provider: NSItemProvider, type: UTType) async -> Data? {
        await withCheckedContinuation { (continuation: CheckedContinuation<Data?, Never>) in
            _ = provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
                continuation.resume(returning: data)
            }
        }
    }

    // MARK: why question ui

    private func presentWhyQuestion(coverage: Coverage) {
        let questionView = ShareWhyView(
            coverageLine: coverage.honestLine,
            onAnswer: { [weak self] answer in
                if let self, let id = self.queuedItemID {
                    try? self.outbox?.attachWhy(itemID: id, answer: answer)
                }
                self?.finish()
            },
            onSaveQuietly: { [weak self] in self?.finish() }
        )
        let host = UIHostingController(rootView: questionView)
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.view.backgroundColor = .clear
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}

// MARK: - minimal swiftui why sheet (no model inference, completes fast)

private struct ShareWhyView: View {
    /// honest line for url-only / unavailable coverage (goal.md §11)
    let coverageLine: String?
    let onAnswer: (String) -> Void
    let onSaveQuietly: () -> Void

    private let paper = Color(red: 0.980, green: 0.973, blue: 0.957)
    private let ink = Color(red: 0.110, green: 0.102, blue: 0.090)
    private let inkSoft = Color(red: 0.420, green: 0.400, blue: 0.368)

    /// general why-tap set (goal.md §11); the honest url-only variant asks
    /// "what caught you?" because co cannot see inside the link.
    private let options = [
        "i want this", "this feels like me", "i want to understand it",
        "keep me posted", "just saving",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("saved.")
                .font(.footnote)
                .foregroundStyle(inkSoft)

            Text(coverageLine ?? "what made you keep this?")
                .font(.system(.title3, design: .serif, weight: .semibold))
                .foregroundStyle(ink)

            ForEach(options, id: \.self) { option in
                Button {
                    onAnswer(option)
                } label: {
                    Text(option)
                        .font(.body)
                        .foregroundStyle(ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(.white.opacity(0.7), in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
            }

            Button("save quietly", action: onSaveQuietly)
                .font(.footnote)
                .foregroundStyle(inkSoft)
                .padding(.top, 4)

            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(paper)
    }
}
