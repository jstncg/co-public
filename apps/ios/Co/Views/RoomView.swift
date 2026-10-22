// RoomView.swift — one room of your head (call-003: Inside-Out, never a graph).
//
// The room card (in the world grid) is a 2×2 mosaic + theme + count. Tapping in
// shows the room's members media-first: image tiles where a thumb exists, typographic
// tiles where the words are the picture. The whisper — one concrete first move in
// their own vocabulary — sits under the title, quiet.

import SwiftUI

// MARK: - room card (the grid unit)

struct RoomCard: View {
    let room: RoomModel

    private var thumbed: [RoomMember] { room.members.filter { $0.thumbURL != nil } }

    var body: some View {
        VStack(alignment: .leading, spacing: CoTheme.Space.s) {
            mosaic
            Text(room.theme.lowercased())
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(CoTheme.ink)
                .lineLimit(2, reservesSpace: false)
            Text("\(room.count) things")
                .font(CoTheme.caption())
                .foregroundStyle(CoTheme.inkSoft)
        }
        .padding(CoTheme.Space.s + 4)
        .background(CoTheme.card, in: RoundedRectangle(cornerRadius: CoTheme.cornerRadius))
    }

    private var mosaic: some View {
        let four = Array((thumbed + room.members.filter { $0.thumbURL == nil }).prefix(4))
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 3), GridItem(.flexible(), spacing: 3)],
                         spacing: 3) {
            ForEach(four) { m in
                cell(m)
            }
            // pad to 4 cells so every mosaic is a full square
            ForEach(0..<max(0, 4 - four.count), id: \.self) { _ in
                RoundedRectangle(cornerRadius: 7).fill(CoTheme.mediaWash.opacity(0.5))
                    .aspectRatio(1, contentMode: .fit)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private func cell(_ m: RoomMember) -> some View {
        if let t = m.thumbURL, let u = URL(string: t) {
            Color.clear.aspectRatio(1, contentMode: .fit)
                .overlay(
                    AsyncImage(url: u) { img in
                        img.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 7).fill(CoTheme.mediaWash)
                    }
                )
                .clipShape(RoundedRectangle(cornerRadius: 7))
        } else {
            RoundedRectangle(cornerRadius: 7)
                .fill(CoTheme.mediaWash)
                .aspectRatio(1, contentMode: .fit)
                .overlay(
                    Text(m.note)
                        .font(.system(size: 8, weight: .medium))
                        .foregroundStyle(CoTheme.inkSoft)
                        .lineLimit(4)
                        .padding(5), alignment: .topLeading)
        }
    }
}

// MARK: - room detail

struct RoomView: View {
    let room: RoomModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: CoTheme.Space.m) {
                Text(room.theme.lowercased())
                    .font(CoTheme.sectionHeader())
                    .foregroundStyle(CoTheme.ink)
                    .padding(.top, CoTheme.Space.s)
                if let w = room.whisper, !w.isEmpty {
                    Label(w, systemImage: "arrow.turn.down.right")
                        .font(CoTheme.body())
                        .foregroundStyle(CoTheme.clay)
                }
                LazyVGrid(columns: [GridItem(.flexible(), spacing: CoTheme.Space.s),
                                    GridItem(.flexible(), spacing: CoTheme.Space.s)],
                          spacing: CoTheme.Space.s) {
                    ForEach(room.members) { m in
                        memberTile(m)
                    }
                }
            }
            .padding(.horizontal, CoTheme.Space.m)
            .padding(.bottom, CoTheme.Space.xl)
        }
        .background(CoTheme.paper)
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func memberTile(_ m: RoomMember) -> some View {
        Button {
            if let s = m.url, let u = URL(string: s) { openURL(u) }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                if let t = m.thumbURL, let u = URL(string: t) {
                    Color.clear.aspectRatio(1.25, contentMode: .fit)
                        .overlay(
                            AsyncImage(url: u) { img in
                                img.resizable().aspectRatio(contentMode: .fill)
                            } placeholder: {
                                Rectangle().fill(CoTheme.mediaWash)
                            }
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                Text(m.note)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(m.thumbURL == nil ? CoTheme.ink : CoTheme.inkSoft)
                    .lineLimit(m.thumbURL == nil ? 6 : 2)
                    .multilineTextAlignment(.leading)
                if let d = m.date {
                    Text(d)
                        .font(.system(size: 10))
                        .foregroundStyle(CoTheme.inkSoft.opacity(0.7))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(CoTheme.Space.s + 2)
            .background(CoTheme.card, in: RoundedRectangle(cornerRadius: CoTheme.cornerRadius - 4))
        }
        .buttonStyle(.plain)
        .disabled(m.url == nil)
    }
}
