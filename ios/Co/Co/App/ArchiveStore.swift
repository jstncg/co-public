import Foundation

/// The Archive tab's data. Server buckets become albums; the fixture twin (MockCoAPI) renders
/// the same shelves offline so the screen never depends on a network.
@Observable
@MainActor
final class ArchiveStore {
    private var api: CoAPI

    private(set) var albums: [ArchiveAlbum] = []
    private(set) var hasLoaded = false

    /// The shell injects the member-scoped API. The default is deliberately empty; fixtures require
    /// the explicit `-coFixtures` launch mode.
    init(api: CoAPI = CoAPIEnvironment.current()) {
        self.api = api
    }

    func load() async {
        do {
            let response = try await api.archiveBuckets()
            albums = response.buckets.map(ArchiveAlbum.init(bucket:))
        } catch {
            // Keep the last good data: a failed refresh must not blank the shelf.
        }
        hasLoaded = true
    }

    func connect(to api: CoAPI) async {
        self.api = api
        // Do not carry the demo member's shelves across an identity boundary.
        albums = []
        hasLoaded = false
        await load()
    }
}
