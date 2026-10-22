import XCTest
@testable import Co

final class MasonryTests: XCTestCase {
    private func item(_ id: String, _ ratio: CGFloat) -> FeedItem {
        FeedItem(id: id, kind: .photo, aspectRatio: ratio,
                 imageURL: nil, text: nil, attribution: nil)
    }

    func testBalancesColumnsByHeight() {
        // heights (1/ratio): 2.0, 0.5, 0.5, 0.5
        let items = [item("tall", 0.5), item("a", 2), item("b", 2), item("c", 2)]
        let cols = distributeIntoColumns(items, columns: 2)
        XCTAssertEqual(cols[0].map(\.id), ["tall"])
        XCTAssertEqual(cols[1].map(\.id), ["a", "b", "c"])
    }

    func testPreservesEveryItem() {
        let items = (0..<17).map { item("\($0)", CGFloat($0 % 3 + 1) / 2) }
        let cols = distributeIntoColumns(items, columns: 2)
        XCTAssertEqual(cols.flatMap { $0 }.count, 17)
        XCTAssertEqual(Set(cols.flatMap { $0 }.map(\.id)).count, 17)
    }

    func testEmptyInputStillReturnsColumns() {
        XCTAssertEqual(distributeIntoColumns([], columns: 2).count, 2)
    }

    func testZeroColumnsReturnsEmptyRatherThanCrashing() {
        XCTAssertEqual(distributeIntoColumns([item("a", 1)], columns: 0), [])
    }
}
