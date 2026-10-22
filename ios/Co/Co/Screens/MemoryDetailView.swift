import SwiftUI

// One saved thing, opened out of a pool: the date beside the ✕ at top, the thing itself
// in the middle, a note under it, trash in the corner. Swipe left/right walks the pool
// without returning to the board.
//
// Opening is the system's zoom. Closing is ours: the drag carries only the card, the rest
// of the screen fades out of its way, and the board eases back into place as it leaves —
// velocity-aware, damped sideways, interruptible (let go early, it springs back).

struct MemoryDetailView: View {
    /// Where the tile sits on the board (window space) — the slot the card shrinks back
    /// into on close. Falls back to a plain dismiss if never measured.
    let focusFrame: CGRect?
    let items: [FeedItem]
    /// A binding so close can aim the shrink at whichever card was paged to, not the one
    /// that was opened.
    @Binding var currentID: String
    /// 0 while the memory owns the screen, 1 once the drag has carried it away — the
    /// board behind reads this to move with the finger.
    @Binding var dismissProgress: CGFloat

    @Environment(FeedStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var drag: CGSize = .zero
    @State private var pinch: CGFloat = 1
    @State private var confirmingDelete = false
    /// Bumped once the server confirms the forget, so the haptic marks the real loss.
    @State private var forgot = 0
    @State private var pagingBack = false
    /// On-screen card frame, so the top row can bow out as the card slides under it.
    @State private var cardFrame: CGRect = .zero
    /// Window-space card frame, in the same space the board's tiles are measured in, so
    /// close can aim at the empty slot.
    @State private var cardGlobal: CGRect = .zero
    @State private var collapseOffset: CGSize = .zero
    @State private var collapseScale: CGFloat = 1

    static let space = "coMemory"

    private static let closeDistance: CGFloat = 140
    private static let closeVelocity: CGFloat = 320
    private static let fadeDistance: CGFloat = 240

    private var progress: CGFloat {
        min(max(drag.height, 0) / Self.fadeDistance, 1)
    }

    /// ONE value drives the whole reveal: white, chrome, note and trash all read
    /// `1 - carried` so they leave and return on exactly the same anchored curve.
    private var carried: CGFloat {
        let t = min(max(dismissProgress, 0), 1)
        return t * t * (3 - 2 * t)
    }

    private var whiteboard: CGFloat { 1 - carried }
    private var chromeOpacity: CGFloat { 1 - carried }

    /// How far the card has slid up under the top row — full conceal once its top has
    /// passed the row's bottom edge.
    private var chromeConceal: CGFloat {
        guard cardFrame != .zero else { return 0 }
        let bandBottom = CoSpacing.touchTarget + CoSpacing.s
        let liveTop = cardFrame.minY
        guard liveTop < bandBottom else { return 0 }
        return min((bandBottom - liveTop) / bandBottom, 1)
    }

    var body: some View {
        ZStack {
            CoColor.appBackground.color
                .opacity(whiteboard)
                .ignoresSafeArea()

            page(for: current)
                // Identity + directional slide: without these SwiftUI crossfades instead
                // of sliding, which also dips through the background (a white flash).
                .id(currentID)
                .transition(.asymmetric(
                    insertion: .move(edge: pagingBack ? .leading : .trailing),
                    removal: .move(edge: pagingBack ? .trailing : .leading)))
        }
        .coordinateSpace(name: Self.space)
        .overlay(alignment: .top) { topRow.opacity(chromeOpacity * (1 - chromeConceal)) }
        // Faded chrome must stop taking taps too — opacity(0) still hit-tests.
        .overlay(alignment: .bottomLeading) {
            viewButton.opacity(chromeOpacity).allowsHitTesting(chromeOpacity > 0)
        }
        .overlay(alignment: .bottomTrailing) { trashButton.opacity(chromeOpacity) }
        .presentationBackground(.clear)
        // The zoom transition's own interactive dismissal drags the whole presentation,
        // not the card — off; closing is the card's drag, the ✕, or nothing.
        .interactiveDismissDisabled()
        .simultaneousGesture(dismissDrag)
        .confirmationDialog("Delete memory?", isPresented: $confirmingDelete,
                            titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                // Server forgets first; only a confirmed forget dismisses.
                let id = currentID
                Task {
                    if await store.forget(id: id) {
                        forgot += 1
                        dismiss()
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        // Losing something is not the same event as opening something, so it does not get
        // the same tap. `.warning`, fired on the CONFIRMED forget, never on the ask.
        .sensoryFeedback(.warning, trigger: forgot)
    }

    // MARK: - Close by hand

    /// Shrinks the card back into the tile it came from rather than jumping: scale to the
    /// slot's size, glide the centers together, fade on the same `dismissProgress` the
    /// board reads. Falls back to a plain dismiss with no measured slot.
    private func closeIntoPlace() {
        guard let slot = focusFrame, slot.width > 0, cardGlobal.width > 0 else {
            dismiss()
            return
        }
        let scale = slot.width / cardGlobal.width
        withAnimation(reduceMotion ? CoMotion.fast : CoMotion.morph) {
            collapseScale = scale
            collapseOffset = CGSize(width: slot.midX - cardGlobal.midX,
                                    height: slot.midY - cardGlobal.midY)
            dismissProgress = 1
        }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(reduceMotion ? 0.22 : 0.4))
            dismiss()
        }
    }

    private var dismissDrag: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                drag = value.translation
                dismissProgress = progress
            }
            .onEnded { value in
                let flick = value.predictedEndTranslation.height - value.translation.height
                let sideways = value.predictedEndTranslation.width

                if abs(value.translation.width) > abs(value.translation.height),
                   abs(sideways) > Self.pageDistance {
                    step(by: sideways < 0 ? 1 : -1)
                    withAnimation(reduceMotion ? CoMotion.fast : CoMotion.morph) {
                        drag = .zero
                        dismissProgress = 0
                    }
                    return
                }

                let gone = value.translation.height > Self.closeDistance
                    || flick > Self.closeVelocity
                if gone, value.translation.height > abs(value.translation.width) {
                    closeIntoPlace()
                } else {
                    withAnimation(reduceMotion ? CoMotion.fast : CoMotion.morph) {
                        drag = .zero
                        dismissProgress = 0
                    }
                }
            }
    }

    private static let pageDistance: CGFloat = 90

    /// Stops at either end rather than wrapping — wrapping loses people with no indicator
    /// here to say where they are.
    private func step(by offset: Int) {
        guard let index = items.firstIndex(where: { $0.id == currentID }) else { return }
        let next = index + offset
        guard items.indices.contains(next) else { return }
        pagingBack = offset < 0
        withAnimation(reduceMotion ? CoMotion.fast : CoMotion.standard) {
            currentID = items[next].id
        }
    }

    // MARK: - Handling the memory itself

    private var pinchToScale: some Gesture {
        MagnifyGesture()
            .onChanged { pinch = min(max($0.magnification, 0.4), 2.5) }
            .onEnded { _ in
                withAnimation(reduceMotion ? CoMotion.fast : CoMotion.morph) { pinch = 1 }
            }
    }

    // MARK: - The page

    private func page(for item: FeedItem) -> some View {
        VStack(spacing: CoSpacing.l) {
            Spacer(minLength: 0)

            ArchiveTile(item: item)
                .fixedSize(horizontal: false, vertical: true)
                .offset(CGSize(width: drag.width + collapseOffset.width,
                               height: drag.height + collapseOffset.height))
                .scaleEffect(pinch * (1 - 0.12 * progress) * collapseScale)
                .onGeometryChange(for: CGRect.self) { proxy in
                    proxy.frame(in: .global)
                } action: { cardGlobal = $0 }
                .onGeometryChange(for: CGRect.self) { proxy in
                    proxy.frame(in: .named(Self.space))
                } action: { cardFrame = $0 }
                .gesture(pinchToScale)

            NoteField(item: item)
                .opacity(chromeOpacity)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, CoSpacing.xl)
        .padding(.vertical, CoSpacing.touchTarget + CoSpacing.l)
    }

    // MARK: - Chrome

    private var topRow: some View {
        ZStack {
            Text(Self.stamp.string(from: current.savedAt))
                .font(CoType.style(.subheadline))
                .foregroundStyle(CoColor.textSecondary.color)
                .lineLimit(1)
                .contentTransition(.numericText(value: current.savedAt.timeIntervalSince1970))

            HStack {
                disc("xmark", label: "Close") { closeIntoPlace() }
                Spacer(minLength: 0)
            }
        }
        .frame(height: CoSpacing.touchTarget)
        .padding(.horizontal, CoSpacing.l)
        .padding(.top, CoSpacing.s)
    }

    /// Hands the URL to the system (YouTube/X/Safari); absent for a thought or photo,
    /// which have no elsewhere to go.
    @ViewBuilder private var viewButton: some View {
        if let url = current.url {
            Link(destination: url) {
                Text("View")
                    .font(CoType.style(.subheadline).weight(.medium))
                    .foregroundStyle(CoColor.textPrimary.color)
                    .frame(height: CoSpacing.touchTarget)
                    .padding(.horizontal, CoSpacing.l)
                    .contentShape(Capsule())
            }
            .buttonStyle(CoPressStyle())
            .glassEffect(.regular.interactive(), in: Capsule())
            .accessibilityLabel("View this at its source")
            .padding(.leading, CoSpacing.l)
            .padding(.bottom, CoSpacing.l)
        }
    }

    private var trashButton: some View {
        disc("trash", label: "Delete memory") { confirmingDelete = true }
            .padding(.trailing, CoSpacing.l)
            .padding(.bottom, CoSpacing.l)
    }

    private var current: FeedItem {
        store.item(id: currentID) ?? items.first { $0.id == currentID } ?? items[0]
    }

    private func disc(_ symbol: String, label: String,
                      action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: CoControl.discIcon, weight: .medium))
                .foregroundStyle(CoColor.textPrimary.color)
                .frame(width: CoSpacing.touchTarget, height: CoSpacing.touchTarget)
                .contentShape(Circle())
        }
        .buttonStyle(CoPressStyle())
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel(label)
    }

    private static let stamp: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()
}

/// Writes straight through to the store on every keystroke — no Save.
private struct NoteField: View {
    let item: FeedItem

    @Environment(FeedStore.self) private var store

    var body: some View {
        TextField("Add a Note...", text: Binding(
            get: { store.item(id: item.id)?.note ?? item.note },
            set: { store.setNote($0, on: item.id) }
        ), axis: .vertical)
            .font(CoType.style(.subheadline))
            .foregroundStyle(CoColor.textPrimary.color)
            .multilineTextAlignment(.center)
            .lineLimit(1...4)
            .textFieldStyle(.plain)
            .padding(.horizontal, CoSpacing.m)
    }
}
