import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { id, nowIso, stableId } from "./id.ts";
import { parseReleaseManifest } from "./releases.ts";
import { CURRENT_SCHEMA_VERSION, SqliteStore } from "./store.ts";
import type { JsonObject, JsonValue } from "./types.ts";

type DatabaseValue = string | number | bigint | null | Uint8Array;
type DatabaseRow = Record<string, DatabaseValue>;

export interface TenantExportTableV1 {
  columns: string[];
  rows: JsonObject[];
  redactedColumns?: string[];
}

export interface TenantExportBundleV1 {
  format: "co.tenant-export.v1";
  schemaVersion: number;
  tenantId: string;
  generatedAt: string;
  stateDigest: string;
  credentialMaterial: "excluded-reenter-at-destination";
  tables: Record<string, TenantExportTableV1>;
  digest: string;
}

export interface TenantExportTableV2 {
  name: string;
  /** Complete SQLite column order, including columns whose values are redacted. */
  columns: string[];
  redactedColumns: string[];
  rowCount: number;
  /** Rows retain schema column order but omit redacted values. */
  rows: JsonObject[];
  /** Commitments are aligned with rows and reveal no credential bytes. */
  redactedCommitments: Record<string, string[]>;
  commitment: string;
}

export interface TenantExportBundleV2 {
  format: "co.tenant-export.v2";
  schemaVersion: number;
  tenantId: string;
  generatedAt: string;
  schemaDigest: string;
  stateDigest: string;
  credentialMaterial: "excluded-reenter-at-destination";
  /** Sorted array: table order is part of the schema and state commitments. */
  tables: TenantExportTableV2[];
  digest: string;
}

export interface TenantExportBundleV3 {
  format: "co.tenant-export.v3";
  schemaVersion: number;
  tenantId: string;
  generatedAt: string;
  schemaDigest: string;
  stateDigest: string;
  credentialMaterial: "excluded-reenter-at-destination";
  tables: TenantExportTableV2[];
  /** Content-addressed global rows required to interpret this tenant's pinned
   * behavior history. No unrelated tenant or rollout state is included. */
  dependencies: TenantExportTableV2[];
  dependenciesDigest: string;
  digest: string;
}

export type TenantExportTable = TenantExportTableV1 | TenantExportTableV2;
export type TenantExportBundle = TenantExportBundleV1 | TenantExportBundleV2 | TenantExportBundleV3;

export interface TenantRestoreReport {
  restored: true;
  tenantId: string;
  importedRows: number;
  importedDependencies: number;
  skippedCredentialHandles: number;
  rebuiltSearchRows: number;
  remappedEventSequences: number;
  stateDigest: string;
  auditId: string;
}

export interface TenantAuditState {
  tenantId: string;
  tenantHash: string;
  schemaVersion: number;
  stateDigest: string;
  rowCounts: Record<string, number>;
  totalRows: number;
  lastEventSeq: number;
  corruptRecords: number;
  activeCredentials: number;
  grantedSensors: number;
  activeAgents: number;
  sourceLogPaths: string[];
  lifecycle: Array<{
    id: string;
    operation: "export" | "delete" | "restore";
    exportDigest?: string;
    stateDigest: string;
    schemaVersion: number;
    rowCounts: Record<string, number>;
    occurredAt: string;
  }>;
}

const REDACTED_COLUMNS: Record<string, Set<string>> = {
  credential_items: new Set(["ciphertext", "iv", "auth_tag"]),
};

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: JsonValue): string {
  // These unkeyed hashes are deterministic consistency commitments, not
  // signatures or proof that an untrusted party authored the export.
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function tenantHash(tenantId: string): string {
  return digest(`co:tenant-lifecycle:${tenantId}`);
}

function jsonValue(value: DatabaseValue): JsonValue {
  if (typeof value === "bigint") return { $integer: value.toString() };
  if (value instanceof Uint8Array) return { $base64: Buffer.from(value).toString("base64") };
  return value;
}

function databaseValue(value: JsonValue): DatabaseValue {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.$integer === "string" && /^-?\d+$/.test(value.$integer)) return BigInt(value.$integer);
    if (keys.length === 1 && typeof value.$base64 === "string") return new Uint8Array(Buffer.from(value.$base64, "base64"));
  }
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new Error("Tenant export contains a non-scalar SQLite value");
}

function parseCounts(value: unknown): Record<string, number> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && Number(entry[1]) >= 0));
  } catch {
    return {};
  }
}

function bundlePayload(bundle: Omit<TenantExportBundleV1, "digest"> | Omit<TenantExportBundleV2, "digest"> | Omit<TenantExportBundleV3, "digest">): JsonValue {
  return bundle as unknown as JsonValue;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new Error(`${field} has invalid fields`);
  }
}

function sameOrderedStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function tableSchemaPayload(table: Pick<TenantExportTableV2, "name" | "columns" | "redactedColumns">): JsonValue {
  return { name: table.name, columns: table.columns, redactedColumns: table.redactedColumns };
}

function tableStatePayload(table: Omit<TenantExportTableV2, "commitment">): JsonValue {
  return table as unknown as JsonValue;
}

function schemaDigest(tables: TenantExportTableV2[]): string {
  return digest(tables.map(tableSchemaPayload));
}

function stateDigest(tables: TenantExportTableV2[]): string {
  return digest(tables.map((table) => ({ name: table.name, rowCount: table.rowCount, commitment: table.commitment })));
}

function dependenciesDigest(tables: TenantExportTableV2[]): string {
  return digest({
    schema: tables.map(tableSchemaPayload),
    state: tables.map((table) => ({ name: table.name, rowCount: table.rowCount, commitment: table.commitment })),
  });
}

function redactedValueCommitment(table: string, column: string, rowIndex: number, value: JsonValue): string {
  return digest({ format: "co.redacted-value.v1", table, column, rowIndex, value });
}

function verifyDependencyTable(table: TenantExportTableV2): void {
  const raw = table as unknown as Record<string, unknown>;
  exactKeys(raw, ["name", "columns", "redactedColumns", "rowCount", "rows", "redactedCommitments", "commitment"], `Tenant export dependency ${table.name || "<empty>"}`);
  if (typeof table.name !== "string" || !table.name || !Array.isArray(table.columns) || !Array.isArray(table.redactedColumns)
    || !Number.isSafeInteger(table.rowCount) || table.rowCount < 0 || table.rowCount !== table.rows.length
    || table.redactedColumns.length !== 0 || Object.keys(table.redactedCommitments).length !== 0
    || typeof table.commitment !== "string" || !/^[a-f0-9]{64}$/.test(table.commitment)
    || table.columns.some((column) => typeof column !== "string" || !column)
    || new Set(table.columns).size !== table.columns.length) {
    throw new Error(`Tenant export dependency ${table.name || "<empty>"} is invalid`);
  }
  for (const row of table.rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) || !sameOrderedStrings(Object.keys(row), table.columns)) {
      throw new Error(`Tenant export dependency ${table.name} has a row with invalid columns or order`);
    }
  }
  for (let index = 1; index < table.rows.length; index += 1) {
    if (canonicalJson(table.rows[index - 1] as JsonObject) > canonicalJson(table.rows[index] as JsonObject)) {
      throw new Error(`Tenant export dependency ${table.name} rows are not in canonical order`);
    }
  }
  const { commitment, ...payload } = table;
  if (digest(tableStatePayload(payload)) !== commitment) {
    throw new Error(`Tenant export dependency ${table.name} commitment does not match its contents`);
  }
}

export class TenantLifecycleManager {
  readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  private tenantTables(): Array<{ name: string; columns: string[] }> {
    const tables = this.store.db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'evidence_fts_%'
      ORDER BY name`).all() as Array<{ name: string }>;
    return tables.flatMap(({ name }) => {
      const columns = (this.store.db.prepare(`PRAGMA table_info(${identifier(name)})`).all() as Array<{ name: string }>).map((column) => String(column.name));
      return columns.includes("tenant_id") ? [{ name: String(name), columns }] : [];
    });
  }

  private exportTable(name: string, columns: string[], rows: DatabaseRow[]): TenantExportTableV2 {
    const configuredRedactions = REDACTED_COLUMNS[name] ?? new Set<string>();
    const redactedColumns = columns.filter((column) => configuredRedactions.has(column));
    const visibleColumns = columns.filter((column) => !configuredRedactions.has(column));
    const visibleRow = (row: JsonObject): JsonObject => Object.fromEntries(visibleColumns.map((column) => [column, row[column] ?? null])) as JsonObject;
    const rawRows = rows.map((row) => Object.fromEntries(columns.map((column) => [column, jsonValue(row[column] ?? null)])) as JsonObject)
      .sort((left, right) => {
        const leftKey = canonicalJson(visibleRow(left));
        const rightKey = canonicalJson(visibleRow(right));
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
    const visibleRows = rawRows.map(visibleRow);
    const redactedCommitments = Object.fromEntries(redactedColumns.map((column) => [
      column,
      rawRows.map((row, rowIndex) => redactedValueCommitment(name, column, rowIndex, row[column] ?? null)),
    ]));
    const payload: Omit<TenantExportTableV2, "commitment"> = {
      name, columns, redactedColumns, rowCount: rawRows.length, rows: visibleRows, redactedCommitments,
    };
    return { ...payload, commitment: digest(tableStatePayload(payload)) };
  }

  private dependencySnapshot(tenantId: string): TenantExportTableV2[] {
    const releaseIds = new Set<string>();
    const rolloutIds = new Set<string>();
    const add = (target: Set<string>, value: unknown): void => {
      if (typeof value === "string" && value) target.add(value);
    };
    for (const row of this.store.db.prepare("SELECT rollout_id,release_id FROM release_assignments WHERE tenant_id=?").all(tenantId) as DatabaseRow[]) {
      add(rolloutIds, row.rollout_id); add(releaseIds, row.release_id);
    }
    for (const row of this.store.db.prepare("SELECT rollout_id,release_id FROM runs WHERE tenant_id=?").all(tenantId) as DatabaseRow[]) {
      add(rolloutIds, row.rollout_id); add(releaseIds, row.release_id);
    }
    for (const table of ["jobs", "scouts"] as const) {
      for (const row of this.store.db.prepare(`SELECT release_id FROM ${identifier(table)} WHERE tenant_id=?`).all(tenantId) as DatabaseRow[]) {
        add(releaseIds, row.release_id);
      }
    }
    const rolloutRows = rolloutIds.size
      ? this.store.db.prepare(`SELECT * FROM release_rollouts WHERE id IN (${[...rolloutIds].map(() => "?").join(",")})`)
        .all(...rolloutIds) as DatabaseRow[]
      : [];
    for (const row of rolloutRows) {
      add(releaseIds, row.stable_release_id); add(releaseIds, row.candidate_release_id); add(releaseIds, row.rollback_release_id);
    }
    const manifestRows = releaseIds.size
      ? this.store.db.prepare(`SELECT * FROM release_manifests WHERE id IN (${[...releaseIds].map(() => "?").join(",")})`)
        .all(...releaseIds) as DatabaseRow[]
      : [];
    if (manifestRows.length !== releaseIds.size || rolloutRows.length !== rolloutIds.size) {
      throw new Error("Tenant behavior history references missing global release dependencies");
    }
    return [
      this.exportTable("release_manifests", (this.store.db.prepare("PRAGMA table_info(release_manifests)").all() as Array<{ name: string }>).map((column) => column.name), manifestRows),
      this.exportTable("release_rollouts", (this.store.db.prepare("PRAGMA table_info(release_rollouts)").all() as Array<{ name: string }>).map((column) => column.name), rolloutRows),
    ];
  }

  private snapshot(tenantId: string): {
    tables: TenantExportTableV2[];
    rowCounts: Record<string, number>;
    schemaDigest: string;
    stateDigest: string;
  } {
    if (!tenantId.trim()) throw new Error("Tenant ID is required");
    const tables: TenantExportTableV2[] = [];
    const rowCounts: Record<string, number> = {};
    for (const table of this.tenantTables()) {
      const rows = this.store.db.prepare(`SELECT * FROM ${identifier(table.name)} WHERE tenant_id=? ORDER BY rowid`).all(tenantId) as DatabaseRow[];
      const exported = this.exportTable(table.name, table.columns, rows);
      tables.push(exported);
      rowCounts[table.name] = exported.rowCount;
    }
    return { tables, rowCounts, schemaDigest: schemaDigest(tables), stateDigest: stateDigest(tables) };
  }

  createExport(tenantId: string, at = nowIso()): TenantExportBundleV3 {
    return this.store.transaction(() => {
      const snapshot = this.snapshot(tenantId);
      const dependencies = this.dependencySnapshot(tenantId);
      const payload: Omit<TenantExportBundleV3, "digest"> = {
        format: "co.tenant-export.v3",
        schemaVersion: this.store.schemaVersion(),
        tenantId,
        generatedAt: at,
        schemaDigest: snapshot.schemaDigest,
        stateDigest: snapshot.stateDigest,
        credentialMaterial: "excluded-reenter-at-destination",
        tables: snapshot.tables,
        dependencies,
        dependenciesDigest: dependenciesDigest(dependencies),
      };
      return { ...payload, digest: digest(bundlePayload(payload)) };
    });
  }

  writeExport(bundle: TenantExportBundle, path: string): string {
    this.verifyExport(bundle);
    const destination = resolve(path);
    writeFileSync(destination, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    this.recordExport(bundle);
    return destination;
  }

  recordExport(bundle: TenantExportBundle): void {
    const verified = this.verifyExport(bundle);
    const rowCounts = verified.format === "co.tenant-export.v2" || verified.format === "co.tenant-export.v3"
      ? Object.fromEntries(verified.tables.map((table) => [table.name, table.rowCount]))
      : Object.fromEntries(Object.entries(verified.tables).map(([name, table]) => [name, table.rows.length]));
    this.record("export", verified.tenantId, verified.stateDigest, verified.digest,
      rowCounts, verified.schemaVersion);
  }

  readExport(path: string): TenantExportBundle {
    const parsed: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
    return this.verifyExport(parsed);
  }

  verifyExport(value: unknown): TenantExportBundle {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tenant export must be an object");
    const raw = value as Record<string, unknown>;
    if (raw.format === "co.tenant-export.v3") return this.verifyExportV3(raw);
    if (raw.format === "co.tenant-export.v2") return this.verifyExportV2(raw);
    return this.verifyExportV1(raw);
  }

  private verifyExportV1(raw: Record<string, unknown>): TenantExportBundleV1 {
    const allowed = new Set(["format", "schemaVersion", "tenantId", "generatedAt", "stateDigest", "credentialMaterial", "tables", "digest"]);
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length) throw new Error(`Tenant export contains unknown fields: ${unknown.join(", ")}`);
    if (raw.format !== "co.tenant-export.v1" || raw.credentialMaterial !== "excluded-reenter-at-destination"
      || typeof raw.tenantId !== "string" || !raw.tenantId || typeof raw.generatedAt !== "string"
      || !Number.isSafeInteger(raw.schemaVersion) || Number(raw.schemaVersion) < 1
      || typeof raw.stateDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.stateDigest)
      || typeof raw.digest !== "string" || !/^[a-f0-9]{64}$/.test(raw.digest)
      || !raw.tables || typeof raw.tables !== "object" || Array.isArray(raw.tables)) {
      throw new Error("Tenant export header is invalid");
    }
    const bundle = raw as unknown as TenantExportBundleV1;
    const { digest: supplied, ...payload } = bundle;
    if (digest(bundlePayload(payload)) !== supplied) throw new Error("Tenant export digest does not match its contents");
    for (const [name, table] of Object.entries(bundle.tables)) {
      if (!name || !table || typeof table !== "object" || !Array.isArray(table.columns) || !Array.isArray(table.rows)
        || !table.columns.every((column) => typeof column === "string")
        || !table.rows.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) {
        throw new Error(`Tenant export table ${name || "<empty>"} is invalid`);
      }
      if (table.rows.some((row) => row.tenant_id !== bundle.tenantId)) throw new Error(`Tenant export table ${name} contains another tenant`);
      if (name === "credential_items" && ["ciphertext", "iv", "auth_tag"].some((column) => table.columns.includes(column) || table.rows.some((row) => column in row))) {
        throw new Error("Tenant export exposes credential material");
      }
    }
    return bundle;
  }

  private verifyExportV2(raw: Record<string, unknown>): TenantExportBundleV2 {
    exactKeys(raw, ["format", "schemaVersion", "tenantId", "generatedAt", "schemaDigest", "stateDigest", "credentialMaterial", "tables", "digest"], "Tenant export");
    if (raw.format !== "co.tenant-export.v2" || raw.credentialMaterial !== "excluded-reenter-at-destination"
      || typeof raw.tenantId !== "string" || !raw.tenantId || typeof raw.generatedAt !== "string" || !Number.isFinite(Date.parse(raw.generatedAt))
      || !Number.isSafeInteger(raw.schemaVersion) || Number(raw.schemaVersion) < 1
      || typeof raw.schemaDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.schemaDigest)
      || typeof raw.stateDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.stateDigest)
      || typeof raw.digest !== "string" || !/^[a-f0-9]{64}$/.test(raw.digest)
      || !Array.isArray(raw.tables)) {
      throw new Error("Tenant export v2 header is invalid");
    }
    const bundle = raw as unknown as TenantExportBundleV2;
    const names = bundle.tables.map((table) => table && typeof table === "object" ? table.name : undefined);
    const validNames = names.filter((name): name is string => typeof name === "string" && Boolean(name));
    if (validNames.length !== names.length || new Set(validNames).size !== validNames.length
      || !sameOrderedStrings(validNames, [...validNames].sort())) {
      throw new Error("Tenant export v2 tables must have unique names in canonical order");
    }
    for (const table of bundle.tables) {
      const tableRaw = table as unknown as Record<string, unknown>;
      exactKeys(tableRaw, ["name", "columns", "redactedColumns", "rowCount", "rows", "redactedCommitments", "commitment"], `Tenant export table ${table.name || "<empty>"}`);
      if (typeof table.name !== "string" || !table.name || !Array.isArray(table.columns) || !Array.isArray(table.redactedColumns)
        || !Number.isSafeInteger(table.rowCount) || table.rowCount < 0 || !Array.isArray(table.rows)
        || !table.redactedCommitments || typeof table.redactedCommitments !== "object" || Array.isArray(table.redactedCommitments)
        || typeof table.commitment !== "string" || !/^[a-f0-9]{64}$/.test(table.commitment)) {
        throw new Error(`Tenant export table ${table.name || "<empty>"} is invalid`);
      }
      if (table.columns.some((column) => typeof column !== "string" || !column)
        || new Set(table.columns).size !== table.columns.length
        || table.redactedColumns.some((column) => typeof column !== "string" || !table.columns.includes(column))
        || new Set(table.redactedColumns).size !== table.redactedColumns.length) {
        throw new Error(`Tenant export table ${table.name} has invalid columns`);
      }
      const expectedRedactions = table.columns.filter((column) => (REDACTED_COLUMNS[table.name] ?? new Set<string>()).has(column));
      if (!sameOrderedStrings(table.redactedColumns, expectedRedactions)) throw new Error(`Tenant export table ${table.name} has invalid redacted columns`);
      if (table.rowCount !== table.rows.length) throw new Error(`Tenant export table ${table.name} row count does not match its rows`);
      const visibleColumns = table.columns.filter((column) => !table.redactedColumns.includes(column));
      for (const row of table.rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)
          || !sameOrderedStrings(Object.keys(row), visibleColumns)) {
          throw new Error(`Tenant export table ${table.name} has a row with invalid columns or order`);
        }
        if (row.tenant_id !== bundle.tenantId) throw new Error(`Tenant export table ${table.name} contains another tenant`);
      }
      for (let index = 1; index < table.rows.length; index += 1) {
        if (canonicalJson(table.rows[index - 1] as JsonObject) > canonicalJson(table.rows[index] as JsonObject)) {
          throw new Error(`Tenant export table ${table.name} rows are not in canonical order`);
        }
      }
      const redacted = table.redactedCommitments as Record<string, unknown>;
      if (!sameOrderedStrings(Object.keys(redacted), table.redactedColumns)) {
        throw new Error(`Tenant export table ${table.name} has invalid redacted commitments`);
      }
      for (const column of table.redactedColumns) {
        const commitments = redacted[column];
        if (!Array.isArray(commitments) || commitments.length !== table.rowCount
          || commitments.some((commitment) => typeof commitment !== "string" || !/^[a-f0-9]{64}$/.test(commitment))) {
          throw new Error(`Tenant export table ${table.name} has invalid ${column} commitments`);
        }
      }
      const { commitment: suppliedCommitment, ...tablePayload } = table;
      if (digest(tableStatePayload(tablePayload)) !== suppliedCommitment) {
        throw new Error(`Tenant export table ${table.name} commitment does not match its contents`);
      }
    }
    if (schemaDigest(bundle.tables) !== bundle.schemaDigest) throw new Error("Tenant export schema digest does not match its table manifest");
    if (stateDigest(bundle.tables) !== bundle.stateDigest) throw new Error("Tenant export state digest does not match its tables");
    const { digest: supplied, ...payload } = bundle;
    if (digest(bundlePayload(payload)) !== supplied) throw new Error("Tenant export digest does not match its contents");
    return bundle;
  }

  private verifyExportV3(raw: Record<string, unknown>): TenantExportBundleV3 {
    exactKeys(raw, [
      "format", "schemaVersion", "tenantId", "generatedAt", "schemaDigest", "stateDigest",
      "credentialMaterial", "tables", "dependencies", "dependenciesDigest", "digest",
    ], "Tenant export");
    if (raw.format !== "co.tenant-export.v3" || raw.credentialMaterial !== "excluded-reenter-at-destination"
      || typeof raw.tenantId !== "string" || !raw.tenantId || typeof raw.generatedAt !== "string" || !Number.isFinite(Date.parse(raw.generatedAt))
      || !Number.isSafeInteger(raw.schemaVersion) || Number(raw.schemaVersion) < 1
      || typeof raw.schemaDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.schemaDigest)
      || typeof raw.stateDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.stateDigest)
      || typeof raw.dependenciesDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.dependenciesDigest)
      || typeof raw.digest !== "string" || !/^[a-f0-9]{64}$/.test(raw.digest)
      || !Array.isArray(raw.tables) || !Array.isArray(raw.dependencies)) {
      throw new Error("Tenant export v3 header is invalid");
    }
    const bundle = raw as unknown as TenantExportBundleV3;
    // Reuse the complete v2 tenant-table validator without weakening either
    // format's closed header contract.
    const v2Payload: Omit<TenantExportBundleV2, "digest"> = {
      format: "co.tenant-export.v2", schemaVersion: bundle.schemaVersion, tenantId: bundle.tenantId,
      generatedAt: bundle.generatedAt, schemaDigest: bundle.schemaDigest, stateDigest: bundle.stateDigest,
      credentialMaterial: bundle.credentialMaterial, tables: bundle.tables,
    };
    this.verifyExportV2({ ...v2Payload, digest: digest(bundlePayload(v2Payload)) } as unknown as Record<string, unknown>);
    const dependencyNames = bundle.dependencies.map((table) => table.name);
    if (!sameOrderedStrings(dependencyNames, ["release_manifests", "release_rollouts"])) {
      throw new Error("Tenant export v3 has an invalid release dependency manifest");
    }
    for (const table of bundle.dependencies) verifyDependencyTable(table);
    if (dependenciesDigest(bundle.dependencies) !== bundle.dependenciesDigest) {
      throw new Error("Tenant export dependency digest does not match its tables");
    }
    const manifests = bundle.dependencies[0] as TenantExportTableV2;
    const rollouts = bundle.dependencies[1] as TenantExportTableV2;
    const releaseIds = new Set<string>();
    for (const row of manifests.rows) {
      const manifestText = row.manifest_json;
      if (typeof row.id !== "string" || typeof row.distribution_id !== "string" || typeof row.label !== "string"
        || typeof manifestText !== "string" || typeof row.manifest_digest !== "string") {
        throw new Error("Tenant export contains malformed release metadata");
      }
      let parsed: unknown;
      try { parsed = JSON.parse(manifestText); } catch { throw new Error(`Tenant export release ${row.id} has corrupt manifest JSON`); }
      const manifest = parseReleaseManifest(parsed);
      const manifestDigest = digest(manifest as unknown as JsonValue);
      if (manifestDigest !== row.manifest_digest || manifest.distributionId !== row.distribution_id || manifest.label !== row.label
        || stableId("release", `${manifest.distributionId}:${manifestDigest}`) !== row.id) {
        throw new Error(`Tenant export release ${row.id} failed its content binding`);
      }
      if (releaseIds.has(row.id)) throw new Error(`Tenant export contains duplicate release ${row.id}`);
      releaseIds.add(row.id);
    }
    const rolloutIds = new Set<string>();
    for (const row of rollouts.rows) {
      if (typeof row.id !== "string" || typeof row.distribution_id !== "string" || typeof row.stable_release_id !== "string"
        || !releaseIds.has(row.stable_release_id)
        || (row.candidate_release_id !== null && (typeof row.candidate_release_id !== "string" || !releaseIds.has(row.candidate_release_id)))
        || (row.rollback_release_id !== null && (typeof row.rollback_release_id !== "string" || !releaseIds.has(row.rollback_release_id)))) {
        throw new Error("Tenant export rollout references an unavailable release dependency");
      }
      if (rolloutIds.has(row.id)) throw new Error(`Tenant export contains duplicate rollout ${row.id}`);
      rolloutIds.add(row.id);
    }
    const expectedRolloutIds = new Set<string>();
    const expectedReleaseIds = new Set<string>();
    for (const row of bundle.tables.find((table) => table.name === "release_assignments")?.rows ?? []) {
      if (typeof row.rollout_id === "string") expectedRolloutIds.add(row.rollout_id);
      if (typeof row.release_id === "string") expectedReleaseIds.add(row.release_id);
    }
    for (const row of bundle.tables.find((table) => table.name === "runs")?.rows ?? []) {
      if (typeof row.rollout_id === "string") expectedRolloutIds.add(row.rollout_id);
      if (typeof row.release_id === "string") expectedReleaseIds.add(row.release_id);
    }
    for (const tableName of ["jobs", "scouts"] as const) {
      for (const row of bundle.tables.find((table) => table.name === tableName)?.rows ?? []) {
        if (typeof row.release_id === "string") expectedReleaseIds.add(row.release_id);
      }
    }
    for (const row of rollouts.rows) {
      if (typeof row.stable_release_id === "string") expectedReleaseIds.add(row.stable_release_id);
      if (typeof row.candidate_release_id === "string") expectedReleaseIds.add(row.candidate_release_id);
      if (typeof row.rollback_release_id === "string") expectedReleaseIds.add(row.rollback_release_id);
    }
    if (expectedRolloutIds.size !== rolloutIds.size || [...expectedRolloutIds].some((releaseId) => !rolloutIds.has(releaseId))
      || expectedReleaseIds.size !== releaseIds.size || [...expectedReleaseIds].some((releaseId) => !releaseIds.has(releaseId))) {
      throw new Error("Tenant export release dependencies are missing or exceed the exact tenant-referenced closure");
    }
    const { digest: supplied, ...payload } = bundle;
    if (digest(bundlePayload(payload)) !== supplied) throw new Error("Tenant export digest does not match its contents");
    return bundle;
  }

  restoreExport(input: { tenantId: string; bundle: TenantExportBundle; confirmation: string }): TenantRestoreReport {
    const verified = this.verifyExport(input.bundle);
    if (verified.format !== "co.tenant-export.v3") {
      throw new Error("Only a portable tenant export v3 can be restored; v1 and v2 remain valid audit/deletion records");
    }
    if (input.confirmation !== `RESTORE:${input.tenantId}`) {
      throw new Error(`Restore requires the exact confirmation RESTORE:${input.tenantId}`);
    }
    if (verified.tenantId !== input.tenantId) throw new Error("Tenant export belongs to a different tenant");
    if (verified.schemaVersion !== CURRENT_SCHEMA_VERSION || this.store.schemaVersion() !== CURRENT_SCHEMA_VERSION) {
      throw new Error("Tenant export and runtime schema must both be current before restore");
    }
    const skippedCredentialHandles = verified.tables.find((table) => table.name === "credential_items")?.rowCount ?? 0;
    let importedRows = 0;
    let importedDependencies = 0;
    let remappedEventSequences = 0;
    return this.store.transaction(() => {
      // The empty-target and schema checks belong under the same immediate
      // write lock as import. Checking before BEGIN IMMEDIATE leaves a window
      // in which another process can add tenant rows and turn restore into an
      // accidental merge.
      const current = this.snapshot(input.tenantId);
      if (Object.values(current.rowCounts).some((count) => count !== 0)) {
        throw new Error("Restore target already contains tenant state; merge and overwrite are intentionally unsupported");
      }
      if (current.schemaDigest !== verified.schemaDigest
        || current.tables.length !== verified.tables.length
        || current.tables.some((table, index) => {
          const exported = verified.tables[index];
          return !exported || table.name !== exported.name || !sameOrderedStrings(table.columns, exported.columns);
        })) {
        throw new Error("Tenant export table or column manifest does not match the destination schema");
      }
      for (const dependency of verified.dependencies) {
        const destinationColumns = (this.store.db.prepare(`PRAGMA table_info(${identifier(dependency.name)})`).all() as Array<{ name: string }>)
          .map((column) => String(column.name));
        if (!sameOrderedStrings(destinationColumns, dependency.columns)) {
          throw new Error(`Tenant export dependency ${dependency.name} does not match the destination schema`);
        }
      }
      this.store.db.exec("PRAGMA defer_foreign_keys=ON");
      importedDependencies = this.installReleaseDependencies(verified.dependencies);
      for (const table of verified.tables) {
        // Credential rows cannot be reconstructed without their deliberately
        // omitted ciphertext. FTS is a disposable projection and must be
        // rebuilt exactly once from canonical evidence, never imported and
        // then appended to a second time.
        if (table.name === "credential_items" || table.name === "evidence_fts") continue;
        const columns = table.name === "events" ? table.columns.filter((column) => column !== "seq") : table.columns;
        const statement = columns.length
          ? this.store.db.prepare(`INSERT INTO ${identifier(table.name)}(${columns.map(identifier).join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
          : undefined;
        const rows = table.name === "events"
          ? [...table.rows].sort((left, right) => Number(left.seq) - Number(right.seq))
          : table.rows;
        for (const row of rows) {
          if (!statement) throw new Error(`Tenant export table ${table.name} has no insertable columns`);
          statement.run(...columns.map((column) => databaseValue(row[column] ?? null)));
          importedRows += 1;
          if (table.name === "events") remappedEventSequences += 1;
        }
      }
      const evidenceRows = verified.tables.find((table) => table.name === "evidence")?.rows ?? [];
      // Event sequences are database-local. Rebind source watermarks by the
      // preserved event identity, just as the events themselves are remapped.
      const exportedEventIds = new Map((verified.tables.find((table) => table.name === "events")?.rows ?? [])
        .map((row) => [Number(row.seq), row.id]));
      for (const scout of verified.tables.find((table) => table.name === "scouts")?.rows ?? []) {
        if (scout.last_source_seq === 0) continue;
        const eventId = exportedEventIds.get(Number(scout.last_source_seq));
        if (typeof eventId !== "string") throw new Error("Scout watermark references an unavailable tenant event");
        const event = this.store.db.prepare("SELECT seq FROM events WHERE tenant_id=? AND id=?").get(input.tenantId, eventId) as DatabaseRow | undefined;
        if (!event) throw new Error("Scout watermark event was not restored");
        this.store.db.prepare("UPDATE scouts SET last_source_seq=? WHERE tenant_id=? AND id=?")
          .run(Number(event.seq), input.tenantId, String(scout.id));
      }
      const ftsInsert = this.store.db.prepare("INSERT INTO evidence_fts(evidence_id,tenant_id,content) VALUES(?,?,?)");
      for (const row of evidenceRows) {
        if (typeof row.id === "string" && typeof row.content === "string") ftsInsert.run(row.id, input.tenantId, row.content);
      }
      const violations = this.store.db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length) throw new Error(`Restored tenant violates ${violations.length} foreign-key constraints`);
      const expectedImportedRows = verified.tables.reduce((sum, table) => sum
        + (table.name === "credential_items" || table.name === "evidence_fts" ? 0 : table.rowCount), 0);
      if (importedRows !== expectedImportedRows) throw new Error("Tenant restore row count does not match the verified export");
      const restored = this.snapshot(input.tenantId);
      const auditId = id("tda");
      this.record("restore", input.tenantId, restored.stateDigest, verified.digest, restored.rowCounts, this.store.schemaVersion(), auditId);
      return {
        restored: true as const, tenantId: input.tenantId, importedRows, importedDependencies, skippedCredentialHandles,
        rebuiltSearchRows: evidenceRows.length, remappedEventSequences, stateDigest: restored.stateDigest, auditId,
      };
    });
  }

  private installReleaseDependencies(dependencies: TenantExportTableV2[]): number {
    const manifests = dependencies.find((table) => table.name === "release_manifests") as TenantExportTableV2;
    const rollouts = dependencies.find((table) => table.name === "release_rollouts") as TenantExportTableV2;
    let installed = 0;
    const manifestInsert = this.store.db.prepare(`INSERT INTO release_manifests(
      ${manifests.columns.map(identifier).join(",")}) VALUES(${manifests.columns.map(() => "?").join(",")})`);
    for (const row of manifests.rows) {
      const existing = this.store.db.prepare("SELECT * FROM release_manifests WHERE id=?").get(row.id as string) as DatabaseRow | undefined;
      if (existing) {
        const semanticColumns = manifests.columns.filter((column) => column !== "created_at");
        const differs = semanticColumns.some((column) => canonicalJson(jsonValue(existing[column] ?? null)) !== canonicalJson(row[column] ?? null));
        if (differs) throw new Error(`Destination release ${String(row.id)} conflicts with the portable export`);
        continue;
      }
      manifestInsert.run(...manifests.columns.map((column) => databaseValue(row[column] ?? null)));
      installed += 1;
    }

    const sourceRolloutIds = new Set(rollouts.rows.map((row) => String(row.id)));
    const rolloutReferenced = (rolloutId: string): boolean => Boolean(
      this.store.db.prepare("SELECT 1 FROM release_assignments WHERE rollout_id=? LIMIT 1").get(rolloutId)
      || this.store.db.prepare("SELECT 1 FROM runs WHERE rollout_id=? LIMIT 1").get(rolloutId),
    );
    for (const row of rollouts.rows) {
      const rolloutId = String(row.id);
      const existing = this.store.db.prepare("SELECT * FROM release_rollouts WHERE id=?").get(rolloutId) as DatabaseRow | undefined;
      if (!existing) continue;
      const same = rollouts.columns.every((column) => canonicalJson(jsonValue(existing[column] ?? null)) === canonicalJson(row[column] ?? null));
      if (same) continue;
      if (rolloutReferenced(rolloutId)) throw new Error(`Destination rollout ${rolloutId} is already referenced with different history`);
      this.store.db.prepare("DELETE FROM release_rollouts WHERE id=?").run(rolloutId);
    }
    for (const row of rollouts.rows) {
      if (row.status !== "active") continue;
      const conflicting = this.store.db.prepare(`SELECT id FROM release_rollouts
        WHERE distribution_id=? AND status='active' AND id!=?`).get(row.distribution_id as string, row.id as string) as { id: string } | undefined;
      if (!conflicting || sourceRolloutIds.has(String(conflicting.id))) continue;
      if (rolloutReferenced(String(conflicting.id))) {
        throw new Error(`Destination distribution ${String(row.distribution_id)} already has a referenced active rollout`);
      }
      this.store.db.prepare("DELETE FROM release_rollouts WHERE id=?").run(conflicting.id);
    }
    const rolloutInsert = this.store.db.prepare(`INSERT OR IGNORE INTO release_rollouts(
      ${rollouts.columns.map(identifier).join(",")}) VALUES(${rollouts.columns.map(() => "?").join(",")})`);
    for (const row of rollouts.rows) {
      const inserted = rolloutInsert.run(...rollouts.columns.map((column) => databaseValue(row[column] ?? null)));
      installed += Number(inserted.changes);
    }
    return installed;
  }

  audit(tenantId: string): TenantAuditState {
    const snapshot = this.store.transaction(() => this.snapshot(tenantId));
    const scalar = (sql: string): number => Number((this.store.db.prepare(sql).get(tenantId) as { count: number }).count ?? 0);
    const last = this.store.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE tenant_id=?").get(tenantId) as { seq: number };
    const paths = this.store.db.prepare("SELECT DISTINCT source_path FROM imports WHERE tenant_id=? ORDER BY source_path").all(tenantId) as Array<{ source_path: string }>;
    const hash = tenantHash(tenantId);
    const lifecycle = (this.store.db.prepare("SELECT * FROM tenant_lifecycle_audit WHERE tenant_hash=? ORDER BY occurred_at,id").all(hash) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), operation: String(row.operation) as "export" | "delete" | "restore",
      ...(typeof row.export_digest === "string" ? { exportDigest: row.export_digest } : {}),
      stateDigest: String(row.state_digest), schemaVersion: Number(row.schema_version), rowCounts: parseCounts(row.row_counts_json), occurredAt: String(row.occurred_at),
    }));
    return {
      tenantId, tenantHash: hash, schemaVersion: this.store.schemaVersion(), stateDigest: snapshot.stateDigest,
      rowCounts: snapshot.rowCounts, totalRows: Object.values(snapshot.rowCounts).reduce((sum, count) => sum + count, 0),
      lastEventSeq: Number(last.seq), corruptRecords: scalar("SELECT COUNT(*) AS count FROM recovery_quarantine WHERE tenant_id=?"),
      activeCredentials: scalar("SELECT COUNT(*) AS count FROM credential_items WHERE tenant_id=? AND status='active'"),
      grantedSensors: scalar("SELECT COUNT(*) AS count FROM sensor_consents WHERE tenant_id=? AND status='granted'"),
      activeAgents: scalar("SELECT COUNT(*) AS count FROM retained_agents WHERE tenant_id=? AND status IN ('queued','running','waiting_approval','needs_input')"),
      sourceLogPaths: paths.map((row) => String(row.source_path)), lifecycle,
    };
  }

  deleteFromExport(input: { tenantId: string; bundle: TenantExportBundle; confirmation: string }): { deleted: boolean; rowCounts: Record<string, number>; auditId: string } {
    const bundle = this.verifyExport(input.bundle);
    if (bundle.format === "co.tenant-export.v1") {
      throw new Error("Tenant export v1 is retained for audit only; create a current v3 export before deletion");
    }
    if (input.confirmation !== `DELETE:${input.tenantId}`) throw new Error(`Deletion requires the exact confirmation DELETE:${input.tenantId}`);
    if (bundle.tenantId !== input.tenantId) throw new Error("Tenant export belongs to a different tenant");
    if (bundle.schemaVersion !== CURRENT_SCHEMA_VERSION || this.store.schemaVersion() !== CURRENT_SCHEMA_VERSION) {
      throw new Error("Tenant export and runtime schema must both be current before deletion");
    }
    const auditId = id("tda");
    const result = this.store.transaction(() => {
      const current = this.snapshot(input.tenantId);
      if (current.schemaDigest !== bundle.schemaDigest) {
        throw new Error("Tenant export table or column manifest does not match the current schema; create a fresh v3 export before deletion");
      }
      if (current.stateDigest !== bundle.stateDigest) throw new Error("Tenant state changed after export; create a fresh export before deletion");
      if (current.tables.length !== bundle.tables.length || current.tables.some((table, index) => {
        const exported = bundle.tables[index];
        return !exported || table.name !== exported.name || table.commitment !== exported.commitment;
      })) {
        throw new Error("Tenant export is not a complete exact snapshot of the current tenant state");
      }
      this.store.db.exec("PRAGMA secure_delete=ON; PRAGMA defer_foreign_keys=ON;");
      this.store.db.prepare(`INSERT INTO tenant_deletion_permits(tenant_id,audit_id,created_at) VALUES(?,?,?)`)
        .run(input.tenantId, auditId, nowIso());
      for (const table of this.tenantTables()) {
        this.store.db.prepare(`DELETE FROM ${identifier(table.name)} WHERE tenant_id=?`).run(input.tenantId);
      }
      this.record("delete", input.tenantId, current.stateDigest, bundle.digest, current.rowCounts, this.store.schemaVersion(), auditId);
      return { deleted: true as const, rowCounts: current.rowCounts, auditId };
    });
    this.store.checkpoint("TRUNCATE");
    return result;
  }

  private record(operation: "export" | "delete" | "restore", tenantId: string, auditedStateDigest: string, exportDigest: string,
    rowCounts: Record<string, number>, schemaVersion: number, auditId = id("tda")): void {
    this.store.db.prepare(`INSERT INTO tenant_lifecycle_audit(
      id,tenant_hash,operation,export_digest,state_digest,schema_version,row_counts_json,occurred_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(auditId, tenantHash(tenantId), operation, exportDigest, auditedStateDigest, schemaVersion, JSON.stringify(rowCounts), nowIso());
  }
}
