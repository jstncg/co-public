import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DependencyError } from "../src/dependency-errors.ts";
import { CoRuntime } from "../src/runtime.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { testConfig, testHome } from "./helpers.ts";

test("media artifacts are a durable tenant-scoped cache", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const url = "https://youtu.be/abcdefghijk";
    runtime.store.db.prepare(`INSERT INTO artifacts(id,tenant_id,kind,source_uri,title,content,metadata_json,source_event_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      "art_cached", "test", "youtube", url, "Cached video", "TRANSCRIPT\nalready watched",
      JSON.stringify({ pipelineVersion: 3, coverage: "transcript", deferred: true, durationSeconds: 3_600, author: "Maker" }),
      "evt_original", "2026-08-01T00:00:00.000Z",
    );
    const job = runtime.store.enqueueJob("test", "content.enrich", { url, sourceEventId: "evt_share", refresh: false });
    assert.equal(await new RuntimeWorker(runtime).runOnce(), true);
    assert.equal(runtime.store.getJob(job.id, "test")?.status, "completed");
    const artifact = runtime.store.db.prepare("SELECT content,source_event_id FROM artifacts WHERE id='art_cached'").get() as {
      content: string; source_event_id: string;
    };
    assert.equal(artifact.content, "TRANSCRIPT\nalready watched");
    assert.equal(artifact.source_event_id, "evt_original", "a cache hit does not relabel the material source version");
    const enriched = runtime.store.listEvents("test", { type: "artifact.enriched" });
    assert.equal(enriched.length, 1);
    assert.equal((enriched[0]!.payload as { cached?: unknown }).cached, true);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("artifact refresh preserves the migrated prior version and only replaces the latest projection", async () => {
  const home = testHome();
  const url = "https://example.com/living-source";
  const originalMetadata = {
    pipelineVersion: 3, coverage: "fulltext", deferred: false, author: "Original author", revision: 1,
  };
  const bootstrap = new CoRuntime({ config: testConfig(home.path) });
  try {
    bootstrap.store.db.prepare(`INSERT INTO artifacts(
      id,tenant_id,kind,source_uri,title,content,metadata_json,source_event_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      "art_pre_v36", "test", "article", url, "Original title", "Original source content that must survive every refresh.",
      JSON.stringify(originalMetadata), "evt_original", "2026-01-02T03:04:05.000Z",
    );
  } finally {
    bootstrap.close();
  }

  // Reconstruct the durable shape immediately before v36. Opening the current
  // runtime must backfill the existing projection before the worker may change it.
  const legacy = new DatabaseSync(join(home.path, "runtime.sqlite"));
  legacy.exec("PRAGMA foreign_keys=ON; DROP TABLE artifact_versions; DELETE FROM schema_migrations WHERE version=36; PRAGMA user_version=35;");
  legacy.close();

  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const migrated = runtime.store.db.prepare(`SELECT title,content,metadata_json,coverage,source_event_id,created_at
      FROM artifact_versions WHERE tenant_id='test' AND artifact_id='art_pre_v36'`).get() as {
        title: string; content: string; metadata_json: string; coverage: string; source_event_id: string; created_at: string;
      };
    assert.deepEqual({ ...migrated }, {
      title: "Original title",
      content: "Original source content that must survive every refresh.",
      metadata_json: JSON.stringify(originalMetadata),
      coverage: "fulltext",
      source_event_id: "evt_original",
      created_at: "2026-01-02T03:04:05.000Z",
    });

    const share = runtime.store.appendEvent({
      tenantId: "test", stream: "conversation:test", type: "message.received", payload: { text: url },
    });
    const refreshedMetadata = {
      pipelineVersion: 3, coverage: "document", deferred: false, author: "New author", revision: 2,
    };
    const job = runtime.store.enqueueJob("test", "content.enrich", { url, sourceEventId: share.id, refresh: true });
    const worker = new RuntimeWorker(runtime, {
      videoAnalyzer: null,
      contentEnricher: async (requestedUrl) => ({
        kind: "document", url: requestedUrl, title: "Updated title", author: "New author",
        content: "Updated source content is now the latest projection, while the original remains immutable.",
        coverage: "document", deferred: false, metadata: refreshedMetadata,
      }),
    });
    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.store.getJob(job.id, "test")?.status, "completed");

    const latest = runtime.store.db.prepare(`SELECT id,kind,title,content,metadata_json,source_event_id
      FROM artifacts WHERE tenant_id=? AND source_uri=?`).get("test", url) as {
        id: string; kind: string; title: string; content: string; metadata_json: string; source_event_id: string;
      };
    assert.deepEqual({ ...latest }, {
      id: "art_pre_v36", kind: "document", title: "Updated title",
      content: "Updated source content is now the latest projection, while the original remains immutable.",
      metadata_json: JSON.stringify(refreshedMetadata), source_event_id: share.id,
    });

    const versions = runtime.store.db.prepare(`SELECT title,content,metadata_json,coverage,source_event_id
      FROM artifact_versions WHERE tenant_id=? AND artifact_id=? ORDER BY created_at,id`).all("test", "art_pre_v36") as Array<{
        title: string; content: string; metadata_json: string; coverage: string; source_event_id: string;
      }>;
    assert.equal(versions.length, 2);
    assert.deepEqual(versions.map((version) => ({
      title: version.title, content: version.content, metadata: JSON.parse(version.metadata_json), coverage: version.coverage,
      sourceEventId: version.source_event_id,
    })), [
      {
        title: "Original title", content: "Original source content that must survive every refresh.",
        metadata: originalMetadata, coverage: "fulltext", sourceEventId: "evt_original",
      },
      {
        title: "Updated title", content: "Updated source content is now the latest projection, while the original remains immutable.",
        metadata: refreshedMetadata, coverage: "document", sourceEventId: share.id,
      },
    ]);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("terminal content enrichment failure becomes one held repair item", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const url = "https://example.com/unavailable-source?token=private-capability";
    const source = runtime.store.appendEvent({
      tenantId: "test", stream: "conversation:test", type: "message.received",
      payload: { text: "[attachment 1: document]" },
    });
    const job = runtime.store.enqueueJob("test", "content.enrich", {
      url, sourceEventId: source.id,
    }, { maxAttempts: 2 });
    const worker = new RuntimeWorker(runtime, {
      videoAnalyzer: null,
      contentEnricher: async () => {
        throw new DependencyError({
          service: "fixture", kind: "unavailable", message: `fixture source ${url} is unavailable`, retryable: true,
        });
      },
    });

    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.store.getJob(job.id, "test")?.status, "queued");
    runtime.store.db.prepare("UPDATE jobs SET run_after=? WHERE id=?").run(new Date(Date.now() - 1_000).toISOString(), job.id);
    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.store.getJob(job.id, "test")?.status, "failed");

    const failures = runtime.store.listEvents("test", { type: "content.enrichment_failed" });
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0]?.payload, {
      jobId: job.id, url, attempts: 2, maxAttempts: 2,
      error: "fixture source https://example.com/unavailable-source is unavailable", repair: "inspect the source or provider, then explicitly enqueue a refresh",
    });
    const attention = runtime.office.listAttention("test");
    assert.equal(attention.length, 1);
    assert.equal(attention[0]?.title, "Content enrichment needs repair");
    assert.match(attention[0]?.content ?? "", /original link remains available/i);
    assert.equal(`${attention[0]?.content} ${attention[0]?.reason}`.includes("private-capability"), false);
    assert.equal(await worker.runOnce(), false, "a terminal job cannot emit another repair record");
    assert.equal(runtime.store.listEvents("test", { type: "content.enrichment_failed" }).length, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("definitive content enrichment failure is visible without a pointless retry", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const job = runtime.store.enqueueJob("test", "content.enrich", {
      url: "https://example.com/forbidden-source",
    });
    const worker = new RuntimeWorker(runtime, {
      videoAnalyzer: null,
      contentEnricher: async () => {
        throw new DependencyError({
          service: "fixture", kind: "authentication", message: "fixture access denied", retryable: false,
        });
      },
    });

    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.store.getJob(job.id, "test")?.status, "failed");
    assert.equal(runtime.store.getJob(job.id, "test")?.attempts, 1);
    assert.equal(runtime.store.listEvents("test", { type: "content.enrichment_failed" }).length, 1);
    assert.equal(runtime.office.listAttention("test").length, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});
