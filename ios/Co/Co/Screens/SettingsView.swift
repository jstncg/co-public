import SwiftUI

// Settings, four sections and nothing else (Justin, 2026-08-03) — a native inset-grouped
// List does the rest.
// Every toggle is local @AppStorage state and grants nothing — no permission requested, no
// service contacted.

struct SettingsView: View {
    var onClose: () -> Void

    @AppStorage("coConnectNotes") private var notesConnected = true
    @AppStorage("coConnectHealth") private var healthConnected = false
    @AppStorage("coConnectLocation") private var locationConnected = false
    @AppStorage("coNotificationsAllowed") private var notificationsAllowed = true
    @AppStorage("coAppearance") private var appearanceRaw = CoAppearance.system.rawValue

    var body: some View {
        NavigationStack {
            List {
                Section("Appearance") {
                    Picker("Theme", selection: Binding(
                        get: { CoAppearance(rawValue: appearanceRaw) ?? .system },
                        set: { appearanceRaw = $0.rawValue }
                    )) {
                        ForEach(CoAppearance.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                }

                Section("Connections") {
                    NavigationLink {
                        ConnectionDetail(name: "Apple Notes")
                    } label: {
                        ConnectionRow(icon: "note.text", tint: CoColor.notesGold.color,
                                      name: "Apple Notes",
                                      line: "Everything you write reaches Co.")
                    }

                    Toggle(isOn: $healthConnected) {
                        ConnectionRow(icon: "heart.fill", tint: CoColor.watchDeep.color,
                                      name: "Apple Health",
                                      line: "Sync health and fitness data.")
                    }

                    Toggle(isOn: $locationConnected) {
                        ConnectionRow(icon: "location.fill", tint: CoColor.accent.color,
                                      name: "Location",
                                      line: "Share your location with Co.")
                    }
                }

                Section("Notifications") {
                    Toggle("Allow notifications", isOn: $notificationsAllowed)
                }

                Section("Legal") {
                    Link(destination: URL(string: "https://kyo.app/terms")!) {
                        ExternalRow(name: "Terms of Service")
                    }
                    Link(destination: URL(string: "https://kyo.app/privacy")!) {
                        ExternalRow(name: "Privacy Policy")
                    }
                }

                Section("Account") {
                    NavigationLink {
                        FeedbackDetail()
                    } label: {
                        Text("Send feedback")
                    }
                    // Inert in this prototype: there is no session to end yet.
                    Button("Log out", role: .destructive) {}
                }
            }
            .tint(CoColor.accent.color)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // NO `coGlassControl` here — iOS 26 already renders a glass disc, adding
                    // ours drew two (Justin, 2026-08-03).
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: CoControl.discIcon, weight: .semibold))
                    }
                    .tint(CoColor.textPrimary.color)
                    .accessibilityLabel("Close")
                }
            }
        }
    }
}

/// Apple Settings' row shape: the tinted glyph tile, the name, one line of what it does.
private struct ConnectionRow: View {
    let icon: String
    let tint: Color
    let name: String
    let line: String

    var body: some View {
        HStack(spacing: CoSpacing.m) {
            Image(systemName: icon)
                .font(.system(size: CoControl.barIcon, weight: .semibold))
                .foregroundStyle(CoColor.textOnAccent.color)
                .frame(width: 29, height: 29)
                .background(tint, in: RoundedRectangle(cornerRadius: 7, style: .continuous))  // design: DESIGN_SYSTEM.md §0.4

            VStack(alignment: .leading, spacing: CoSpacing.xs) {
                Text(name)
                    .foregroundStyle(CoColor.textPrimary.color)
                Text(line)
                    .font(CoType.style(.caption))
                    .foregroundStyle(CoColor.textSecondary.color)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A row that leaves the app: the system's own arrow.up.right, trailing.
private struct ExternalRow: View {
    let name: String

    var body: some View {
        HStack {
            Text(name)
                .foregroundStyle(CoColor.textPrimary.color)
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right")
                .font(.system(size: CoControl.rowIcon, weight: .medium))
                .foregroundStyle(CoColor.textSecondary.color)
        }
    }
}

/// Stub destinations so the chevrons lead somewhere honest, not nowhere — replace when real
/// screens exist.
private struct ConnectionDetail: View {
    let name: String

    var body: some View {
        EditorialEmptyState(title: name,
                            line: "Connecting accounts isn't wired up yet.")
            .background(CoColor.appBackground.color)
            .navigationTitle(name)
            .navigationBarTitleDisplayMode(.inline)
    }
}

private struct FeedbackDetail: View {
    var body: some View {
        EditorialEmptyState(title: "Send feedback",
                            line: "Tell Co what's broken. Not wired up yet.")
            .background(CoColor.appBackground.color)
            .navigationTitle("Send feedback")
            .navigationBarTitleDisplayMode(.inline)
    }
}
