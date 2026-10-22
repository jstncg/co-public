import SwiftUI

// Each platform draws its own mark in full color (Justin, 2026-08-05: "full color so its recognizable").
// X and TikTok ship a dark-appearance twin — the stock black mark is invisible on a #1C1C1E card.

enum CoPlatform {
    /// The brand's own mark, if we ship one.
    private static let assets: [String: String] = [
        "YouTube": "platform-youtube", "X": "platform-x", "Twitter": "platform-x",
        "TikTok": "platform-tiktok", "Instagram": "platform-instagram",
        "Facebook": "platform-facebook", "Reddit": "platform-reddit",
        "Substack": "platform-substack", "Spotify": "platform-spotify",
        "Apple Podcasts": "platform-applepodcasts", "Pinterest": "platform-pinterest",
        "Google": "platform-google",
    ]

    static func asset(_ platform: String) -> String? { assets[platform] }

    /// The fallback for everything with no shipped mark.
    static func symbol(_ platform: String) -> String {
        switch platform {
        case "Are.na": return "square.grid.2x2.fill"
        case "Photos": return "photo.stack"
        case "Notes": return "note.text"
        default: return "link"
        }
    }
}

/// One glyph sized like text — a square brand path reads a touch smaller than an SF symbol at the same size.
struct PlatformMark: View {
    let platform: String
    var size: CGFloat = 15

    var body: some View {
        Group {
            if let asset = CoPlatform.asset(platform) {
                Image(asset)
                    .renderingMode(.original)
                    .resizable()
                    .scaledToFit()
                    .frame(width: size, height: size)
            } else {
                Image(systemName: CoPlatform.symbol(platform))
                    .font(.system(size: size, weight: .semibold))
            }
        }
        .accessibilityLabel(platform)
    }
}
