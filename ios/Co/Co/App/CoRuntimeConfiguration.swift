import Foundation

struct CoRuntimeConfiguration: Equatable, Sendable {
    let apiBaseURL: URL
    let supabaseURL: URL
    let supabasePublishableKey: String

    init?(values: [String: Any]) {
        func resolved(_ key: String) -> String? {
            guard let value = values[key] as? String else { return nil }
            let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !clean.isEmpty, !clean.contains("$(") else { return nil }
            return clean
        }

        guard let api = resolved("CoAPIBaseURL").flatMap(URL.init(string:)),
              let supabase = resolved("CoSupabaseURL").flatMap(URL.init(string:)),
              let key = resolved("CoSupabasePublishableKey"),
              [api, supabase].allSatisfy(Self.isAllowedOrigin)
        else { return nil }

        apiBaseURL = api
        supabaseURL = supabase
        supabasePublishableKey = key
    }

    private static func isAllowedOrigin(_ url: URL) -> Bool {
        guard let host = url.host else { return false }
        if url.scheme == "https" { return true }
        #if DEBUG
        return url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)
        #else
        return false
        #endif
    }

    static var bundled: CoRuntimeConfiguration? {
        CoRuntimeConfiguration(values: Bundle.main.infoDictionary ?? [:])
    }
}
