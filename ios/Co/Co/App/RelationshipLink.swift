import Foundation
import Security

/// The existing `/w/<slug>` relationship is both address and credential. A TestFlight build
/// receives it as `kyo://connect?world=<encoded URL>` in the member's iMessage thread; there is
/// no intake flow and no second identity to reconcile.
struct RelationshipLink: Equatable, Sendable {
    let worldURL: URL

    static func incoming(_ url: URL) -> RelationshipLink? {
        guard url.scheme?.lowercased() == "kyo", url.host?.lowercased() == "connect",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let raw = components.queryItems?.first(where: { $0.name == "world" })?.value,
              let candidate = URL(string: raw)
        else { return nil }
        return normalized(candidate)
    }

    static func normalized(_ candidate: URL) -> RelationshipLink? {
        guard candidate.user == nil, candidate.password == nil,
              candidate.query == nil, candidate.fragment == nil,
              let host = candidate.host?.lowercased(), !host.isEmpty
        else { return nil }

        let scheme = candidate.scheme?.lowercased()
        guard allowedScheme(scheme, host: host),
              let slug = worldSlug(in: candidate.path) else { return nil }

        var clean = URLComponents()
        clean.scheme = scheme
        clean.host = host
        clean.port = candidate.port
        clean.path = "/w/\(slug)"
        guard let worldURL = clean.url else { return nil }
        return RelationshipLink(worldURL: worldURL)
    }

    /// HTTPS everywhere; plain HTTP only for a Debug loopback rail.
    private static func allowedScheme(_ scheme: String?, host: String) -> Bool {
        #if DEBUG
        let local = host == "localhost" || host == "127.0.0.1" || host == "::1"
        if scheme == "http" && local { return true }
        #endif
        return scheme == "https"
    }

    /// `/w/<20 lowercase hex>` and nothing else — the slug is the credential, so its shape
    /// is checked, not trusted.
    private static func worldSlug(in path: String) -> String? {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        guard parts.count == 2, parts[0] == "w" else { return nil }
        let slug = String(parts[1]).lowercased()
        let hex = CharacterSet(charactersIn: "0123456789abcdef")
        guard slug.count == 20,
              slug.unicodeScalars.allSatisfy({ hex.contains($0) }) else { return nil }
        return slug
    }
}

/// Keychain, not UserDefaults: possession of the world link grants access to the member's world.
/// The store intentionally has only one slot because the product has one relationship, not an
/// account switcher.
enum RelationshipLinkStore {
    private static let service = "app.kyo.Kyo.relationship"
    private static let account = "world-url"

    static func load() -> RelationshipLink? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let raw = String(data: data, encoding: .utf8),
              let url = URL(string: raw)
        else { return nil }
        return RelationshipLink.normalized(url)
    }

    static func save(_ link: RelationshipLink) throws {
        let value = Data(link.worldURL.absoluteString.utf8)
        let identity: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: value,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(identity as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var addition = identity
            attributes.forEach { addition[$0.key] = $0.value }
            let addStatus = SecItemAdd(addition as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError(addStatus) }
        } else if status != errSecSuccess {
            throw KeychainError(status)
        }
    }

    struct KeychainError: Error, Equatable {
        let status: OSStatus
        init(_ status: OSStatus) { self.status = status }
    }
}

enum CoAPIEnvironment {
    static func current() -> CoAPI {
        if let link = RelationshipLinkStore.load() {
            return RailCoAPI(baseURL: link.worldURL)
        }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-coFixtures") {
            return MockCoAPI()
        }
        #endif
        return UnpairedCoAPI()
    }
}
