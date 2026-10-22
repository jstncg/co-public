// TodayView — the delivery room (app charter 8/4).
//
// The morning open ritual, News+ grammar: date eyebrow, heavy red header, then
// exactly what matters — YOUR DAY (the read, the one thing, the setup) and CAME
// BACK OVERNIGHT (the wake's delivery). 90 seconds, then out into the day.
// No feed here on purpose: time-in-app is the anti-metric.

import SwiftUI

struct TodayView: View {
    @Environment(AppModel.self) private var model
    @State private var marking = false

    private var eyebrow: String {
        Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day())
            .uppercased()
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: CoTheme.Space.l) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(eyebrow)
                            .font(.system(size: 12, weight: .bold))
                            .kerning(1.1)
                            .foregroundStyle(CoTheme.inkSoft)
                        Text("today")
                            .font(CoTheme.sectionHeader())
                            .foregroundStyle(CoTheme.ink)
                    }
                    .padding(.top, CoTheme.Space.s)

                    if let read = model.today.read {
                        Text(read)
                            .font(CoTheme.body())
                            .foregroundStyle(CoTheme.ink)
                            .lineSpacing(3)
                    }

                    // what actually changed in their week — consequence sits above the plan,
                    // because an undo they can't find is not reversible (LivedView.swift)
                    LivedSection()

                    if let one = model.today.oneThing {
                        CoCard {
                            Text("THE ONE THING")
                                .font(.system(size: 11, weight: .heavy))
                                .kerning(1.2)
                                .foregroundStyle(CoTheme.clay)
                            Text(one)
                                .font(CoTheme.headline())
                                .foregroundStyle(CoTheme.ink)
                                .strikethrough(model.today.done, color: CoTheme.inkSoft)
                                .opacity(model.today.done ? 0.55 : 1)
                            Button {
                                marking = true
                                Task {
                                    try? await model.api.markDone()
                                    model.today.done = true
                                    marking = false
                                }
                            } label: {
                                Text(model.today.done ? "done ✓" : "mark it done")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(model.today.done ? CoTheme.paper : CoTheme.clay)
                                    .padding(.horizontal, CoTheme.Space.m)
                                    .padding(.vertical, CoTheme.Space.s)
                                    .background(
                                        Capsule().fill(model.today.done ? CoTheme.clay : .clear)
                                            .stroke(CoTheme.clay.opacity(0.5), lineWidth: 1)
                                    )
                            }
                            .buttonStyle(.plain)
                            .disabled(marking || model.today.done)
                        }
                        if !model.today.setup.isEmpty {
                            VStack(alignment: .leading, spacing: CoTheme.Space.s) {
                                ForEach(model.today.setup, id: \.self) { line in
                                    HStack(alignment: .top, spacing: CoTheme.Space.s) {
                                        Circle().fill(CoTheme.clay.opacity(0.6))
                                            .frame(width: 5, height: 5).padding(.top, 7)
                                        Text(line)
                                            .font(CoTheme.body())
                                            .foregroundStyle(CoTheme.inkSoft)
                                    }
                                }
                            }
                        }
                        if let then = model.today.then {
                            Text(then)
                                .font(CoTheme.body().italic())
                                .foregroundStyle(CoTheme.inkSoft)
                        }
                    }

                    if let o = model.overnight {
                        VStack(alignment: .leading, spacing: CoTheme.Space.s) {
                            Text("came back overnight")
                                .font(CoTheme.sectionHeader())
                                .foregroundStyle(CoTheme.ink)
                            CoCard {
                                if let thread = o.thread {
                                    Text(thread.uppercased())
                                        .font(.system(size: 11, weight: .heavy))
                                        .kerning(1.1)
                                        .foregroundStyle(CoTheme.clay)
                                }
                                Text(o.line)
                                    .font(CoTheme.headline())
                                    .foregroundStyle(CoTheme.ink)
                                    .lineSpacing(2)
                                if let u = o.url, let link = URL(string: u) {
                                    Link(destination: link) {
                                        Label("open the read", systemImage: "arrow.up.right")
                                            .font(.system(size: 14, weight: .semibold))
                                            .foregroundStyle(CoTheme.clay)
                                    }
                                }
                            }
                        }
                    }

                    // worth your time — at most three, why one tap away (call-003:
                    // reasoning in reach, never inline)
                    if !model.radar.newItems.isEmpty {
                        VStack(alignment: .leading, spacing: CoTheme.Space.s) {
                            Text("worth your time")
                                .font(CoTheme.sectionHeader())
                                .foregroundStyle(CoTheme.ink)
                            ForEach(model.radar.newItems.prefix(3)) { FindRow(item: $0) }
                        }
                    }

                    // while you were living — the staff's receipts (many hands, one ledger)
                    if !model.staff.isEmpty {
                        VStack(alignment: .leading, spacing: CoTheme.Space.s) {
                            Text("while you were living")
                                .font(CoTheme.sectionHeader())
                                .foregroundStyle(CoTheme.ink)
                            Text("what co did, unasked")
                                .font(CoTheme.caption())
                                .foregroundStyle(CoTheme.inkSoft)
                            CoCard {
                                ForEach(model.staff.prefix(5)) { entry in
                                    StaffRow(entry: entry)
                                    if entry.id != model.staff.prefix(5).last?.id {
                                        Divider().overlay(CoTheme.hairline)
                                    }
                                }
                            }
                        }
                    }

                    if model.today.read == nil && model.today.oneThing == nil && model.overnight == nil {
                        CoCard {
                            Text("nothing staged yet")
                                .font(CoTheme.headline())
                                .foregroundStyle(CoTheme.ink)
                            Text("co preps your day early each morning — the read, the one thing, and whatever came back overnight land here.")
                                .font(CoTheme.body())
                                .foregroundStyle(CoTheme.inkSoft)
                        }
                    }
                }
                .padding(.horizontal, CoTheme.Space.m)
                .padding(.bottom, CoTheme.Space.xl)
            }
            .background(CoTheme.paper)
            .refreshable { await model.refreshAll() }
        }
    }
}

// MARK: - the day's find (compact; the why is one tap away)

struct FindRow: View {
    let item: RadarItem
    @Environment(\.openURL) private var openURL
    @State private var showWhy = false

    var body: some View {
        CoCard {
            Text(item.headline)
                .font(CoTheme.headline())
                .foregroundStyle(CoTheme.ink)
                .lineSpacing(2)
            HStack(spacing: CoTheme.Space.s) {
                CoSourcePill(label: item.sourceLabel)
                Spacer()
                Button {
                    withAnimation(.easeOut(duration: 0.18)) { showWhy.toggle() }
                } label: {
                    Text("why this")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CoTheme.inkSoft)
                }
                .buttonStyle(.plain)
                if let url = item.sourceURL {
                    Button { openURL(url) } label: {
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(CoTheme.clay)
                    }
                    .buttonStyle(.plain)
                }
            }
            if showWhy, let why = item.whyReachedYou.first {
                Text(why)
                    .font(CoTheme.caption())
                    .foregroundStyle(CoTheme.ink.opacity(0.85))
                    .padding(CoTheme.Space.s + 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(CoTheme.clay.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }
}

// MARK: - one line of staff work (verb glyph · what · tap for why)

struct StaffRow: View {
    let entry: StaffEntry
    @State private var showWhy = false

    private var glyph: String {
        switch entry.verb {
        case "watched": "play.rectangle"
        case "read": "sun.max"
        case "checked": "eye"
        case "found": "sparkle"
        case "researched": "magnifyingglass"
        case "drafted": "pencil.line"
        default: "checkmark"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.xs) {
            HStack(alignment: .top, spacing: CoTheme.Space.s + 2) {
                Image(systemName: glyph)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(CoTheme.clay)
                    .frame(width: 18)
                    .padding(.top, 1)
                Text(entry.what)
                    .font(.system(size: 14))
                    .foregroundStyle(CoTheme.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if showWhy, let why = entry.why {
                Text(why)
                    .font(CoTheme.caption())
                    .foregroundStyle(CoTheme.inkSoft)
                    .padding(.leading, 18 + CoTheme.Space.s + 2)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            guard entry.why != nil else { return }
            withAnimation(.easeOut(duration: 0.18)) { showWhy.toggle() }
        }
    }
}

#Preview {
    TodayView()
        .environment(AppModel())
        .environment(ToastCenter())
}
