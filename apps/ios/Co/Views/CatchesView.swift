// CatchesView.swift — tab: catches (goal.md §20.1)
// gallery of moment cards: media thumbnail + one-line why + timestamp.
// search, filter chips, floating "+ catch something". no folders forced.

import SwiftUI

struct CatchesView: View {
    @Environment(AppModel.self) private var model

    @State private var searchText = ""
    @State private var activeFacet: CatchFacet = .all
    @State private var showCapture = false
    @State private var path: [String] = []

    private var visibleMoments: [Moment] {
        model.catches.filter { moment in
            let facetOK = activeFacet == .all || moment.facets.contains(activeFacet)
            guard facetOK else { return false }
            guard !searchText.isEmpty else { return true }
            let haystack = [moment.title, moment.whySignal, moment.userNote, moment.transcript]
                .compactMap(\.self).joined(separator: " ").lowercased()
            return haystack.contains(searchText.lowercased())
        }
    }

    // ONE THEME PER SCREEN (call-003: "the feeling you should feel is clarity"): this
    // screen is YOUR WORLD — the number, the rooms of your head, the wall. What co
    // brings lives in today; verbs live in the thread. Nothing else belongs here.
    var body: some View {
        NavigationStack(path: $path) {
            ZStack(alignment: .bottom) {
                ScrollView {
                    VStack(alignment: .leading, spacing: CoTheme.Space.m) {
                        CoHero(number: "\(model.me.totalHeld ?? model.catches.count)",
                               caption: model.catches.isEmpty
                                   ? "nothing held yet — drop the first thing"
                                   : "things held · growing as you send")
                            .padding(.top, CoTheme.Space.s)
                        if model.catches.isEmpty {
                            CoCard {
                                Text("this fills up as you send things")
                                    .font(CoTheme.headline())
                                    .foregroundStyle(CoTheme.ink)
                                Text("a reel that hit. a thought at 1am. a voice note in the car. co holds all of it and hands it back when it matters.")
                                    .font(CoTheme.body())
                                    .foregroundStyle(CoTheme.inkSoft)
                            }
                        }
                        if !model.rooms.isEmpty {
                            Text("your rooms")
                                .font(CoTheme.caption().weight(.semibold))
                                .foregroundStyle(CoTheme.inkSoft)
                                .padding(.top, CoTheme.Space.xs)
                            LazyVGrid(columns: [GridItem(.flexible(), spacing: CoTheme.Space.s),
                                                GridItem(.flexible(), spacing: CoTheme.Space.s)],
                                      spacing: CoTheme.Space.s) {
                                ForEach(model.rooms) { room in
                                    NavigationLink(value: room.theme) {
                                        RoomCard(room: room)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        if !model.catches.isEmpty {
                            Text("everything")
                                .font(CoTheme.caption().weight(.semibold))
                                .foregroundStyle(CoTheme.inkSoft)
                                .padding(.top, CoTheme.Space.s)
                        }
                        facetChips
                        momentList
                    }
                    .padding(.horizontal, CoTheme.Space.m)
                    .padding(.bottom, 90) // room for the floating button
                }

                catchSomethingButton
            }
            .background(CoTheme.paper)
            .navigationTitle("world")
            .navigationDestination(for: String.self) { theme in
                if let room = model.rooms.first(where: { $0.theme == theme }) {
                    RoomView(room: room)
                }
            }
            .searchable(text: $searchText, prompt: "search everything you've sent")
        }
        .sheet(isPresented: $showCapture) {
            CaptureSheet()
        }
        // dev hook (CO_DEBUG_TAB precedent): land straight in the first room
        .onChange(of: model.rooms.isEmpty) { _, empty in
            if !empty, ProcessInfo.processInfo.environment["CO_DEBUG_ROOM"] != nil,
               let t = model.rooms.first?.theme { path = [t] }
        }
    }

    // MARK: chips (§20.1 filters)

    private var facetChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: CoTheme.Space.s) {
                ForEach(CatchFacet.allCases, id: \.self) { facet in
                    let active = facet == activeFacet
                    Button {
                        activeFacet = facet
                    } label: {
                        Text(facet.rawValue)
                            .font(CoTheme.caption().weight(active ? .semibold : .regular))
                            .foregroundStyle(active ? CoTheme.paper : CoTheme.ink)
                            .padding(.horizontal, CoTheme.Space.m)
                            .padding(.vertical, CoTheme.Space.s)
                            .background(active ? CoTheme.clay : CoTheme.ink.opacity(0.05), in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: cards, grouped by day

    private var momentList: some View {
        let grouped = Dictionary(grouping: visibleMoments) {
            Calendar.current.startOfDay(for: $0.capturedAt)
        }
        let days = grouped.keys.sorted(by: >)

        return ForEach(days, id: \.self) { day in
            VStack(alignment: .leading, spacing: CoTheme.Space.s) {
                Text(dayLabel(day))
                    .font(CoTheme.caption())
                    .foregroundStyle(CoTheme.inkSoft)
                    .padding(.top, CoTheme.Space.s)

                ForEach(grouped[day] ?? []) { moment in
                    MomentCard(moment: moment)
                }
            }
        }
    }

    private func dayLabel(_ day: Date) -> String {
        if Calendar.current.isDateInToday(day) { return "today" }
        if Calendar.current.isDateInYesterday(day) { return "yesterday" }
        return day.formatted(.dateTime.weekday(.wide).month().day()).lowercased()
    }

    // MARK: floating capture button (§20.1)

    private var catchSomethingButton: some View {
        Button {
            showCapture = true
        } label: {
            Label("catch something", systemImage: "plus")
                .font(CoTheme.headline())
                .foregroundStyle(CoTheme.ink)
                .padding(.horizontal, CoTheme.Space.l)
                .padding(.vertical, CoTheme.Space.m)
                .coGlassCapsule(prominent: true)
        }
        .buttonStyle(.plain)
        .padding(.bottom, CoTheme.Space.m)
    }
}

// MARK: - moment card (§20.1 mockup)

struct MomentCard: View {
    let moment: Moment

    var body: some View {
        CoCard {
            MomentThumbnail(moment: moment)

            // one-line why — the part the user usually loses
            Text(moment.whySignal ?? moment.title ?? "saved quietly")
                .font(CoTheme.headline())
                .foregroundStyle(CoTheme.ink)
                .lineLimit(2)

            HStack(spacing: CoTheme.Space.s) {
                Text(moment.capturedAt.formatted(date: .omitted, time: .shortened).lowercased())
                if moment.processingStatus == .pending {
                    Text("· uploading")
                }
                if let honest = moment.coverage.honestLine, moment.whySignal == nil {
                    Text("· \(honest)").lineLimit(1)
                }
            }
            .font(CoTheme.caption())
            .foregroundStyle(CoTheme.inkSoft)
        }
    }
}

/// media-first thumbnail. demo mode has no real media files, so this renders
/// an honest placeholder wash + source glyph instead of pretending.
struct MomentThumbnail: View {
    let moment: Moment

    private var glyph: String {
        switch moment.sourceType {
        case .voice: "waveform"
        case .shortVideo, .youtube: "play.rectangle"
        case .podcast: "headphones"
        case .screenshot, .image: "photo"
        case .socialPost, .text: "text.alignleft"
        case .url, .article: "link"
        default: "square.dashed"
        }
    }

    var body: some View {
        if let tp = moment.thumbnailPath, let turl = URL(string: tp) {
            // overlay-in-clear-frame: a wide image must never propose its own width
            // (scaledToFill at fixed height inflates the whole column otherwise)
            Color.clear
                .frame(height: 180)
                .frame(maxWidth: .infinity)
                .overlay(
                    AsyncImage(url: turl) { img in
                        img.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        RoundedRectangle(cornerRadius: CoTheme.cornerRadius - 4).fill(CoTheme.mediaWash)
                    }
                )
                .clipShape(RoundedRectangle(cornerRadius: CoTheme.cornerRadius - 4))
        } else {
            placeholderBody
        }
    }

    private var placeholderBody: some View {
        RoundedRectangle(cornerRadius: CoTheme.cornerRadius - 4)
            .fill(CoTheme.mediaWash)
            .frame(height: moment.sourceType == .voice ? 64 : 140)
            .overlay(alignment: moment.sourceType == .voice ? .leading : .center) {
                HStack(spacing: CoTheme.Space.s) {
                    Image(systemName: glyph)
                        .font(.title3)
                        .foregroundStyle(CoTheme.inkSoft)
                    if moment.sourceType == .voice, let transcript = moment.transcript {
                        Text("“\(transcript)”")
                            .font(CoTheme.caption().italic())
                            .foregroundStyle(CoTheme.inkSoft)
                            .lineLimit(2)
                    }
                }
                .padding(.horizontal, CoTheme.Space.m)
            }
    }
}

#Preview {
    CatchesView()
        .environment(previewModel())
        .environment(ToastCenter())
}

@MainActor
func previewModel() -> AppModel {
    let model = AppModel()
    model.catches = DemoData.mayaMoments
    model.patterns = DemoData.patterns
    model.radar = DemoData.radar
    model.me = DemoData.me
    return model
}
