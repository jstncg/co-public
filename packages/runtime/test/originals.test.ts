import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { OriginalStore } from "../src/originals.ts";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import { CURRENT_SCHEMA_VERSION, SqliteStore } from "../src/store.ts";
import { TenantLifecycleManager } from "../src/tenant-lifecycle.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { testConfig, testHome } from "./helpers.ts";

test("content-addressed originals survive later additive schema revisions", () => {
  const home = testHome();
  const store = new SqliteStore(join(home.path, "runtime.sqlite"));
  const originals = new OriginalStore(store, 1_024);
  try {
    assert.equal(store.schemaVersion(), CURRENT_SCHEMA_VERSION);
    assert.ok(CURRENT_SCHEMA_VERSION >= 53);
    const firstSource = store.appendEvent({ tenantId: "test", stream: "conversation:one", type: "message.received", payload: { text: "[attachment 1: file]" } });
    const secondSource = store.appendEvent({ tenantId: "test", stream: "conversation:two", type: "message.received", payload: { text: "[attachment 1: file]" } });
    const data = Buffer.from("same immutable original bytes");
    const first = originals.preserve({
      tenantId: "test", sourceEventId: firstSource.id, attachmentId: "part-1",
      sourceUri: "https://cdn.example.com/a?token=one", finalUri: "https://cdn.example.com/a?token=one",
      mimeType: "text/plain", filename: "note.txt", data,
    });
    const second = originals.preserve({
      tenantId: "test", sourceEventId: secondSource.id, attachmentId: "part-2",
      sourceUri: "https://cdn.example.com/b?token=two", finalUri: "https://cdn.example.com/b?token=two",
      mimeType: "text/plain", filename: "copy.txt", data,
    });
    assert.equal(first.blobId, second.blobId);
    assert.notEqual(first.id, second.id);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM original_blobs WHERE tenant_id=?").get("test")!.count, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM original_blob_refs WHERE tenant_id=?").get("test")!.count, 2);
    assert.deepEqual(originals.bytes("test", first.id), data);
    assert.equal(originals.bytes("other", first.id), undefined);
    assert.throws(() => originals.preserve({
      tenantId: "other", sourceEventId: firstSource.id, attachmentId: "cross-tenant", sourceUri: "https://example.com/a",
      finalUri: "https://example.com/a", data,
    }), /source event is unavailable|another tenant/);
    assert.throws(() => originals.preserve({
      tenantId: "test", sourceEventId: firstSource.id, attachmentId: "too-large", sourceUri: "https://example.com/a",
      finalUri: "https://example.com/a", data: Buffer.alloc(1_025),
    }), /exceeds 1024 bytes/);
    store.db.prepare("UPDATE original_blobs SET data_base64=? WHERE id=?").run(Buffer.from("tampered").toString("base64"), first.blobId);
    assert.throws(() => originals.bytes("test", first.id), /failed its content hash/);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("a v52 runtime migrates additively to original-byte storage", () => {
  const home = testHome();
  const path = join(home.path, "runtime.sqlite");
  let store = new SqliteStore(path);
  try {
    store.appendEvent({ id: "evt_before_originals", tenantId: "test", stream: "conversation", type: "message.received", payload: { text: "retain me" } });
    store.db.exec(`
      DROP TABLE original_blob_refs;
      DROP TABLE original_blobs;
      DELETE FROM schema_migrations WHERE version=53;
      PRAGMA user_version=52;
    `);
    store.close();
    store = new SqliteStore(path);
    assert.equal(store.schemaVersion(), CURRENT_SCHEMA_VERSION);
    assert.ok(store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=53").get());
    assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='original_blobs'").get());
    assert.ok(store.getEvent("test", "evt_before_originals"));
  } finally {
    store.close();
    home.cleanup();
  }
});

test("attachment fetch preserves exact bytes before interpretation and binds the artifact projection", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  const sourceUrl = "https://cdn.example.com/private/scan.png?token=short-lived";
  const finalUrl = "https://edge.example.com/private/scan.png?token=redirected";
  const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  try {
    const source = runtime.store.appendEvent({
      tenantId: "test", stream: "conversation:test", type: "message.received",
      payload: { text: "[attachment 1: image]", attachments: [{ id: "scan", url: sourceUrl }] },
    });
    const job = runtime.store.enqueueJob("test", "content.enrich", {
      url: sourceUrl, sourceEventId: source.id, attachmentId: "scan", filename: "scan.png", declaredMimeType: "image/png",
    });
    const worker = new RuntimeWorker(runtime, {
      videoAnalyzer: null,
      resourceFetcher: async () => ({ status: 200, headers: { "content-type": "image/png" }, body: data, url: finalUrl }),
    });
    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.store.getJob(job.id, "test")?.status, "completed");
    const original = runtime.originals.forAttachment("test", source.id, "scan");
    assert.ok(original);
    assert.equal(original.sourceUri, sourceUrl);
    assert.equal(original.finalUri, finalUrl);
    assert.deepEqual(runtime.originals.bytes("test", original.id), data);
    const artifact = runtime.store.listEvents("test", { type: "artifact.enriched" })[0];
    assert.equal((artifact!.payload as { originalId?: string }).originalId, original.id);
    assert.equal((artifact!.payload as { coverage?: string }).coverage, "metadata", "preservation does not inflate inspection coverage");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("original bytes participate in exact tenant export, restore, and confirmed deletion", () => {
  const sourceHome = testHome();
  const destinationHome = testHome();
  const sourceStore = new SqliteStore(join(sourceHome.path, "runtime.sqlite"));
  const destinationStore = new SqliteStore(join(destinationHome.path, "runtime.sqlite"));
  try {
    const sourceEvent = sourceStore.appendEvent({ tenantId: "alpha", stream: "conversation", type: "message.received", payload: { text: "portable original" } });
    const originals = new OriginalStore(sourceStore, 1_024);
    const expected = Buffer.from("portable private bytes");
    const original = originals.preserve({
      tenantId: "alpha", sourceEventId: sourceEvent.id, attachmentId: "portable",
      sourceUri: "https://example.com/private?token=original", finalUri: "https://example.com/private?token=original",
      mimeType: "application/octet-stream", filename: "portable.bin", data: expected,
    });
    const sourceLifecycle = new TenantLifecycleManager(sourceStore);
    const bundle = sourceLifecycle.createExport("alpha", "2026-09-05T12:00:00.000Z");
    assert.equal(bundle.tables.find((table) => table.name === "original_blobs")?.rowCount, 1);
    const restored = new TenantLifecycleManager(destinationStore).restoreExport({ tenantId: "alpha", bundle, confirmation: "RESTORE:alpha" });
    assert.equal(restored.restored, true);
    assert.deepEqual(new OriginalStore(destinationStore, 1_024).bytes("alpha", original.id), expected);

    const deletionBundle = sourceLifecycle.createExport("alpha", "2026-09-05T12:01:00.000Z");
    const deleted = sourceLifecycle.deleteFromExport({ tenantId: "alpha", bundle: deletionBundle, confirmation: "DELETE:alpha" });
    assert.equal(deleted.deleted, true);
    assert.equal(sourceStore.db.prepare("SELECT COUNT(*) AS count FROM original_blobs WHERE tenant_id=?").get("alpha")!.count, 0);
    assert.equal(sourceStore.db.prepare("SELECT COUNT(*) AS count FROM original_blob_refs WHERE tenant_id=?").get("alpha")!.count, 0);
  } finally {
    sourceStore.close();
    destinationStore.close();
    sourceHome.cleanup();
    destinationHome.cleanup();
  }
});

test("authenticated original retrieval exposes safe metadata and exact download bytes", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.serverToken = "original-api-secret";
  const runtime = new CoRuntime({ config });
  const server = createRuntimeServer(runtime);
  try {
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "conversation", type: "message.received", payload: { text: "file" } });
    const expected = Buffer.from("download me exactly");
    const original = runtime.originals.preserve({
      tenantId: "test", sourceEventId: source.id, attachmentId: "download",
      sourceUri: "https://cdn.example.com/file.txt?token=must-not-list", finalUri: "https://edge.example.com/file.txt?token=must-not-list",
      mimeType: "text/plain", filename: "saved.txt", data: expected,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${base}/v1/originals`)).status, 401);
    const headers = { authorization: "Bearer original-api-secret" };
    const listed = await fetch(`${base}/v1/originals`, { headers });
    const listing = await listed.json() as Array<{ id: string; sourceUri: string; finalUri: string }>;
    assert.equal(listing[0]?.id, original.id);
    assert.equal(JSON.stringify(listing).includes("must-not-list"), false);
    assert.equal(listing[0]?.sourceUri, "https://cdn.example.com/file.txt");
    const downloaded = await fetch(`${base}/v1/originals/${original.id}/content`, { headers });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "text/plain");
    assert.match(downloaded.headers.get("content-disposition") ?? "", /saved\.txt/);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), expected);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    home.cleanup();
  }
});
