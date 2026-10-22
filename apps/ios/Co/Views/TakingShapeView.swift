// TakingShapeView.swift — tab: taking shape (goal.md §20.2, detail §20.5)
// pattern cards with receipts and alternatives. the empty state is honest:
// co never invents a pattern to fill the screen.

import SwiftUI

struct TakingShapeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: CoTheme.Space.m) {
                    if !model.me.thingsYouWantMoreOf.isEmpty {
                        CoCard {
                            Text("building toward")
                                .font(CoTheme.caption().weight(.semibold))
                                .foregroundStyle(CoTheme.inkSoft)
                            ForEach(model.me.thingsYouWantMoreOf, id: \.self) { g in
                                Text(g)
                                    .font(.system(.body, design: .default, weight: .semibold))
                                    .foregroundStyle(CoTheme.ink)
                                    .padding(.vertical, 2)
                            }
                        }
                    }
                    if !model.me.watching.isEmpty {
                        CoCard {
                            Text("co is watching")
                                .font(CoTheme.caption().weight(.semibold))
                                .foregroundStyle(CoTheme.inkSoft)
                            ForEach(model.me.watching, id: \.self) { w in
                                Label(w, systemImage: "eye")
                                    .font(CoTheme.body())
                                    .foregroundStyle(CoTheme.ink)
                            }
                        }
                    }
                    if !model.patterns.isEmpty {
                        Text("taking shape")
                            .font(CoTheme.caption().weight(.semibold))
                            .foregroundStyle(CoTheme.inkSoft)
                            .padding(.top, CoTheme.Space.s)
                    }
                    if model.patterns.isEmpty {
                        emptyState
                    } else {
                        ForEach(model.patterns) { pattern in
                            NavigationLink(value: pattern) {
                                PatternRow(pattern: pattern)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(CoTheme.Space.m)
            }
            .background(CoTheme.paper)
            .navigationTitle("plan")
            .navigationDestination(for: PatternCard.self) { pattern in
                PatternDetailView(pattern: pattern)
            }
        }
    }

    /// verbatim empty state (goal.md §20.2)
    private var emptyState: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.m) {
            Text("nothing to show yet — and that's honest.")
                .font(CoTheme.headline())
                .foregroundStyle(CoTheme.ink)
            Text("patterns appear once the same thing catches you in more than one place. co won't invent one to fill the screen, and it'll show you the receipts when it does have one.")
                .font(CoTheme.body())
                .foregroundStyle(CoTheme.inkSoft)
        }
        .padding(.top, CoTheme.Space.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct PatternRow: View {
    let pattern: PatternCard

    var body: some View {
        CoCard {
            Text(pattern.statusLine)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CoTheme.clay)
                .padding(.horizontal, 9)
                .padding(.vertical, 4)
                .background(CoTheme.clay.opacity(0.12), in: Capsule())
            Text(pattern.currentRead)
                .font(.system(.title3, design: .serif, weight: .medium))
                .foregroundStyle(CoTheme.ink)
                .lineSpacing(3)
        }
    }
}

// MARK: - pattern detail (§20.5)

struct PatternDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.dismiss) private var dismiss

    let pattern: PatternCard
    @State private var showReceipts = false

    private var receipts: [Moment] {
        model.catches.filter { pattern.receiptMomentIDs.contains($0.id) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: CoTheme.Space.l) {
                section("co’s current read") {
                    Text(pattern.currentRead)
                        .font(CoTheme.body())
                        .foregroundStyle(CoTheme.ink)
                }

                section("why") {
                    Button {
                        showReceipts.toggle()
                    } label: {
                        Text(showReceipts ? "hide receipts" : "\(pattern.receiptMomentIDs.count) receipts")
                            .font(CoTheme.caption().weight(.medium))
                            .foregroundStyle(CoTheme.clay)
                    }
                    if showReceipts {
                        ForEach(receipts) { moment in
                            MomentCard(moment: moment)
                        }
                    }
                }

                section("other possible explanations") {
                    ForEach(pattern.alternatives, id: \.self) { alt in
                        Text("• \(alt)")
                            .font(CoTheme.body())
                            .foregroundStyle(CoTheme.inkSoft)
                    }
                }

                HStack(spacing: CoTheme.Space.s) {
                    CoActionButton(label: "right") { verdict(.right) }
                    CoActionButton(label: "partly") { verdict(.partly) }
                    CoActionButton(label: "wrong") { verdict(.wrong) }
                    CoActionButton(label: "find a door", prominent: true) {
                        // move planning isn't built yet — never pretend
                        toasts.comingInBeta()
                    }
                }
            }
            .padding(CoTheme.Space.m)
        }
        .background(CoTheme.paper)
        .navigationTitle(pattern.title)
        .navigationBarTitleDisplayMode(.large)
    }

    private func verdict(_ verdict: PatternVerdict) {
        Task {
            try? await model.api.submitPatternVerdict(patternID: pattern.id, verdict: verdict)
            model.patterns = (try? await model.api.fetchPatterns()) ?? model.patterns
            toasts.show(verdict == .wrong ? "noted. co drops the read." : "noted.")
            if verdict == .wrong { dismiss() }
        }
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.s) {
            Text(title)
                .font(CoTheme.caption().weight(.semibold))
                .foregroundStyle(CoTheme.inkSoft)
            content()
        }
    }
}

#Preview {
    TakingShapeView()
        .environment(previewModel())
        .environment(ToastCenter())
}
