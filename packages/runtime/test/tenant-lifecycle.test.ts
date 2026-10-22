import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { LogImporter } from "../src/importer.ts";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import { CURRENT_SCHEMA_VERSION, SqliteStore } from "../src/store.ts";
import {
  TenantLifecycleManager,
  type TenantExportBundleV1,
  type TenantExportBundleV2,
  type TenantExportBundleV3,
  type TenantExportTableV2,
} from "../src/tenant-lifecycle.ts";
import { testConfig, testHome } from "./helpers.ts";

function seedConversation(store: SqliteStore, tenantId: string, marker: string): void {
  const event = store.appendEvent({ tenantId, stream: "conversation", type: "message.received", payload: { text: marker } });
  const session = store.ensureSession(tenantId, "imessage", `+1555${marker.length}`);
  store.addMessage(tenantId, session.id, {
    id: `msg_${tenantId}`, role: "user", parts: [{ type: "text", text: marker }], createdAt: event.at,
  }, event.id);
  store.indexEvidence({ tenantId, sourceEventId: event.id, kind: "conversation.user", trustClass: "owner", content: marker, observedAt: event.at });
  store.db.prepare(`INSERT INTO credential_items(
    id,tenant_id,workspace_id,origin,label,field_names_json,ciphertext,iv,auth_tag,status,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    `cred_${tenantId}`, tenantId, `workspace_${tenantId}`, "https://example.com", `${marker} login`, '["username","password"]',
    `cipher-${marker}`, `iv-${marker}`, `tag-${marker}`, "active", event.at,
  );
}

function seedOwnerEvidence(store: SqliteStore, tenantId: string, text: string, at: string, suffix: string): string {
  const event = store.appendEvent({ tenantId, stream: `conversation:${suffix}`, type: "message.received", payload: { text }, at });
  const session = store.ensureSession(tenantId, "imessage", `owner-${suffix}`);
  store.addMessage(tenantId, session.id, {
    id: `msg_${tenantId}_${suffix}`, role: "user", parts: [{ type: "text", text }], createdAt: at,
  }, event.id);
  store.indexEvidence({
    tenantId, sourceEventId: event.id, kind: "conversation.user", trustClass: "owner", content: text, observedAt: at,
  });
  return event.id;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function recommit<T extends TenantExportBundleV2 | TenantExportBundleV3>(bundle: T): T {
  for (const exportedTable of bundle.tables) {
    const { commitment: _commitment, ...payload } = exportedTable;
    exportedTable.commitment = digest(payload);
  }
  bundle.schemaDigest = digest(bundle.tables.map((exportedTable) => ({
    name: exportedTable.name, columns: exportedTable.columns, redactedColumns: exportedTable.redactedColumns,
  })));
  bundle.stateDigest = digest(bundle.tables.map((exportedTable) => ({
    name: exportedTable.name, rowCount: exportedTable.rowCount, commitment: exportedTable.commitment,
  })));
  if (bundle.format === "co.tenant-export.v3") {
    for (const dependency of bundle.dependencies) {
      const { commitment: _commitment, ...payload } = dependency;
      dependency.commitment = digest(payload);
    }
    bundle.dependenciesDigest = digest({
      schema: bundle.dependencies.map((dependency) => ({
        name: dependency.name, columns: dependency.columns, redactedColumns: dependency.redactedColumns,
      })),
      state: bundle.dependencies.map((dependency) => ({
        name: dependency.name, rowCount: dependency.rowCount, commitment: dependency.commitment,
      })),
    });
  }
  const { digest: _digest, ...payload } = bundle;
  bundle.digest = digest(payload);
  return bundle;
}

function legacyV1(bundle: TenantExportBundleV2 | TenantExportBundleV3): TenantExportBundleV1 {
  const tables = Object.fromEntries(bundle.tables.map((exportedTable) => {
    const visibleColumns = exportedTable.columns.filter((column) => !exportedTable.redactedColumns.includes(column));
    return [exportedTable.name, {
      columns: visibleColumns, rows: exportedTable.rows,
      ...(exportedTable.redactedColumns.length ? { redactedColumns: exportedTable.redactedColumns } : {}),
    }];
  }));
  const payload: Omit<TenantExportBundleV1, "digest"> = {
    format: "co.tenant-export.v1", schemaVersion: bundle.schemaVersion, tenantId: bundle.tenantId,
    generatedAt: bundle.generatedAt, stateDigest: bundle.stateDigest,
    credentialMaterial: "excluded-reenter-at-destination", tables,
  };
  return { ...payload, digest: digest(payload) };
}

function table(bundle: TenantExportBundleV2 | TenantExportBundleV3, name: string): TenantExportTableV2 {
  const found = bundle.tables.find((candidate) => candidate.name === name);
  assert.ok(found, `expected ${name} in export`);
  return found;
}

test("tenant exports are isolated, integrity checked, secret-redacted, and auditable", async () => {
  const home = testHome();
  const store = new SqliteStore(join(home.path, "runtime.sqlite"));
  const lifecycle = new TenantLifecycleManager(store);
  try {
    seedConversation(store, "alpha", "ALPHA_PRIVATE_MARKER");
    seedConversation(store, "beta", "BETA_PRIVATE_MARKER");
    const source = join(home.path, "source-log.txt");
    writeFileSync(source, "alpha source history");
    await new LogImporter(store).importPath("alpha", source);

    const bundle = lifecycle.createExport("alpha", "2026-09-04T00:00:00.000Z");
    assert.equal(bundle.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(bundle.format, "co.tenant-export.v3");
    assert.deepEqual(bundle.tables.map((exportedTable) => exportedTable.name), [...bundle.tables.map((exportedTable) => exportedTable.name)].sort());
    assert.equal(table(bundle, "events").rows.every((row) => row.tenant_id === "alpha"), true);
    assert.match(JSON.stringify(bundle), /ALPHA_PRIVATE_MARKER/);
    assert.doesNotMatch(JSON.stringify(bundle), /BETA_PRIVATE_MARKER|cipher-ALPHA_PRIVATE_MARKER|iv-ALPHA_PRIVATE_MARKER|tag-ALPHA_PRIVATE_MARKER/);
    const credentials = table(bundle, "credential_items");
    assert.deepEqual(credentials.redactedColumns, ["ciphertext", "iv", "auth_tag"]);
    assert.equal("ciphertext" in (credentials.rows[0] ?? {}), false);
    assert.equal(credentials.columns.includes("ciphertext"), true, "the complete schema remains manifest even when values are redacted");
    assert.match(credentials.redactedCommitments.ciphertext?.[0] ?? "", /^[a-f0-9]{64}$/);
    assert.equal(credentials.rowCount, credentials.rows.length);

    const destination = join(home.path, "alpha-export.json");
    lifecycle.writeExport(bundle, destination);
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    assert.equal(lifecycle.readExport(destination).digest, bundle.digest);
    assert.equal(lifecycle.audit("alpha").lifecycle.at(-1)?.operation, "export");

    const tampered = structuredClone(bundle);
    table(tampered, "events").rows.push({ tenant_id: "alpha", payload_json: "tampered" });
    assert.throws(() => lifecycle.verifyExport(tampered), /row count|commitment|digest/);

    store.appendEvent({ tenantId: "alpha", stream: "conversation", type: "message.received", payload: { text: "arrived after export" } });
    assert.throws(() => lifecycle.deleteFromExport({ tenantId: "alpha", bundle, confirmation: "DELETE:alpha" }), /state changed after export/);
    assert.throws(() => lifecycle.deleteFromExport({ tenantId: "alpha", bundle: lifecycle.createExport("alpha"), confirmation: "delete alpha" }), /exact confirmation/);

    const current = lifecycle.createExport("alpha", "2026-09-04T00:01:00.000Z");
    const result = lifecycle.deleteFromExport({ tenantId: "alpha", bundle: current, confirmation: "DELETE:alpha" });
    assert.equal(result.deleted, true);
    assert.ok(Object.values(result.rowCounts).reduce((sum, count) => sum + count, 0) > 0);
    assert.equal(lifecycle.audit("alpha").totalRows, 0);
    assert.equal(lifecycle.audit("alpha").lifecycle.at(-1)?.operation, "delete");
    assert.ok(existsSync(source));
    assert.equal(store.listEvents("beta", { limit: 20 }).some((event) => JSON.stringify(event.payload).includes("BETA_PRIVATE_MARKER")), true);
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("tenant export verification rejects any post-export row or credential-field tampering", () => {
  const home = testHome();
  const store = new SqliteStore(join(home.path, "runtime.sqlite"));
  const lifecycle = new TenantLifecycleManager(store);
  try {
    seedConversation(store, "alpha", "alpha");
    const bundle = lifecycle.createExport("alpha");
    const wrongTenant = structuredClone(bundle);
    const first = table(wrongTenant, "events").rows[0];
    if (first) first.tenant_id = "beta";
    assert.throws(() => lifecycle.verifyExport(wrongTenant), /another tenant|commitment|digest/);

    const exposed = structuredClone(bundle);
    const credentialTable = table(exposed, "credential_items");
    if (credentialTable.rows[0]) credentialTable.rows[0].ciphertext = "do-not-export";
    assert.throws(() => lifecycle.verifyExport(exposed), /invalid columns or order|commitment|digest/);

    const badTableCommitment = structuredClone(bundle);
    table(badTableCommitment, "events").commitment = "0".repeat(64);
    assert.throws(() => lifecycle.verifyExport(badTableCommitment), /commitment does not match/);
    const badSchemaDigest = structuredClone(bundle);
    badSchemaDigest.schemaDigest = "0".repeat(64);
    assert.throws(() => lifecycle.verifyExport(badSchemaDigest), /schema digest does not match/);
    const badOverallDigest = structuredClone(bundle);
    badOverallDigest.digest = "0".repeat(64);
    assert.throws(() => lifecycle.verifyExport(badOverallDigest), /digest does not match/);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("portable v3 restore preserves tenant history and pinned releases without overwriting a destination", async () => {
  const sourceHome = testHome();
  const destinationHome = testHome();
  const sourceConfig = { ...testConfig(sourceHome.path), tenantId: "alpha" };
  const destinationConfig = { ...testConfig(destinationHome.path), tenantId: "alpha" };
  const source = new CoRuntime({ config: sourceConfig });
  let destination: CoRuntime | undefined;
  try {
    const assignment = source.releases.assign("alpha");
    seedConversation(source.store, "alpha", "PORTABLE_HISTORY_MARKER");
    const mandate = source.office.proposeMandate({
      tenantId: "alpha", name: "Portable standard", serviceContract: "Retain one explicit standard across migration.",
    });
    source.office.transitionMandate("alpha", mandate.id, "active");
    for (let day = 1; day <= 4; day += 1) source.store.appendEvent({
      tenantId: "alpha", stream: `portable:historical:${day}`, type: "demo.shipped",
      at: `2023-11-0${day}T00:00:00.000Z`, payload: { historical: true, day },
    });
    const historicalPeakContextId = seedOwnerEvidence(
      source.store, "alpha", "That November demo run made the work feel real.", "2023-11-10T00:00:00.000Z", "portable-historical-context",
    );
    const commitmentId = seedOwnerEvidence(source.store, "alpha", "I will ship three portable demos in 30 days.", "2024-01-02T00:00:00.000Z", "portable-commitment");
    const middleId = seedOwnerEvidence(source.store, "alpha", "Another migration plan is tempting before I ship.", "2024-02-10T00:00:00.000Z", "portable-middle");
    const triggerId = seedOwnerEvidence(source.store, "alpha", "I am considering another migration plan instead of shipping.", "2024-03-20T00:00:00.000Z", "portable-trigger");
    const goal = source.goals.create({
      tenantId: "alpha", objective: "Ship three portable demos", successContract: "Three verified demo.shipped events",
      gateType: "event", gateConfig: { eventType: "demo.shipped", minimumCount: 3, referenceWindowDays: 30 }, maxContinuations: 0,
      sourceEventId: commitmentId, sourceQuote: "I will ship three portable demos in 30 days", standardsMandateId: mandate.id,
    });
    const motiveBundle = source.goals.buildMotiveBundle("alpha", goal.id, triggerId);
    assert.ok(motiveBundle);
    const referencePeakCandidate = [...motiveBundle.referencePeakCandidates.values()][0];
    assert.ok(referencePeakCandidate);
    const motive = source.goals.proposeMotive({
      tenantId: "alpha", goalId: goal.id, hypothesis: "PORTABLE_PRIVATE_MOTIVE may connect planning with unresolved shipping uncertainty.",
      strongestAlternative: "The migration plan is necessary implementation work.",
      falsifier: "Each migration plan is followed by a shipped demo in the same cycle.", originClass: "mixed",
      decisionCues: ["another migration plan"], evidenceEventIds: [historicalPeakContextId, commitmentId, middleId, triggerId],
      substitution: {
        candidate: "Migration planning may be becoming the substitute output.",
        strongestAlternative: "The plan is a necessary part of shipping.",
        falsifier: "Each plan is followed by a shipped demo in the same cycle.",
        decisionCues: ["another migration plan"], evidenceEventIds: [middleId, triggerId], confidence: 0.5,
      },
      referencePeak: {
        candidateId: referencePeakCandidate.candidateId,
        contextEvidenceEventIds: [historicalPeakContextId, triggerId],
        strongestAlternative: "The old demo burst reflected migration urgency rather than the same motive.",
        falsifier: "Ordinary current cycles exceed it without the inferred context.", confidence: 0.4,
      },
      confidence: 0.58, sourceEventId: triggerId, allowedEvidenceEventIds: motiveBundle.allowedEventIds,
    });
    const turn = await source.turn({
      tenantId: "alpha", channel: "cli", peerId: "local", text: "Remember the portable history marker.", externalId: "portable-turn",
    });
    assert.equal(turn.status, "completed");
    const bundle = source.tenantLifecycle.createExport("alpha", "2026-09-04T00:00:00.000Z");
    assert.equal(bundle.format, "co.tenant-export.v3");
    assert.equal(bundle.dependencies.some((dependency) => dependency.name === "release_manifests" && dependency.rowCount > 0), true);
    assert.equal(bundle.dependencies.some((dependency) => dependency.name === "release_rollouts" && dependency.rowCount > 0), true);
    const missingDependency = structuredClone(bundle);
    const rolloutDependency = missingDependency.dependencies.find((dependency) => dependency.name === "release_rollouts") as TenantExportTableV2;
    rolloutDependency.rows.pop();
    rolloutDependency.rowCount = rolloutDependency.rows.length;
    recommit(missingDependency);
    assert.throws(() => source.tenantLifecycle.verifyExport(missingDependency), /dependencies are missing|unavailable release dependency/);
    source.close();

    destination = new CoRuntime({ config: destinationConfig });
    assert.throws(() => destination?.tenantLifecycle.restoreExport({
      tenantId: "alpha", bundle, confirmation: "restore alpha",
    }), /exact confirmation/);
    const report = destination.tenantLifecycle.restoreExport({
      tenantId: "alpha", bundle, confirmation: "RESTORE:alpha",
    });
    assert.equal(report.restored, true);
    assert.ok(report.importedRows > 0);
    assert.ok(report.importedDependencies > 0, "the source rollout replaces the unreferenced fresh-cell rollout when their salts differ");
    assert.equal(report.skippedCredentialHandles, 1);
    const evidenceCount = Number(destination.store.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE tenant_id=?").get("alpha")!.count);
    assert.equal(report.rebuiltSearchRows, evidenceCount);
    assert.equal(destination.store.db.prepare("SELECT COUNT(*) AS count FROM evidence_fts WHERE tenant_id=?").get("alpha")!.count, evidenceCount,
      "restore rebuilds the disposable search projection once instead of importing and duplicating it");
    assert.equal(destination.store.db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT evidence_id FROM evidence_fts WHERE tenant_id=? GROUP BY evidence_id HAVING COUNT(*) != 1
    )`).get("alpha")!.count, 0);
    assert.equal(destination.store.db.prepare("SELECT COUNT(*) AS count FROM credential_items WHERE tenant_id=?").get("alpha")!.count, 0);
    assert.equal(destination.store.listEvents("alpha").some((event) => JSON.stringify(event.payload).includes("PORTABLE_HISTORY_MARKER")), true);
    assert.equal(destination.store.searchEvidence("alpha", "PORTABLE_HISTORY_MARKER", { trustClasses: ["owner"], limit: 5 }).length > 0, true);
    assert.equal(destination.releases.assignmentForRelease("alpha", assignment.release.id).release.digest, assignment.release.digest);
    assert.equal(destination.store.getRun(turn.runId, "alpha")?.releaseId, assignment.release.id);
    const restoredMotive = destination.goals.activeMotive("alpha", goal.id);
    assert.equal(restoredMotive?.id, motive.id);
    assert.equal(restoredMotive?.hypothesis, motive.hypothesis);
    assert.deepEqual(restoredMotive?.evidenceEventIds, motive.evidenceEventIds);
    assert.deepEqual(restoredMotive?.substitution, motive.substitution);
    assert.deepEqual(restoredMotive?.referencePeak, motive.referencePeak);
    assert.deepEqual(destination.store.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(destination.tenantLifecycle.audit("alpha").lifecycle.at(-1)?.operation, "restore");
    assert.throws(() => destination?.tenantLifecycle.restoreExport({
      tenantId: "alpha", bundle, confirmation: "RESTORE:alpha",
    }), /already contains tenant state/);
  } finally {
    try { source.close(); } catch { /* already closed */ }
    destination?.close();
    sourceHome.cleanup();
    destinationHome.cleanup();
  }
});

test("portable restore rechecks an empty target under its immediate write lock", () => {
  const sourceHome = testHome();
  const destinationHome = testHome();
  const sourceStore = new SqliteStore(join(sourceHome.path, "runtime.sqlite"));
  const destinationPath = join(destinationHome.path, "runtime.sqlite");
  const destinationStore = new SqliteStore(destinationPath);
  const competingStore = new SqliteStore(destinationPath);
  try {
    seedConversation(sourceStore, "alpha", "SOURCE_RESTORE_MARKER");
    const bundle = new TenantLifecycleManager(sourceStore).createExport("alpha", "2026-09-04T00:00:00.000Z");
    const lifecycle = new TenantLifecycleManager(destinationStore);
    const transaction = destinationStore.transaction.bind(destinationStore);
    let injected = false;
    destinationStore.transaction = function transactionWithCompetingWrite<T>(operation: () => T): T {
      if (!injected) {
        injected = true;
        competingStore.appendEvent({
          id: "evt_competing_restore_write", tenantId: "alpha", stream: "conversation",
          type: "message.received", payload: { text: "CONCURRENT_DESTINATION_MARKER" },
        });
      }
      return transaction(operation);
    };

    assert.throws(() => lifecycle.restoreExport({
      tenantId: "alpha", bundle, confirmation: "RESTORE:alpha",
    }), /already contains tenant state/);
    const events = destinationStore.listEvents("alpha");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.id, "evt_competing_restore_write");
    assert.equal(events.some((event) => JSON.stringify(event.payload).includes("SOURCE_RESTORE_MARKER")), false,
      "a competing destination write must abort restore rather than merge histories");
  } finally {
    competingStore.close();
    destinationStore.close();
    sourceStore.close();
    sourceHome.cleanup();
    destinationHome.cleanup();
  }
});

test("legacy v1 exports remain readable and auditable but can never authorize deletion", () => {
  const home = testHome();
  const store = new SqliteStore(join(home.path, "runtime.sqlite"));
  const lifecycle = new TenantLifecycleManager(store);
  try {
    seedConversation(store, "alpha", "legacy-readable");
    const legacy = legacyV1(lifecycle.createExport("alpha", "2026-09-03T00:00:00.000Z"));
    assert.equal(lifecycle.verifyExport(legacy).format, "co.tenant-export.v1");
    const destination = join(home.path, "legacy-v1-export.json");
    lifecycle.writeExport(legacy, destination);
    assert.equal(lifecycle.readExport(destination).format, "co.tenant-export.v1");
    assert.equal(lifecycle.audit("alpha").lifecycle.at(-1)?.exportDigest, legacy.digest);
    assert.throws(
      () => lifecycle.deleteFromExport({ tenantId: "alpha", bundle: legacy, confirmation: "DELETE:alpha" }),
      /v1 is retained for audit only/,
    );
    assert.ok(store.listEvents("alpha", { type: "message.received" }).length > 0);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("deletion rejects internally recommitted v3 exports with missing, extra, or reordered schema", () => {
  const home = testHome();
  const store = new SqliteStore(join(home.path, "runtime.sqlite"));
  const lifecycle = new TenantLifecycleManager(store);
  try {
    seedConversation(store, "alpha", "complete-snapshot");
    const original = lifecycle.createExport("alpha", "2026-09-03T00:00:00.000Z");

    const missing = structuredClone(original);
    missing.tables = missing.tables.filter((candidate) => candidate.name !== "events");
    recommit(missing);
    assert.equal(lifecycle.verifyExport(missing).format, "co.tenant-export.v3", "v3 is independently internally verifiable");
    assert.throws(
      () => lifecycle.deleteFromExport({ tenantId: "alpha", bundle: missing, confirmation: "DELETE:alpha" }),
      /table or column manifest does not match/,
    );

    const extra = structuredClone(original);
    extra.tables.push({
      name: "zz_forged", columns: ["tenant_id"], redactedColumns: [], rowCount: 0, rows: [], redactedCommitments: {}, commitment: "0".repeat(64),
    });
    recommit(extra);
    assert.equal(lifecycle.verifyExport(extra).format, "co.tenant-export.v3");
    assert.throws(
      () => lifecycle.deleteFromExport({ tenantId: "alpha", bundle: extra, confirmation: "DELETE:alpha" }),
      /table or column manifest does not match/,
    );

    const reorderedTables = structuredClone(original);
    [reorderedTables.tables[0], reorderedTables.tables[1]] = [reorderedTables.tables[1] as TenantExportTableV2, reorderedTables.tables[0] as TenantExportTableV2];
    recommit(reorderedTables);
    assert.throws(() => lifecycle.verifyExport(reorderedTables), /canonical order/);

    const reorderedColumns = structuredClone(original);
    const events = table(reorderedColumns, "events");
    [events.columns[0], events.columns[1]] = [events.columns[1] as string, events.columns[0] as string];
    for (const row of events.rows) {
      const values = { ...row };
      for (const key of Object.keys(row)) delete row[key];
      for (const column of events.columns) if (column in values) row[column] = values[column] ?? null;
    }
    recommit(reorderedColumns);
    assert.equal(lifecycle.verifyExport(reorderedColumns).format, "co.tenant-export.v3");
    assert.throws(
      () => lifecycle.deleteFromExport({ tenantId: "alpha", bundle: reorderedColumns, confirmation: "DELETE:alpha" }),
      /table or column manifest does not match/,
    );

    const missingColumn = structuredClone(original);
    const missingColumnEvents = table(missingColumn, "events");
    const removedColumn = missingColumnEvents.columns.find((column) => column !== "tenant_id") as string;
    missingColumnEvents.columns = missingColumnEvents.columns.filter((column) => column !== removedColumn);
    for (const row of missingColumnEvents.rows) delete row[removedColumn];
    recommit(missingColumn);
    assert.equal(lifecycle.verifyExport(missingColumn).format, "co.tenant-export.v3");
    assert.throws(
      () => lifecycle.deleteFromExport({ tenantId: "alpha", bundle: missingColumn, confirmation: "DELETE:alpha" }),
      /table or column manifest does not match/,
    );

    const extraColumn = structuredClone(original);
    const extraColumnEvents = table(extraColumn, "events");
    extraColumnEvents.columns.push("forged_column");
    for (const row of extraColumnEvents.rows) row.forged_column = null;
    recommit(extraColumn);
    assert.equal(lifecycle.verifyExport(extraColumn).format, "co.tenant-export.v3");
    assert.throws(
      () => lifecycle.deleteFromExport({ tenantId: "alpha", bundle: extraColumn, confirmation: "DELETE:alpha" }),
      /table or column manifest does not match/,
    );
    assert.ok(store.listEvents("alpha", { type: "message.received" }).length > 0);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("deletion rejects recommitted row order, content, and redacted credential commitments", () => {
  const home = testHome();
  const store = new SqliteStore(join(home.path, "runtime.sqlite"));
  const lifecycle = new TenantLifecycleManager(store);
  try {
    seedConversation(store, "alpha", "row-one");
    store.appendEvent({ tenantId: "alpha", stream: "conversation", type: "message.received", payload: { text: "row two" } });
    const original = lifecycle.createExport("alpha", "2026-09-03T00:00:00.000Z");

    const reorderedRows = structuredClone(original);
    const eventRows = table(reorderedRows, "events").rows;
    assert.ok(eventRows.length >= 2);
    [eventRows[0], eventRows[1]] = [eventRows[1] as typeof eventRows[number], eventRows[0] as typeof eventRows[number]];
    recommit(reorderedRows);
    assert.throws(
      () => lifecycle.deleteFromExport({ tenantId: "alpha", bundle: reorderedRows, confirmation: "DELETE:alpha" }),
      /rows are not in canonical order/,
    );

    const missingRow = structuredClone(original);
    const missingRows = table(missingRow, "events");
    missingRows.rows.pop();
    missingRows.rowCount = missingRows.rows.length;
    recommit(missingRow);
    assert.equal(lifecycle.verifyExport(missingRow).format, "co.tenant-export.v3");
    assert.throws(
      () => lifecycle.deleteFromExport({ tenantId: "alpha", bundle: missingRow, confirmation: "DELETE:alpha" }),
      /state changed after export|not a complete exact snapshot/,
    );

    const extraRow = structuredClone(original);
    const extraRows = table(extraRow, "events");
    const forgedRow = structuredClone(extraRows.rows[0] as typeof extraRows.rows[number]);
    forgedRow.id = "evt_forged_export_row";
    extraRows.rows.push(forgedRow);
    extraRows.rows.sort((left, right) => canonical(left) < canonical(right) ? -1 : canonical(left) > canonical(right) ? 1 : 0);
    extraRows.rowCount = extraRows.rows.length;
    recommit(extraRow);
    assert.equal(lifecycle.verifyExport(extraRow).format, "co.tenant-export.v3");
    assert.throws(
      () => lifecycle.deleteFromExport({ tenantId: "alpha", bundle: extraRow, confirmation: "DELETE:alpha" }),
      /state changed after export|not a complete exact snapshot/,
    );

    const changedRow = structuredClone(original);
    const changedEvent = table(changedRow, "events").rows[0];
    assert.ok(changedEvent);
    changedEvent.stream = "forged";
    table(changedRow, "events").rows.sort((left, right) => canonical(left) < canonical(right) ? -1 : canonical(left) > canonical(right) ? 1 : 0);
    recommit(changedRow);
    assert.equal(lifecycle.verifyExport(changedRow).format, "co.tenant-export.v3");
    assert.throws(
      () => lifecycle.deleteFromExport({ tenantId: "alpha", bundle: changedRow, confirmation: "DELETE:alpha" }),
      /state changed after export|not a complete exact snapshot/,
    );

    const changedSecretCommitment = structuredClone(original);
    const credentialTable = table(changedSecretCommitment, "credential_items");
    const commitments = credentialTable.redactedCommitments.ciphertext;
    assert.ok(commitments?.[0]);
    commitments[0] = "f".repeat(64);
    recommit(changedSecretCommitment);
    assert.equal(lifecycle.verifyExport(changedSecretCommitment).format, "co.tenant-export.v3");
    assert.throws(
      () => lifecycle.deleteFromExport({ tenantId: "alpha", bundle: changedSecretCommitment, confirmation: "DELETE:alpha" }),
      /state changed after export|not a complete exact snapshot/,
    );
    assert.ok(store.listEvents("alpha", { type: "message.received" }).length > 0);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("tenant audit and export APIs are authenticated and never return credential ciphertext", async () => {
  const home = testHome();
  const config = { ...testConfig(home.path), tenantId: "alpha", serverToken: "tenant-lifecycle-token" };
  const runtime = new CoRuntime({ config });
  const server = createRuntimeServer(runtime);
  try {
    seedConversation(runtime.store, "alpha", "API_PRIVATE_MARKER");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/v1/tenant/audit`)).status, 401);
    const headers = { authorization: "Bearer tenant-lifecycle-token" };
    const audit = await (await fetch(`${base}/v1/tenant/audit`, { headers })).json() as { tenantId: string; totalRows: number };
    assert.equal(audit.tenantId, "alpha");
    assert.ok(audit.totalRows > 0);
    const response = await fetch(`${base}/v1/tenant/export`, { headers });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /API_PRIVATE_MARKER/);
    assert.doesNotMatch(body, /cipher-API_PRIVATE_MARKER|iv-API_PRIVATE_MARKER|tag-API_PRIVATE_MARKER/);
    assert.equal(runtime.tenantLifecycle.audit("alpha").lifecycle.at(-1)?.operation, "export");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.shutdown();
    home.cleanup();
  }
});
