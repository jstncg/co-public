import Foundation
import Supabase

protocol CoAuthProviding: Sendable {
    func prepare() async throws
    func accessToken() async -> String?
}
/// The phone is the member-facing identity seam. This small anonymous Supabase session is only
/// the private app credential that lets the server run the phone challenge; it is not presented
/// as an account, profile, or onboarding choice.
actor SupabaseCoAuth: CoAuthProviding {
    private let client: SupabaseClient
    private var preparedAccessToken: String?

    init(url: URL, publishableKey: String) {
        client = SupabaseClient(supabaseURL: url, supabaseKey: publishableKey)
    }

    func prepare() async throws {
        if let session = try? await client.auth.session {
            preparedAccessToken = session.accessToken
            return
        }
        let session = try await client.auth.signInAnonymously()
        // Keep the credential returned by the successful response in memory instead of requiring
        // a second immediate Keychain read before the first Co request can leave the device
        preparedAccessToken = session.accessToken
    }

    func accessToken() async -> String? {
        if let preparedAccessToken { return preparedAccessToken }
        return try? await client.auth.session.accessToken
    }
}
