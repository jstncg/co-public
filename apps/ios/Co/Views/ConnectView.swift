// ConnectView.swift — pairing: paste the link co texted you. The link IS the credential.

import SwiftUI

struct ConnectView: View {
    var onDone: () -> Void
    @State private var pasted = ""
    @State private var checking = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Spacer()
            Text("co")
                .font(.system(size: 40, weight: .bold, design: .rounded))
                .foregroundStyle(CoTheme.clay)
            Text("connect to your co")
                .font(CoTheme.title())
                .foregroundStyle(CoTheme.ink)
            Text("text co first — it lives in your messages. when it sends you your link, paste it here and this app becomes your world.")
                .font(CoTheme.body())
                .foregroundStyle(CoTheme.inkSoft)
            TextField("https://…/w/…", text: $pasted)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
            Button {
                Task { await connect() }
            } label: {
                if checking { ProgressView().frame(maxWidth: .infinity) }
                else { Text("connect").frame(maxWidth: .infinity) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(pasted.isEmpty || checking)
            Button("skip — look around in demo mode") { onDone() }
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(CoTheme.paper.ignoresSafeArea())
        .tint(CoTheme.clay)
    }

    private func connect() async {
        guard let base = Pairing.normalize(pasted) else {
            error = "that doesn't look like a co link — it ends in /w/<your code>"
            return
        }
        checking = true
        defer { checking = false }
        do {
            let (_, resp) = try await URLSession.shared.data(from: base.appendingPathComponent("app.json"))
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
                error = "co didn't answer at that link — check it and try again"
                return
            }
            Pairing.set(base)
            onDone()
        } catch {
            self.error = "couldn't reach co — are you online?"
        }
    }
}
