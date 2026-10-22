// Outbox.swift — app-group sqlite outbox (GRDB), shared by app + share extension.
//
// goal.md §10.2 / §25.2: the share extension queues work here and completes
// fast; it never depends on network work finishing before it is terminated.
// the app drains the queue with background uploads.

import Foundation
import GRDB

// MARK: - record

struct OutboxItem: Codable, Sendable, FetchableRecord, MutablePersistableRecord {
    static let databaseTableName = "outbox"

    enum State: String, Codable, Sendable {
        case pending, uploading, failed, done
    }

    var id: String
    var createdAt: Date
    var state: String
    var attempts: Int
    var lastError: String?
    /// json-encoded CapturePayload
    var payload: Data

    var stateValue: State { State(rawValue: state) ?? .pending }

    func decodedPayload() throws -> CapturePayload {
        try JSONDecoder().decode(CapturePayload.self, from: payload)
    }
}

// MARK: - outbox

/// thin wrapper over a GRDB `DatabaseQueue` living in the app-group container.
/// GRDB serializes access internally, so this type is safe to share.
final class Outbox: @unchecked Sendable {
    /// PLACEHOLDER id — must match project.yml entitlements and the
    /// real team-registered app group once the Apple account exists.
    static let appGroupID = "group.app.co.shared"

    static let maxAttempts = 5

    let dbQueue: DatabaseQueue
    /// where the share extension writes image/file attachments for the app to upload
    let attachmentsURL: URL

    init() throws {
        let container = Self.containerURL()
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        attachmentsURL = container.appendingPathComponent("Attachments", isDirectory: true)
        try FileManager.default.createDirectory(at: attachmentsURL, withIntermediateDirectories: true)

        dbQueue = try DatabaseQueue(path: container.appendingPathComponent("outbox.sqlite").path)

        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            try db.create(table: OutboxItem.databaseTableName) { t in
                t.primaryKey("id", .text)
                t.column("createdAt", .datetime).notNull()
                t.column("state", .text).notNull().indexed()
                t.column("attempts", .integer).notNull().defaults(to: 0)
                t.column("lastError", .text)
                t.column("payload", .blob).notNull()
            }
        }
        try migrator.migrate(dbQueue)
    }

    /// app-group container; falls back to the process sandbox when the group
    /// is unavailable (e.g. unsigned demo builds). the fallback means app and
    /// extension do NOT share a queue — acceptable only pre-signing.
    private static func containerURL() -> URL {
        if let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupID) {
            return url.appendingPathComponent("Outbox", isDirectory: true)
        }
        // BLOCKED: Apple account — without a signed app group, use local caches.
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Outbox", isDirectory: true)
    }

    // MARK: enqueue / dequeue / retry

    /// queue a capture. returns the outbox row id.
    @discardableResult
    func enqueue(_ payload: CapturePayload) throws -> String {
        let id = UUID().uuidString
        var item = OutboxItem(
            id: id,
            createdAt: .now,
            state: OutboxItem.State.pending.rawValue,
            attempts: 0,
            lastError: nil,
            payload: try JSONEncoder().encode(payload)
        )
        try dbQueue.write { db in try item.insert(db) }
        return id
    }

    /// attach the why-tap answer to an already-queued item (the question is
    /// asked AFTER queuing — goal.md §10.2).
    func attachWhy(itemID: String, answer: String) throws {
        try dbQueue.write { db in
            guard var item = try OutboxItem.fetchOne(db, key: itemID) else { return }
            var payload = try item.decodedPayload()
            payload.whyAnswer = answer
            item.payload = try JSONEncoder().encode(payload)
            try item.update(db)
        }
    }

    /// claim the oldest pending item for upload (marks it `uploading`).
    func dequeue() throws -> OutboxItem? {
        try dbQueue.write { db -> OutboxItem? in
            guard var item = try OutboxItem
                .filter(Column("state") == OutboxItem.State.pending.rawValue)
                .order(Column("createdAt"))
                .fetchOne(db)
            else { return nil }
            item.state = OutboxItem.State.uploading.rawValue
            item.attempts += 1
            try item.update(db)
            return item
        }
    }

    func markDone(itemID: String) throws {
        try setState(itemID: itemID, state: .done, error: nil)
    }

    /// failed items go back to `pending` until maxAttempts, then stick at `failed`.
    func markFailed(itemID: String, error: String) throws {
        try dbQueue.write { db in
            guard var item = try OutboxItem.fetchOne(db, key: itemID) else { return }
            item.lastError = error
            item.state = (item.attempts >= Self.maxAttempts
                          ? OutboxItem.State.failed
                          : OutboxItem.State.pending).rawValue
            try item.update(db)
        }
    }

    /// re-queue everything stuck at `failed` (user-triggered retry).
    func retryFailed() throws {
        try dbQueue.write { db in
            try db.execute(
                sql: "UPDATE outbox SET state = ?, attempts = 0 WHERE state = ?",
                arguments: [OutboxItem.State.pending.rawValue, OutboxItem.State.failed.rawValue]
            )
        }
    }

    func pendingCount() throws -> Int {
        try dbQueue.read { db in
            try OutboxItem
                .filter([OutboxItem.State.pending.rawValue,
                         OutboxItem.State.uploading.rawValue].contains(Column("state")))
                .fetchCount(db)
        }
    }

    private func setState(itemID: String, state: OutboxItem.State, error: String?) throws {
        try dbQueue.write { db in
            guard var item = try OutboxItem.fetchOne(db, key: itemID) else { return }
            item.state = state.rawValue
            item.lastError = error
            try item.update(db)
        }
    }

    /// write attachment data into the shared container; returns the file name
    /// to reference from `CapturePayload.attachmentFilenames`.
    func storeAttachment(_ data: Data, fileExtension: String) throws -> String {
        let name = UUID().uuidString + "." + fileExtension
        try data.write(to: attachmentsURL.appendingPathComponent(name), options: .atomic)
        return name
    }
}
