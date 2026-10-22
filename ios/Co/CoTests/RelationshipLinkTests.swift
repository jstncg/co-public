import XCTest
@testable import Co

final class RelationshipLinkTests: XCTestCase {
    func testAcceptsTheMagicLinkSentInIMessage() throws {
        let world = "https://co.example/w/0123456789abcdefabcd"
        var components = URLComponents(string: "kyo://connect")!
        components.queryItems = [URLQueryItem(name: "world", value: world)]

        let link = try XCTUnwrap(RelationshipLink.incoming(components.url!))
        XCTAssertEqual(link.worldURL.absoluteString, world)
    }

    func testNormalizesSlugCaseAndDropsNothingImplicitly() throws {
        let link = try XCTUnwrap(RelationshipLink.normalized(
            URL(string: "https://CO.EXAMPLE/w/ABCDEF0123456789ABCD")!))
        XCTAssertEqual(link.worldURL.absoluteString,
                       "https://co.example/w/abcdef0123456789abcd")
    }

    func testRejectsLinksThatAreNotExactRelationshipCredentials() {
        let rejected = [
            "http://co.example/w/0123456789abcdefabcd",
            "https://co.example/w/too-short",
            "https://co.example/w/0123456789abcdefabcd/extra",
            "https://co.example/w/0123456789abcdefabcd?leak=yes",
            "https://user:pass@co.example/w/0123456789abcdefabcd",
        ]
        for raw in rejected {
            XCTAssertNil(RelationshipLink.normalized(URL(string: raw)! as URL), raw)
        }
    }

    func testRejectsUnrelatedCustomURLs() {
        XCTAssertNil(RelationshipLink.incoming(URL(string: "kyo://settings")!))
        XCTAssertNil(RelationshipLink.incoming(URL(string: "other://connect?world=x")!))
    }
}
