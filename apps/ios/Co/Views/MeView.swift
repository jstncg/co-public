// MeView.swift — tab: me (goal.md §20.4, §13.4) + privacy vault (§20.7)
// a simple inspectable model, not a psychological dashboard.
// every inference is correctable; nothing here is a permanent identity label.

import SwiftUI

struct MeView: View {
    @Environment(AppModel.self) private var model

    @State private var showCorrect = false
    @State private var showVault = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: CoTheme.Space.l) {
                    if !model.me.whatKeepsCatchingYou.isEmpty {
                        VStack(alignment: .leading, spacing: CoTheme.Space.s) {
                            Text("what keeps catching you")
                                .font(CoTheme.caption().weight(.semibold))
                                .foregroundStyle(CoTheme.inkSoft)
                            CoFlow {
                                ForEach(model.me.whatKeepsCatchingYou, id: \.self) { CoTag(text: $0) }
                            }
                        }
                    } else {
                        meSection("what keeps catching you", model.me.whatKeepsCatchingYou)
                    }
                    meSection("things you want more of", model.me.thingsYouWantMoreOf)
                    meSection("standards co is learning", model.me.standardsCoIsLearning)
                    meSection("watching", model.me.watching)
                    meSection("hypotheses co is testing", model.me.hypothesesCoIsTesting)

                    VStack(alignment: .leading, spacing: CoTheme.Space.s) {
                        CoActionButton(label: "correct co") { showCorrect = true }
                        CoActionButton(label: "privacy vault") { showVault = true }
                    }
                    .padding(.top, CoTheme.Space.s)
                }
                .padding(CoTheme.Space.m)
            }
            .background(CoTheme.paper)
            .navigationTitle("me")
            .sheet(isPresented: $showCorrect) { CorrectCoSheet() }
            .sheet(isPresented: $showVault) { PrivacyVaultView() }
        }
    }

    private func meSection(_ title: String, _ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.s) {
            Text(title)
                .font(CoTheme.caption().weight(.semibold))
                .foregroundStyle(CoTheme.inkSoft)
            if items.isEmpty {
                Text("nothing here yet — co only writes what it can back up.")
                    .font(CoTheme.body())
                    .foregroundStyle(CoTheme.inkSoft)
            } else {
                ForEach(items, id: \.self) { item in
                    Text("• \(item)")
                        .font(CoTheme.body())
                        .foregroundStyle(CoTheme.ink)
                }
            }
        }
    }
}

// MARK: - correct co (§13.4: right / partly right / wrong / outdated …)

struct CorrectCoSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.dismiss) private var dismiss

    @State private var selected: String?

    private let verdicts = ["right", "partly right", "wrong", "outdated"]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: CoTheme.Space.m) {
                    Text("pick the line that's off. co updates the model, not you.")
                        .font(CoTheme.caption())
                        .foregroundStyle(CoTheme.inkSoft)

                    ForEach(allInferences, id: \.self) { line in
                        Button {
                            selected = (selected == line) ? nil : line
                        } label: {
                            HStack {
                                Text(line)
                                    .font(CoTheme.body())
                                    .foregroundStyle(CoTheme.ink)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                if selected == line {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(CoTheme.clay)
                                }
                            }
                            .padding(CoTheme.Space.m)
                            .background(CoTheme.card, in: RoundedRectangle(cornerRadius: CoTheme.cornerRadius))
                            .overlay(
                                RoundedRectangle(cornerRadius: CoTheme.cornerRadius)
                                    .strokeBorder(
                                        selected == line ? CoTheme.clay : CoTheme.hairline,
                                        lineWidth: 1
                                    )
                            )
                        }
                        .buttonStyle(.plain)
                    }

                    if selected != nil {
                        HStack(spacing: CoTheme.Space.s) {
                            ForEach(verdicts, id: \.self) { verdict in
                                CoActionButton(label: verdict) {
                                    // demo mode: acknowledged locally; the real
                                    // client writes an annotation (type: correction)
                                    toasts.show("noted: \(verdict). co re-weighs the receipts.")
                                    dismiss()
                                }
                            }
                        }
                    }
                }
                .padding(CoTheme.Space.m)
            }
            .background(CoTheme.paper)
            .navigationTitle("correct co")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("close") { dismiss() }
                }
            }
        }
    }

    private var allInferences: [String] {
        model.me.whatKeepsCatchingYou
            + model.me.thingsYouWantMoreOf
            + model.me.standardsCoIsLearning
            + model.me.hypothesesCoIsTesting
    }
}

// MARK: - privacy vault (§20.7 verbatim structure)

struct PrivacyVaultView: View {
    @Environment(AppModel.self) private var model
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: CoTheme.Space.l) {
                    Text("co sees only what you send or ask it to watch.")
                        .font(CoTheme.body())
                        .foregroundStyle(CoTheme.ink)

                    VStack(spacing: CoTheme.Space.m) {
                        Toggle("shared model training", isOn: $model.privacy.sharedModelTraining)
                        HStack {
                            Toggle("founder review", isOn: $model.privacy.founderReview)
                            Button("manage") { toasts.comingInBeta() }
                                .font(CoTheme.caption())
                                .foregroundStyle(CoTheme.clay)
                        }
                        if model.privacy.founderReview {
                            Text("on until \(model.privacy.founderReviewActiveUntil)")
                                .font(CoTheme.caption())
                                .foregroundStyle(CoTheme.inkSoft)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        Toggle("raw voice retention", isOn: $model.privacy.rawVoiceRetention)
                        HStack {
                            Text("proactive notes")
                            Spacer()
                            Text("\(model.privacy.proactiveNotesPerWeek) / week")
                                .foregroundStyle(CoTheme.inkSoft)
                        }
                        Toggle("world radar", isOn: $model.privacy.worldRadar)
                    }
                    .font(CoTheme.body())
                    .tint(CoTheme.clay)
                    .padding(CoTheme.Space.m)
                    .background(CoTheme.card, in: RoundedRectangle(cornerRadius: CoTheme.cornerRadius))

                    VStack(alignment: .leading, spacing: CoTheme.Space.s) {
                        // export / access log / deletion need the backend —
                        // shown honestly as not-yet instead of pretending
                        CoActionButton(label: "export my co") { toasts.comingInBeta() }
                        CoActionButton(label: "review access log") { toasts.comingInBeta() }
                        CoActionButton(label: "delete selected data") { toasts.comingInBeta() }
                        CoActionButton(label: "delete everything") { toasts.comingInBeta() }
                    }
                }
                .padding(CoTheme.Space.m)
            }
            .background(CoTheme.paper)
            .navigationTitle("privacy vault")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("close") { dismiss() }
                }
            }
        }
    }
}

#Preview {
    MeView()
        .environment(previewModel())
        .environment(ToastCenter())
}
