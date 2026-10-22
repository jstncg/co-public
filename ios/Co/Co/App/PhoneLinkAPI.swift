import Foundation

protocol HTTPDataLoading: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: HTTPDataLoading {}

struct PhoneLinkChallenge: Decodable, Equatable, Sendable {
    let challengeId: String
    let expiresAt: String
    let phoneLast4: String
}

struct PhoneLinkStatus: Decodable, Equatable, Sendable {
    let linked: Bool
    let phoneLast4: String?
    let verifiedAt: String?
    let handoffNumber: String?
    /// The member's rail world — where the relationship actually lives. Optional so older
    /// server responses still decode; absent → the app stays on the V2 door.
    var worldURL: String?

    var messageURL: URL? {
        guard let handoffNumber else { return nil }
        let clean = handoffNumber.filter { $0.isNumber || $0 == "+" }
        return clean.contains(where: { $0.isNumber }) ? URL(string: "sms:\(clean)") : nil
    }
}

enum PhoneLinkAPIError: Error, Equatable {
    case unauthorized
    case rejected(Int)
    case malformedResponse
}

struct PhoneLinkAPI: Sendable {
    let baseURL: URL
    let accessToken: @Sendable () async -> String?
    var loader: any HTTPDataLoading = URLSession.shared

    func status() async throws -> PhoneLinkStatus {
        try await send(path: "api/v1/phone-link", method: "GET")
    }

    func request(phoneNumber: String) async throws -> PhoneLinkChallenge {
        try await send(path: "api/v1/phone-link/request", method: "POST",
                       body: ["phoneNumber": phoneNumber])
    }

    func verify(challengeId: String, code: String, phoneNumber: String) async throws {
        let _: LinkedResponse = try await send(path: "api/v1/phone-link/verify", method: "POST",
                                               body: ["challengeId": challengeId, "code": code,
                                                      "phoneNumber": phoneNumber])
    }

    /// The intake's answers, seeding the member's graph. Just the answers — the server already
    /// knows whose graph from the verified binding, so the client never names a tenant or a
    /// number here.
    func submitOnboarding(answers: [String: String]) async throws {
        let _: SeededResponse = try await send(path: "api/v1/onboarding", method: "POST",
                                               body: answers)
    }

    private struct LinkedResponse: Decodable { let linked: Bool }
    private struct SeededResponse: Decodable { let seeded: Bool }

    private func send<Response: Decodable>(path: String, method: String,
                                            body: [String: String]? = nil) async throws -> Response {
        guard let token = await accessToken() else { throw PhoneLinkAPIError.unauthorized }
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await loader.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            if code == 401 { throw PhoneLinkAPIError.unauthorized }
            throw PhoneLinkAPIError.rejected(code)
        }
        guard let decoded = try? JSONDecoder().decode(Response.self, from: data) else {
            throw PhoneLinkAPIError.malformedResponse
        }
        return decoded
    }
}

enum PhoneNumberInput {
    /// The server's identity contract is E.164. Apple's contact suggestion commonly supplies a
    /// formatted US national number, so the +1 shown by this V1 field is applied when it is omitted
    static func e164(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let digits = trimmed.filter { $0.isNumber }
        if trimmed.first == "+" {
            guard (8...15).contains(digits.count), digits.first != "0" else { return nil }
            return "+\(digits)"
        }
        if digits.count == 10 { return "+1\(digits)" }
        if digits.count == 11, digits.first == "1" { return "+\(digits)" }
        return nil
    }
}
