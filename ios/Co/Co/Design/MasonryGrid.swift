import SwiftUI

/// Greedy shortest-column packing. O(n·columns) with columns == 2.
/// ponytail: greedy, not optimal bin-packing — swap in LPT if two columns ever visibly
/// diverge, which at 2 columns they do not.
func distributeIntoColumns<Item>(_ items: [Item], columns: Int,
                                  height: (Item) -> CGFloat) -> [[Item]] {
    guard columns > 0 else { return [] }
    var buckets = Array(repeating: [Item](), count: columns)
    var heights = Array(repeating: CGFloat.zero, count: columns)
    for item in items {
        let shortest = heights.enumerated().min { $0.element < $1.element }?.offset ?? 0
        buckets[shortest].append(item)
        heights[shortest] += height(item)
    }
    return buckets
}

/// FeedItem convenience — height derives from `aspectRatio`, the one caller every existing
/// test and call site already knows. Kept as its own overload (not a default parameter) so
/// this signature and its tests never change shape.
func distributeIntoColumns(_ items: [FeedItem], columns: Int) -> [[FeedItem]] {
    distributeIntoColumns(items, columns: columns) { 1 / max($0.aspectRatio, 0.1) }
}
