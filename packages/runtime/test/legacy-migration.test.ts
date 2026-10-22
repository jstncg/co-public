import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { legacyTimestamp, parseLegacyMigrationPlan, prepareLegacyMigration, verifyLegacyMigration, type LegacyMigrationPlan } from "../src/legacy-migration.ts";
import { SqliteStore } from "../src/store.ts";
import { TenantLifecycleManager } from "../src/tenant-lifecycle.ts";
import { testHome } from "./helpers.ts";

test("legacy migration preserves WAL, corrections, supersession and blobs without granting authority", async () => {
  const home = testHome();
  const source = new DatabaseSync(join(home.path, "claims.db"));
  source.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE claims(id INTEGER PRIMARY KEY, statement TEXT, status TEXT, last_verified TEXT, supersedes INTEGER, embedding BLOB);
    CREATE TABLE user_corrections(id INTEGER PRIMARY KEY, claim_id INTEGER, action TEXT, text TEXT, created_at TEXT);
    CREATE TABLE relations(id INTEGER PRIMARY KEY, src INTEGER, dst INTEGER, kind TEXT);
    CREATE TABLE retained_sidecar(id INTEGER PRIMARY KEY, value TEXT);
    INSERT INTO claims VALUES(1,'obsolete blue preference','active','2026-07-01T10:00:00Z',NULL,X'0001FF');
    INSERT INTO claims VALUES(2,'corrected green preference','active','2026-08-01T10:00:00Z',1,NULL);
    INSERT INTO claims VALUES(3,'retracted purple preference','retired','2026-08-01T10:00:00Z',NULL,NULL);
    INSERT INTO claims VALUES(4,'unverified yellow preference','active','2026-08-01T10:00:00Z',NULL,NULL);
    INSERT INTO user_corrections VALUES(1,2,'wrong',NULL,'2026-08-02T10:00:00Z');
    INSERT INTO relations VALUES(1,1,2,'refines');
    INSERT INTO retained_sidecar VALUES(1,'preserve this too');`);
  try {
    const plan: LegacyMigrationPlan = { format: "co.legacy-migration.v1", sources: [
      { id: "claims-one", tenantId: "member-one", format: "claims-sqlite", path: join(home.path, "claims.db") },
    ] };
    const report = await prepareLegacyMigration(plan, join(home.path, "candidate"));
    assert.equal(report.status, "prepared-not-live");
    assert.equal(report.sources[0]?.archivedRecords, 6);
    assert.equal(report.sources[0]?.searchableRecords, 1);
    assert.equal(report.sources[0]?.tables.retained_sidecar, 1);
    assert.equal((await verifyLegacyMigration(join(home.path, "candidate"))).liveCutoverQualified, false);
    const snapshot = new DatabaseSync(report.sources[0]!.snapshot, { readOnly: true });
    assert.equal(snapshot.prepare("SELECT value FROM retained_sidecar").get()?.value, "preserve this too");
    snapshot.close();
    const target = new SqliteStore(report.database);
    try {
      for (const table of ["jobs", "memories", "approvals", "mandates", "runs"]) {
        assert.equal(target.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0);
      }
      assert.equal(target.searchEvidence("member-one", "yellow").length, 0);
      assert.equal(target.searchEvidence("member-one", "yellow", { trustClasses: ["untrusted"] }).length, 1);
      assert.equal(target.searchEvidence("member-one", "green", { trustClasses: ["untrusted"] }).length, 0);
      const event = target.db.prepare("SELECT payload_json FROM events WHERE payload_json LIKE '%obsolete blue%'").get();
      assert.match(String(event?.payload_json), /AAH\//);
      assert.equal(new TenantLifecycleManager(target).audit("member-one").corruptRecords, 0);
    } finally { target.close(); }
    assert.equal(source.prepare("SELECT count(*) AS n FROM claims").get()?.n, 4);
    assert.equal(statSync(join(home.path, "candidate")).mode & 0o777, 0o700);
    assert.equal(statSync(report.sources[0]!.snapshot).mode & 0o777, 0o600);
    await assert.rejects(prepareLegacyMigration(plan, join(home.path, "candidate")), /must not exist/);
  } finally { source.close(); home.cleanup(); }
});

test("historical turns retain duplicates, roles, dates and tenant isolation without replay", async () => {
  const home = testHome();
  try {
    const path = join(home.path, "history.json");
    const original = JSON.stringify([
      { role: "user", content: "orchids", ts: "2026-07-01T12:00:00", transport: "linq" },
      { role: "user", content: "orchids", ts: "2026-07-01T12:00:00", transport: "linq" },
      { role: "assistant", content: "flowers", ts: "2026-07-01T12:01:00Z" },
      { role: "user", content: "ambiguous autumn", ts: "2026-11-01T01:30:00" },
    ]);
    writeFileSync(path, original);
    const report = await prepareLegacyMigration({ format: "co.legacy-migration.v1", sources: [
      { id: "history-one", tenantId: "member-one", path, format: "transcript-json", timestampZone: "America/Los_Angeles" },
    ] }, join(home.path, "candidate"));
    assert.equal(report.sources[0]?.archivedRecords, 4);
    assert.equal(report.sources[0]?.unresolvedTimestamps, 1);
    assert.equal(readFileSync(path, "utf8"), original);
    const target = new SqliteStore(report.database);
    try {
      assert.equal(target.db.prepare("SELECT count(*) AS n FROM evidence").get()?.n, 3);
      assert.equal(target.searchEvidence("different-member", "orchids").length, 0);
      assert.equal(target.searchEvidence("member-one", "orchids")[0]?.observedAt, "2026-07-01T19:00:00.000Z");
      assert.equal(target.db.prepare("SELECT count(*) AS n FROM jobs").get()?.n, 0);
    } finally { target.close(); }
  } finally { home.cleanup(); }
});

test("bad inputs fail closed with sources intact and no success marker", async () => {
  const home = testHome();
  try {
    const path = join(home.path, "history.json");
    writeFileSync(path, "{broken");
    const source = { id: "source", tenantId: "member", path, format: "transcript-json" as const };
    const plan = { format: "co.legacy-migration.v1" as const, sources: [source] };
    const out = join(home.path, "candidate");
    await assert.rejects(prepareLegacyMigration(plan, out));
    assert.ok(existsSync(join(out, "FAILED")));
    assert.ok(!existsSync(join(out, "report.json")));
    assert.equal(readFileSync(join(out, "snapshots/source.snapshot"), "utf8"), "{broken");
    assert.throws(() => parseLegacyMigrationPlan({ ...plan, sources: [source, { ...source, id: "second", tenantId: "other" }] }), /two tenants/);
    symlinkSync(path, join(home.path, "alias"));
    assert.throws(() => parseLegacyMigrationPlan({ ...plan, sources: [{ ...source, path: join(home.path, "alias") }] }), /symlink/);
    assert.throws(() => parseLegacyMigrationPlan({ ...plan, sources: [{ ...source, timestampZone: "not-a-zone" }] }));
  } finally { home.cleanup(); }
});

test("legacy wall clocks require an explicit writer timezone and reject DST gaps and folds", () => {
  assert.equal(legacyTimestamp("2026-07-01T12:00:00"), undefined);
  assert.equal(legacyTimestamp("2026-03-08T02:30:00", "America/Los_Angeles"), undefined);
  assert.equal(legacyTimestamp("2026-11-01T01:30:00", "America/Los_Angeles"), undefined);
  assert.equal(legacyTimestamp("2026-07-01T12:00:00", "Asia/Kolkata"), "2026-07-01T06:30:00.000Z");
  assert.equal(legacyTimestamp("2026-02-30T12:00:00", "UTC"), undefined);
});

test("offline verification rejects changed snapshot bytes and forged evidence attribution", async () => {
  const home = testHome();
  try {
    const path = join(home.path, "history.json");
    writeFileSync(path, JSON.stringify([{ role: "assistant", content: "orchids", ts: "2026-08-01T12:00:00Z" }]));
    const report = await prepareLegacyMigration({ format: "co.legacy-migration.v1", sources: [
      { id: "history", tenantId: "member", path, format: "transcript-json" },
    ] }, join(home.path, "candidate"));
    const db = new DatabaseSync(report.database);
    db.prepare("UPDATE evidence SET trust_class='owner'").run();
    db.close();
    await assert.rejects(verifyLegacyMigration(join(home.path, "candidate")), /attribution mismatch/);
    writeFileSync(report.sources[0]!.snapshot, "changed");
    await assert.rejects(verifyLegacyMigration(join(home.path, "candidate")), /hash mismatch/);
  } finally { home.cleanup(); }
});
