import XCTest
@testable import Co

private actor PhoneLinkLoader: HTTPDataLoading {
    private(set) var request: URLRequest?
    let data: Data
    let status: Int

    init(json: String, status: Int = 200) {
        data = Data(json.utf8)
        self.status = status
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        self.request = request
        return (data, HTTPURLResponse(url: request.url!, statusCode: status,
                                      httpVersion: nil, headerFields: nil)!)
    }
}
final class PhoneOnboardingTests: XCTestCase {
    func testRuntimeConfigurationRequiresResolvedHTTPSValues() throws {
        let valid = CoRuntimeConfiguration(values: [
            "CoAPIBaseURL": "https://co.example",
            "CoSupabaseURL": "https://project.supabase.co",
            "CoSupabasePublishableKey": "sb_publishable_example",
        ])
        XCTAssertEqual(valid?.apiBaseURL.absoluteString, "https://co.example")
        XCTAssertNil(CoRuntimeConfiguration(values: [
            "CoAPIBaseURL": "$(CO_API_BASE_URL)",
            "CoSupabaseURL": "https://project.supabase.co",
            "CoSupabasePublishableKey": "key",
        ]))
        XCTAssertNil(CoRuntimeConfiguration(values: [
            "CoAPIBaseURL": "http://co.example",
            "CoSupabaseURL": "https://project.supabase.co",
            "CoSupabasePublishableKey": "key",
        ]))
    }

    func testPhoneInputAcceptsAppleUSContactSuggestionsAndExplicitInternationalNumbers() {
        XCTAssertEqual(PhoneNumberInput.e164("+1 (555) 100-0999"), "+15551000999")
        XCTAssertEqual(PhoneNumberInput.e164("+82 10 1234 5678"), "+821012345678")
        XCTAssertEqual(PhoneNumberInput.e164("(555) 100-0999"), "+15551000999")
        XCTAssertEqual(PhoneNumberInput.e164("1 555 100 0999"), "+15551000999")
        XCTAssertNil(PhoneNumberInput.e164("+012345678"))
        XCTAssertNil(PhoneNumberInput.e164("5551000"))
    }

    func testPhoneStatusBuildsTheExistingIMessageThreadURL() throws {
        let status = PhoneLinkStatus(linked: true, phoneLast4: "8200",
                                     verifiedAt: "2026-08-06T00:00:00Z",
                                     handoffNumber: "+17145550123")
        XCTAssertEqual(status.messageURL?.absoluteString, "sms:+17145550123")
    }

    func testRequestCarriesThePrivateSessionAndDecodesTheChallenge() async throws {
        let loader = PhoneLinkLoader(json: """
        {"challengeId":"0198c5d2-bfed-75e0-b7d1-8a89b7c04210","expiresAt":"2026-08-06T00:05:00Z","phoneLast4":"8200"}
        """, status: 201)
        let api = PhoneLinkAPI(baseURL: URL(string: "https://co.example")!,
                               accessToken: { "member-token" }, loader: loader)

        let challenge = try await api.request(phoneNumber: "+15551000999")

        XCTAssertEqual(challenge.phoneLast4, "8200")
        let request = await loader.request
        XCTAssertEqual(request?.url?.path, "/api/v1/phone-link/request")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer member-token")
        XCTAssertFalse(String(data: try XCTUnwrap(request?.httpBody), encoding: .utf8)!.contains("member-token"))
    }

    func testUnauthorizedPhoneCallsStopBeforeNetwork() async {
        let loader = PhoneLinkLoader(json: "{}")
        let api = PhoneLinkAPI(baseURL: URL(string: "https://co.example")!,
                               accessToken: { nil }, loader: loader)
        do {
            _ = try await api.status()
            XCTFail("an app without a member session must not query phone state")
        } catch {
            XCTAssertEqual(error as? PhoneLinkAPIError, .unauthorized)
        }
        let request = await loader.request
        XCTAssertNil(request)
    }

    func testVerificationCarriesTheSameNumberThatReceivedTheCode() async throws {
        let loader = PhoneLinkLoader(json: "{\"linked\":true}")
        let api = PhoneLinkAPI(baseURL: URL(string: "https://co.example")!,
                               accessToken: { "member-token" }, loader: loader)

        try await api.verify(challengeId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04210",
                             code: "123456", phoneNumber: "+15551000999")

        let capturedRequest = await loader.request
        let request = try XCTUnwrap(capturedRequest)
        let body = try XCTUnwrap(request.httpBody)
        let values = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(values["phoneNumber"], "+15551000999")
        XCTAssertEqual(values["code"], "123456")
    }
}
