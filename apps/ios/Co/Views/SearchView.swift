// SearchView — everything you've ever sent, searchable (8/4).
// Server-side over the whole journal, not the recent window. Black, simple, fast.

import SwiftUI

struct SearchView: View {
    @Environment(AppModel.self) private var model
    @State private var q = ""
    @State private var results: [Moment] = []
    @State private var searched = false
    @State private var task: Task<Void, Never>? = nil

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: CoTheme.Space.s) {
                    ForEach(results) { m in
                        SearchRow(moment: m)
                    }
                    if searched && results.isEmpty && !q.isEmpty {
                        Text("nothing yet for “\(q)”")
                            .font(CoTheme.body())
                            .foregroundStyle(CoTheme.inkSoft)
                            .padding(.top, CoTheme.Space.xl)
                    }
                    if !searched {
                        Text("everything you've ever sent, in one box.")
                            .font(CoTheme.body())
                            .foregroundStyle(CoTheme.inkSoft)
                            .padding(.top, CoTheme.Space.xl)
                    }
                }
                .padding(.horizontal, CoTheme.Space.m)
            }
            .background(CoTheme.paper)
            .navigationTitle("search")
            .searchable(text: $q, prompt: "try “sauna”, “that reel about focus”")
            .onChange(of: q) {
                task?.cancel()
                let query = q
                guard query.count >= 2 else { results = []; searched = false; return }
                task = Task {
                    try? await Task.sleep(for: .milliseconds(350))
                    guard !Task.isCancelled else { return }
                    let r = (try? await model.api.search(query)) ?? []
                    guard !Task.isCancelled else { return }
                    results = r
                    searched = true
                }
            }
        }
    }
}

private struct SearchRow: View {
    let moment: Moment

    var body: some View {
        Link(destination: moment.canonicalURL ?? URL(string: "sms:")!) {
            HStack(alignment: .top, spacing: CoTheme.Space.m) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(moment.title ?? "a capture")
                        .font(CoTheme.headline())
                        .foregroundStyle(CoTheme.ink)
                        .multilineTextAlignment(.leading)
                        .lineLimit(3)
                    Text(moment.capturedAt.formatted(date: .abbreviated, time: .omitted).lowercased())
                        .font(CoTheme.caption())
                        .foregroundStyle(CoTheme.inkSoft)
                }
                Spacer(minLength: 0)
                if let tp = moment.thumbnailPath, let u = URL(string: tp) {
                    AsyncImage(url: u) { img in
                        img.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 8).fill(CoTheme.mediaWash)
                    }
                    .frame(width: 56, height: 56)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
            .padding(CoTheme.Space.m)
            .background(CoTheme.card, in: RoundedRectangle(cornerRadius: CoTheme.cornerRadius))
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    SearchView()
        .environment(AppModel())
        .environment(ToastCenter())
}
