// LivedView.swift — what actually changed in your week, and whether it belonged.
//
// The rest of this app is accumulation (catches) or conclusion (me · rooms · you should
// know). This is the only surface that shows CONSEQUENCE: something you sent became one
// small reversible change in your actual life, and you get the last word on it.
//
// Deliberately not a list of everything co is carrying — matters stay internal
// (the-architecture.md). At most three live changes and one open proposal. If this ever
// looks like a project board, it is wrong.
//
// Three things every card must show, always, in this order:
//   1. the change      — what is in your week
//   2. because         — YOUR words that justified it, so a wrong read is catchable
//   3. the undo        — always available, one tap, no negotiation
//
// The verdict is the endorsement the outcome contract requires: co can never mark its own
// work successful (lived.py LAW 4).

import SwiftUI

// MARK: - the section (lives at the top of today)

struct LivedSection: View {
    @Environment(AppModel.self) private var model
    @State private var verdictFor: LivedTest?
    @State private var busyID: String?

    var body: some View {
        if !model.lived.isEmpty {
            VStack(alignment: .leading, spacing: CoTheme.Space.m) {
                HStack(alignment: .firstTextBaseline) {
                    Text("in your week")
                        .font(.system(size: 12, weight: .bold))
                        .kerning(1.1)
                        .foregroundStyle(CoTheme.inkSoft)
                    Spacer()
                    if model.lived.endorsed > 0 {
                        // the quiet proof it has been real before — never a streak, never a score
                        Text("\(model.lived.endorsed) of \(model.lived.settled) were worth it")
                            .font(.system(size: 11))
                            .foregroundStyle(CoTheme.inkSoft)
                    }
                }

                ForEach(model.lived.live) { t in
                    LivedCard(test: t, busy: busyID == t.id,
                              onUndo: { await act(t.id) { try await model.api.reverseLived(t.id) } },
                              onVerdict: { verdictFor = t })
                }

                ForEach(model.lived.proposed) { t in
                    ProposalCard(test: t, busy: busyID == t.id,
                                 onAccept: { await act(t.id) { try await model.api.acceptLived(t.id) } },
                                 onDecline: { await act(t.id) { try await model.api.declineLived(t.id) } })
                }
            }
            .sheet(item: $verdictFor) { t in
                VerdictSheet(test: t) { value, words in
                    await act(t.id) { try await model.api.verdictLived(t.id, value: value, words: words) }
                    verdictFor = nil
                }
            }
        }
    }

    private func act(_ id: String, _ work: @escaping () async throws -> Void) async {
        busyID = id
        defer { busyID = nil }
        do {
            try await work()
            await model.refreshLived()
        } catch {
            model.toasts.show("didn't go through — still yours to undo")
        }
    }
}

// MARK: - a live change

private struct LivedCard: View {
    let test: LivedTest
    let busy: Bool
    let onUndo: () async -> Void
    let onVerdict: () -> Void

    /// co asks for the verdict after a few days — before that, the change just lives.
    private var verdictDue: Bool { test.days >= 3 }

    var body: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.s) {
            HStack(spacing: 6) {
                Circle().fill(CoTheme.accentMake).frame(width: 6, height: 6)
                Text(test.days == 0 ? "since today" : "day \(test.days)")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(CoTheme.inkSoft)
            }

            Text(test.change)
                .font(CoTheme.title())
                .foregroundStyle(CoTheme.ink)
                .fixedSize(horizontal: false, vertical: true)

            // provenance, in the open: their own words, so a wrong read is catchable
            Text("because you said “\(test.because)”")
                .font(CoTheme.caption())
                .foregroundStyle(CoTheme.inkSoft)
                .fixedSize(horizontal: false, vertical: true)

            if verdictDue {
                Text(test.question)
                    .font(CoTheme.caption().italic())
                    .foregroundStyle(CoTheme.inkSoft)
                    .padding(.top, 2)
            }

            // The undo is never truncated and never buried: it is the sentence that makes
            // this reversible, and a promise you can't finish reading isn't one.
            VStack(alignment: .leading, spacing: CoTheme.Space.s) {
                if verdictDue {
                    Button(action: onVerdict) {
                        Text("did this belong?")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(CoTheme.paper)
                            .padding(.horizontal, CoTheme.Space.m)
                            .padding(.vertical, CoTheme.Space.s)
                            .background(Capsule().fill(CoTheme.clay))
                    }
                    .buttonStyle(.plain)
                }
                Button { Task { await onUndo() } } label: {
                    Text(test.undo)
                        .font(.system(size: 13))
                        .foregroundStyle(CoTheme.inkSoft)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, CoTheme.Space.m)
                        .padding(.vertical, CoTheme.Space.s)
                        .background(RoundedRectangle(cornerRadius: 18).stroke(CoTheme.hairline, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            .padding(.top, CoTheme.Space.xs)
            .opacity(busy ? 0.4 : 1)
            .disabled(busy)
        }
        .padding(CoTheme.Space.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: CoTheme.cornerRadius).fill(CoTheme.card))
        .overlay(RoundedRectangle(cornerRadius: CoTheme.cornerRadius).stroke(CoTheme.hairline, lineWidth: 1))
    }
}

// MARK: - a proposal (co asked; only you install it)

private struct ProposalCard: View {
    let test: LivedTest
    let busy: Bool
    let onAccept: () async -> Void
    let onDecline: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.s) {
            Text("from \(test.resonance)")
                .font(.system(size: 11, weight: .semibold))
                .kerning(0.6)
                .foregroundStyle(CoTheme.accentWorld)

            Text(test.change)
                .font(CoTheme.title())
                .foregroundStyle(CoTheme.ink)
                .fixedSize(horizontal: false, vertical: true)

            // the SPECIFIC quality — never "you love pottery", always the narrow read
            Text(test.quality)
                .font(CoTheme.body())
                .foregroundStyle(CoTheme.inkSoft)
                .fixedSize(horizontal: false, vertical: true)

            Text("because you said “\(test.because)”")
                .font(CoTheme.caption())
                .foregroundStyle(CoTheme.inkSoft)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: CoTheme.Space.s) {
                Button { Task { await onAccept() } } label: {
                    Text("do it")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(CoTheme.paper)
                        .padding(.horizontal, CoTheme.Space.l)
                        .padding(.vertical, CoTheme.Space.s)
                        .background(Capsule().fill(CoTheme.ink))
                }
                .buttonStyle(.plain)
                Button { Task { await onDecline() } } label: {
                    Text("not this")
                        .font(.system(size: 13))
                        .foregroundStyle(CoTheme.inkSoft)
                        .padding(.horizontal, CoTheme.Space.m)
                        .padding(.vertical, CoTheme.Space.s)
                        .background(Capsule().stroke(CoTheme.hairline, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            .padding(.top, CoTheme.Space.xs)
            .opacity(busy ? 0.4 : 1)
            .disabled(busy)

            Text(test.undo)
                .font(.system(size: 11))
                .foregroundStyle(CoTheme.inkSoft)
        }
        .padding(CoTheme.Space.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: CoTheme.cornerRadius).fill(CoTheme.card))
        .overlay(RoundedRectangle(cornerRadius: CoTheme.cornerRadius)
            .stroke(CoTheme.accentWorld.opacity(0.35), lineWidth: 1))
    }
}

// MARK: - the verdict (the member closes it; co never can)

private struct VerdictSheet: View {
    let test: LivedTest
    let submit: (LivedVerdict, String) async -> Void

    @State private var words = ""
    @State private var sending = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: CoTheme.Space.l) {
                VStack(alignment: .leading, spacing: CoTheme.Space.s) {
                    Text(test.change)
                        .font(CoTheme.title())
                        .foregroundStyle(CoTheme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(test.question)
                        .font(CoTheme.body())
                        .foregroundStyle(CoTheme.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(spacing: CoTheme.Space.s) {
                    ForEach(LivedVerdict.allCases, id: \.self) { v in
                        Button { Task { sending = true; await submit(v, words) } } label: {
                            HStack {
                                Text(v.label)
                                    .font(CoTheme.headline())
                                    .foregroundStyle(CoTheme.ink)
                                Spacer()
                            }
                            .padding(CoTheme.Space.m)
                            .background(RoundedRectangle(cornerRadius: 14).fill(CoTheme.card))
                            .overlay(RoundedRectangle(cornerRadius: 14).stroke(CoTheme.hairline, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .disabled(sending)
                .opacity(sending ? 0.4 : 1)

                TextField("anything you want to add", text: $words, axis: .vertical)
                    .font(CoTheme.body())
                    .lineLimit(1...3)
                    .padding(CoTheme.Space.m)
                    .background(RoundedRectangle(cornerRadius: 14).fill(CoTheme.mediaWash))

                Spacer()
            }
            .padding(CoTheme.Space.m)
            .background(CoTheme.paper)
            .navigationTitle("did this belong?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("later") { dismiss() }.foregroundStyle(CoTheme.inkSoft)
                }
            }
        }
    }
}
