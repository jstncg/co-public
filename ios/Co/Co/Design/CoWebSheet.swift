import SafariServices
import SwiftUI

/// A page co found, opened OVER the app (Justin, 2026-08-12: "a partiful link that opens up
/// within the app"). `SFSafariViewController`, not a `WKWebView`: it brings the reader, the
/// share sheet, and the member's existing logins for free, and a hand-rolled web view would owe
/// all three before it drew anything.
struct CoWebSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let configuration = SFSafariViewController.Configuration()
        // The invite is the thing being read. Loading it behind a preview card would put a
        // second tap between the member and a card that already cost one.
        configuration.entersReaderIfAvailable = false
        let controller = SFSafariViewController(url: url, configuration: configuration)
        controller.preferredControlTintColor = UIColor(CoColor.accent.color)
        controller.dismissButtonStyle = .close
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
