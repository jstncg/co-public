// TalkView — tab: talk. The doors to the conversation (8/4 redesign: black, three moves).
// The thread is the deep door, the call is the fast one, the aim is the steering wheel.

import SwiftUI

struct TalkView: View {
    @Environment(AppModel.self) private var model
    @Environment(ToastCenter.self) private var toasts

    @State private var aim = ""
    @State private var savedAim = ""
    @State private var calling = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: CoTheme.Space.m) {

                    // the thread — the deep door
                    Button {
                        let n = model.me.number ?? ""
                        if let url = URL(string: "sms:" + n) { UIApplication.shared.open(url) }
                    } label: {
                        VStack(alignment: .leading, spacing: CoTheme.Space.s) {
                            Image(systemName: "bubble.left.fill")
                                .font(.system(size: 26))
                                .foregroundStyle(CoTheme.clay)
                            Text("open the thread")
                                .font(.system(size: 24, weight: .bold))
                                .foregroundStyle(CoTheme.ink)
                            Text("rant, voice-note, send the reel you just saw. everything lands in your world.")
                                .font(CoTheme.body())
                                .foregroundStyle(CoTheme.inkSoft)
                                .multilineTextAlignment(.leading)
                            if let n = model.me.number, !n.isEmpty {
                                Text(n)
                                    .font(CoTheme.caption())
                                    .foregroundStyle(CoTheme.inkSoft.opacity(0.7))
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(CoTheme.Space.l)
                        .background(
                            RoundedRectangle(cornerRadius: CoTheme.cornerRadius)
                                .fill(CoTheme.clay.opacity(0.14))
                                .stroke(CoTheme.clay.opacity(0.25), lineWidth: 0.5)
                        )
                    }
                    .buttonStyle(.plain)

                    // the call — the fast door
                    Button {
                        guard !calling else { return }
                        calling = true
                        Task {
                            do {
                                try await model.api.requestCall()
                                toasts.show("calling you now")
                            } catch {
                                toasts.show("couldn't get the line up")
                            }
                            calling = false
                        }
                    } label: {
                        HStack(spacing: CoTheme.Space.m) {
                            Image(systemName: "phone.fill")
                                .font(.system(size: 20))
                                .foregroundStyle(CoTheme.ink)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(calling ? "dialing…" : "have co call you")
                                    .font(CoTheme.headline())
                                    .foregroundStyle(CoTheme.ink)
                                Text("same mind, out loud. good for driving.")
                                    .font(CoTheme.caption())
                                    .foregroundStyle(CoTheme.inkSoft)
                            }
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(CoTheme.inkSoft)
                        }
                        .padding(CoTheme.Space.l)
                        .background(CoTheme.card, in: RoundedRectangle(cornerRadius: CoTheme.cornerRadius))
                    }
                    .buttonStyle(.plain)
                    .disabled(calling)

                    // the aim — the steering wheel
                    VStack(alignment: .leading, spacing: CoTheme.Space.s) {
                        Text("what are you figuring out today?")
                            .font(CoTheme.headline())
                            .foregroundStyle(CoTheme.ink)
                        Text("say it plainly. co aims today's finds at it.")
                            .font(CoTheme.caption())
                            .foregroundStyle(CoTheme.inkSoft)
                        TextField("", text: $aim, prompt: Text("e.g. how to actually start the fund")
                            .foregroundStyle(CoTheme.inkSoft), axis: .vertical)
                            .lineLimit(1...3)
                            .font(CoTheme.body())
                            .foregroundStyle(CoTheme.ink)
                            .padding(CoTheme.Space.m)
                            .background(CoTheme.paper, in: RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12)
                                .stroke(CoTheme.hairline.opacity(0.3), lineWidth: 0.5))
                            .onSubmit { saveAim() }
                        if !aim.trimmingCharacters(in: .whitespaces).isEmpty, aim != savedAim {
                            Button { saveAim() } label: {
                                Text("aim co at this")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(CoTheme.paper)
                                    .padding(.horizontal, CoTheme.Space.m)
                                    .padding(.vertical, CoTheme.Space.s)
                                    .background(Capsule().fill(CoTheme.clay))
                            }
                            .buttonStyle(.plain)
                        } else if !savedAim.isEmpty {
                            Label("aimed — today's finds follow this", systemImage: "scope")
                                .font(CoTheme.caption())
                                .foregroundStyle(CoTheme.clay)
                        }
                    }
                    .padding(CoTheme.Space.l)
                    .background(CoTheme.card, in: RoundedRectangle(cornerRadius: CoTheme.cornerRadius))
                }
                .padding(.horizontal, CoTheme.Space.m)
                .padding(.bottom, CoTheme.Space.xl)
            }
            .background(CoTheme.paper)
            .navigationTitle("talk")
        }
        .task {
            if let api = model.api as? RouterAPI {
                savedAim = await api.currentAim()
                aim = savedAim
            }
        }
    }

    private func saveAim() {
        let text = aim.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        Task {
            if let api = model.api as? RouterAPI {
                try? await api.setAim(text)
                savedAim = text
                await model.refreshAll()
                toasts.show("aimed. today's finds follow this.")
            } else {
                toasts.comingInBeta()
            }
        }
    }
}

#Preview {
    TalkView()
        .environment(AppModel())
        .environment(ToastCenter())
}
