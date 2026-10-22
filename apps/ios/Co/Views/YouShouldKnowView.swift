// YouShouldKnowView.swift — tab: you should know (goal.md §20.3, §20.6, §15.7)
// radar cards. "why this reached you" and the source receipt are mandatory.
// the empty state names what co is still watching — no manufactured urgency.

import SwiftUI

struct YouShouldKnowView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: CoTheme.Space.l) {
                    if model.radar.newItems.isEmpty {
                        emptyState
                    } else {
                        newSection
                    }
                    if !model.radar.waiting.isEmpty {
                        waitingSection
                    }
                }
                .padding(CoTheme.Space.m)
            }
            .background(CoTheme.paper)
            .navigationTitle("you should know")
        }
    }

    private var newSection: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.s) {
            Text("new")
                .font(CoTheme.caption())
                .foregroundStyle(CoTheme.inkSoft)
            ForEach(model.radar.newItems) { item in
                RadarCardView(item: item)
            }
        }
    }

    private var waitingSection: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.s) {
            Text("waiting")
                .font(CoTheme.caption())
                .foregroundStyle(CoTheme.inkSoft)
            ForEach(model.radar.waiting, id: \.self) { watch in
                Text("• \(watch)")
                    .font(CoTheme.body())
                    .foregroundStyle(CoTheme.ink)
            }
        }
    }

    /// verbatim empty state (goal.md §20.3)
    private var emptyState: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.m) {
            Text("nothing worth interrupting you for.")
                .font(CoTheme.body())
                .foregroundStyle(CoTheme.ink)
            if !model.radar.watching.isEmpty {
                Text("co is still watching:\n\(model.radar.watching.joined(separator: " · "))")
                    .font(CoTheme.body())
                    .foregroundStyle(CoTheme.inkSoft)
            }
        }
        .padding(.top, CoTheme.Space.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - radar card (§20.6: why + source receipt + open/save/mute)

struct RadarCardView: View {
    @Environment(AppModel.self) private var model
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.openURL) private var openURL

    let item: RadarItem

    var body: some View {
        CoCard {
            Text(item.headline)
                .font(.system(.title3, design: .default, weight: .semibold))
                .foregroundStyle(CoTheme.ink)
                .lineSpacing(2)

            // mandatory: why this reached you — the receipt panel
            VStack(alignment: .leading, spacing: CoTheme.Space.xs) {
                ForEach(item.whyReachedYou, id: \.self) { reason in
                    Text(reason)
                        .font(CoTheme.caption())
                        .foregroundStyle(CoTheme.ink.opacity(0.85))
                }
            }
            .padding(CoTheme.Space.s + 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CoTheme.clay.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))

            HStack(spacing: CoTheme.Space.s) {
                CoSourcePill(label: item.sourceLabel)
                Text(item.publishedAgo)
                    .font(CoTheme.caption())
                    .foregroundStyle(CoTheme.inkSoft)
            }

            HStack(spacing: CoTheme.Space.s) {
                CoActionButton(label: "open", prominent: true) {
                    if let url = item.sourceURL {
                        openURL(url)
                    } else {
                        toasts.show("no public link came with this one.")
                    }
                }
                CoActionButton(label: "save") {
                    Task {
                        try? await model.api.saveRadarItem(item.id)
                        model.catches = (try? await model.api.fetchCatches()) ?? model.catches
                        toasts.show("kept in catches.")
                    }
                }
                CoActionButton(label: "mute") {
                    Task {
                        try? await model.api.muteRadarItem(item.id)
                        model.radar = (try? await model.api.fetchRadar()) ?? model.radar
                        toasts.show("muted this update type.")
                    }
                }
            }
        }
    }
}

#Preview {
    YouShouldKnowView()
        .environment(previewModel())
        .environment(ToastCenter())
}
