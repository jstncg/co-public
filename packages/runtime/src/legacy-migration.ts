import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { stableId } from "./id.ts";
import { SqliteStore } from "./store.ts";
import type { JsonObject } from "./types.ts";

export interface LegacySource {
  id: string;
  tenantId: string;
  path: string;
  format: "claims-sqlite" | "transcript-json" | "preserve-only";
  /** The timezone of the process that wrote naive timestamps, NOT current member location. */
  timestampZone?: string;
}

export interface LegacyMigrationPlan {
  format: "co.legacy-migration.v1";
  sources: LegacySource[];
}

export interface MigrationSourceReport {
  sourceId: string;
  tenantId: string;
  format: LegacySource["format"];
  snapshot: string;
  sha256: string;
  bytes: number;
  archivedRecords: number;
  searchableRecords: number;
  unresolvedTimestamps: number;
  tables: Record<string, number>;
}

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_+-]{0,127}$/;
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const quoted = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

async function fileHash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function sqliteHeader(path: string): boolean {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(16);
    return readSync(descriptor, header, 0, 16, 0) === 16 && header.toString("utf8") === "SQLite format 3\0";
  } finally { closeSync(descriptor); }
}

export function parseLegacyMigrationPlan(value: unknown): LegacyMigrationPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Migration plan must be an object");
  const plan = value as Record<string, unknown>;
  if (Object.keys(plan).some(key => key !== "format" && key !== "sources")
    || plan.format !== "co.legacy-migration.v1" || !Array.isArray(plan.sources)
    || !plan.sources.length || plan.sources.length > 256) throw new Error("Invalid migration plan");
  const identities = new Set<string>();
  const paths = new Set<string>();
  const sources = plan.sources.map((item): LegacySource => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid migration source");
    const source = item as Record<string, unknown>;
    if (Object.keys(source).some(key => !["id", "tenantId", "path", "format", "timestampZone"].includes(key))
      || typeof source.id !== "string" || !identifier.test(source.id)
      || typeof source.tenantId !== "string" || !identifier.test(source.tenantId)
      || typeof source.path !== "string" || !isAbsolute(source.path)
      || !["claims-sqlite", "transcript-json", "preserve-only"].includes(String(source.format))) throw new Error("Invalid migration source mapping");
    if (identities.has(source.id)) throw new Error("Source identities must be unique across tenants");
    identities.add(source.id);
    const stat = lstatSync(source.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_BYTES) throw new Error("Migration source must be a bounded regular file, not a symlink");
    const path = realpathSync(source.path);
    if (paths.has(path)) throw new Error("A source cannot be assigned to two tenants");
    paths.add(path);
    if (source.timestampZone !== undefined) {
      if (typeof source.timestampZone !== "string") throw new Error("Invalid timestamp timezone");
      new Intl.DateTimeFormat("en-US", { timeZone: source.timestampZone }).format();
    }
    if (source.format === "transcript-json" && stat.size > MAX_TRANSCRIPT_BYTES) throw new Error("Transcript exceeds migration size bound");
    return { id: source.id, tenantId: source.tenantId, path, format: source.format as LegacySource["format"],
      ...(typeof source.timestampZone === "string" ? { timestampZone: source.timestampZone } : {}) };
  });
  return { format: "co.legacy-migration.v1", sources };
}

/** Never use the migration date as an old record's observation date. Ambiguous DST folds stay unresolved. */
export function legacyTimestamp(value: unknown, zone?: string): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  if (typeof value !== "string") return undefined;
  if (/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
  }
  const match = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.\d+)?$/.exec(value);
  if (!match || !zone) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const partsAt = (time: number): number => {
    const p = Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  };
  if (new Date(wall).toISOString().slice(0, 19) !== `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`) return undefined;
  const offsets = new Set([-86_400_000, 0, 86_400_000].map(delta => partsAt(wall + delta) - wall - delta));
  const candidates = [...offsets].map(offset => wall - offset).filter(candidate => partsAt(candidate) === wall);
  return candidates.length === 1 ? new Date(candidates[0] as number).toISOString() : undefined;
}

function jsonRow(row: Record<string, unknown>): JsonObject {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    value instanceof Uint8Array ? { $base64: Buffer.from(value).toString("base64") }
      : typeof value === "bigint" ? { $integer: value.toString() } : value])) as JsonObject;
}

function importedId(tenantId: string, sourceId: string, table: string, offset: number, raw: JsonObject): string {
  return stableId("evt", `legacy:${tenantId}:${sourceId}:${table}:${offset}:${hash(JSON.stringify(raw))}`);
}

function expectedSnapshotIds(source: MigrationSourceReport): Set<string> {
  const ids = new Set<string>();
  if (source.format === "transcript-json") {
    const rows: unknown = JSON.parse(readFileSync(source.snapshot, "utf8"));
    if (!Array.isArray(rows)) throw new Error("Invalid preserved transcript");
    for (const [offset, row] of rows.entries()) ids.add(importedId(source.tenantId, source.sourceId, "transcript", offset, row as JsonObject));
  } else if (source.format === "claims-sqlite") {
    const db = new DatabaseSync(source.snapshot, { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
      for (const table of ["claims", "relations", "user_corrections"]) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
        const query = db.prepare(`SELECT * FROM ${quoted(table)} ORDER BY id`);
        query.setReadBigInts(true);
        let offset = 0;
        for (const row of query.iterate()) ids.add(importedId(source.tenantId, source.sourceId, table, offset++, jsonRow(row)));
      }
    } finally { db.close(); }
  } else if (source.format !== "preserve-only") throw new Error("Invalid source format");
  return ids;
}

function record(store: SqliteStore, source: LegacySource, table: string, offset: number, raw: JsonObject,
  observedAt: string | undefined, text: string | undefined, trust: "owner" | "agent" | "untrusted"): void {
  const event = store.appendEvent({ id: importedId(source.tenantId, source.id, table, offset, raw),
    tenantId: source.tenantId, stream: `legacy:${source.id}`, type: "legacy.record_imported",
    ...(observedAt ? { at: observedAt } : {}), payload: {
      sourceId: source.id, table, sourceOffset: offset, raw, importedAt: new Date().toISOString(),
      provenance: "legacy-import", interpretation: table === "claims" ? "legacy-inference-not-member-confirmed" : "historical-record",
      timestampResolved: Boolean(observedAt),
    } });
  // Unknown dates remain archived, not falsely ranked as fresh evidence. Claims are never owner evidence.
  if (text?.trim() && observedAt) store.indexEvidence({ tenantId: source.tenantId, sourceEventId: event.id,
    kind: `legacy.${table}`, trustClass: trust, content: text, observedAt,
    metadata: { sourceId: source.id, sourceOffset: offset, legacy: true, userConfirmed: false } });
}

function ingestTranscript(store: SqliteStore, source: LegacySource, path: string, report: MigrationSourceReport): void {
  const records: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(records) || records.length > 1_000_000) throw new Error("Transcript must be a bounded array");
  store.transaction(() => {
    for (const [offset, item] of records.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Malformed transcript record; source preserved, import refused");
      const row = item as JsonObject;
      const at = legacyTimestamp(row.ts ?? row.timestamp ?? row.created_at, source.timestampZone);
      const text = typeof row.content === "string" ? row.content : undefined;
      const trust = row.role === "user" || row.role === "human" ? "owner" : row.role === "assistant" ? "agent" : "untrusted";
      record(store, source, "transcript", offset, row, at, text, trust);
      report.archivedRecords++;
      if (!at) report.unresolvedTimestamps++;
      if (at && text?.trim()) report.searchableRecords++;
    }
  });
}

function ingestClaims(store: SqliteStore, source: LegacySource, path: string, report: MigrationSourceReport): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const table of tables) report.tables[String(table.name)] = Number(db.prepare(`SELECT count(*) AS n FROM ${quoted(String(table.name))}`).get()?.n);
    if (!Object.hasOwn(report.tables, "claims")) throw new Error("Mapped claims source has no claims table");
    const columns = db.prepare("PRAGMA table_info(claims)").all().map(row => String(row.name));
    if (!["id", "statement"].every(column => columns.includes(column))) throw new Error("Unsupported legacy claims schema");
    const corrected = new Set(Object.hasOwn(report.tables, "user_corrections")
      ? db.prepare("SELECT claim_id FROM user_corrections WHERE action IN ('wrong','edit')").all().map(row => String(row.claim_id)) : []);
    const superseded = new Set(columns.includes("supersedes")
      ? db.prepare("SELECT supersedes FROM claims WHERE supersedes IS NOT NULL").all().map(row => String(row.supersedes)) : []);
    store.transaction(() => {
      for (const table of ["claims", "relations", "user_corrections"]) {
        if (!Object.hasOwn(report.tables, table)) continue;
        const query = db.prepare(`SELECT * FROM ${quoted(table)} ORDER BY id`);
        query.setReadBigInts(true);
        let offset = 0;
        for (const value of query.iterate()) {
          const raw = jsonRow(value);
          const at = legacyTimestamp(value.last_verified ?? value.first_seen ?? value.created_at ?? value.created, source.timestampZone);
          const eligible = table === "claims" && (value.status === undefined || value.status === "active")
            && !corrected.has(String(value.id)) && !superseded.has(String(value.id));
          const text = eligible && typeof value.statement === "string" ? value.statement : undefined;
          record(store, source, table, offset++, raw, at, text, "untrusted");
          report.archivedRecords++;
          if (!at) report.unresolvedTimestamps++;
          if (at && text?.trim()) report.searchableRecords++;
        }
      }
    });
  } finally { db.close(); }
}

export async function prepareLegacyMigration(input: LegacyMigrationPlan, destination: string): Promise<{
  format: "co.legacy-migration-report.v1"; status: "prepared-not-live"; database: string; sources: MigrationSourceReport[];
}> {
  const plan = parseLegacyMigrationPlan(input);
  const out = join(realpathSync(dirname(resolve(destination))), basename(destination));
  if (existsSync(out)) throw new Error("Migration destination must not exist; never overwrite a candidate or live state");
  for (const source of plan.sources) {
    if (relative(out, source.path).split(/[\\/]/)[0] !== "..") throw new Error("Migration destination cannot contain a source");
  }
  mkdirSync(out, { mode: 0o700 });
  const snapshots = join(out, "snapshots");
  mkdirSync(snapshots, { mode: 0o700 });
  writeFileSync(join(out, "plan.json"), JSON.stringify(plan, null, 2), { flag: "wx", mode: 0o600 });
  const reports: MigrationSourceReport[] = [];
  const database = join(out, "candidate.sqlite");
  let store: SqliteStore | undefined;
  try {
    // Snapshot ALL inputs before importing any of them. SQLite online backup includes committed WAL data.
    for (const source of plan.sources) {
      const path = join(snapshots, `${source.id}.snapshot`);
      if (source.format === "claims-sqlite" || sqliteHeader(source.path)) {
        const original = new DatabaseSync(source.path, { readOnly: true });
        try { await backup(original, path); } finally { original.close(); }
        chmodSync(path, 0o600);
        const copy = new DatabaseSync(path, { readOnly: true });
        try {
          if (copy.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("Source snapshot failed SQLite integrity check");
        } finally { copy.close(); }
      } else {
        const before = statSync(source.path, { bigint: true });
        copyFileSync(source.path, path, constants.COPYFILE_EXCL);
        chmodSync(path, 0o600);
        const after = statSync(source.path, { bigint: true });
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new Error("Source changed during snapshot; retry into a fresh destination");
      }
      reports.push({ sourceId: source.id, tenantId: source.tenantId, format: source.format, snapshot: path,
        sha256: await fileHash(path), bytes: statSync(path).size, archivedRecords: 0, searchableRecords: 0, unresolvedTimestamps: 0, tables: {} });
    }
    store = new SqliteStore(database, { synchronous: "FULL" });
    for (const [index, source] of plan.sources.entries()) {
      const report = reports[index] as MigrationSourceReport;
      if (source.format === "claims-sqlite") ingestClaims(store, source, report.snapshot, report);
      else if (source.format === "transcript-json") ingestTranscript(store, source, report.snapshot, report);
    }
    if (store.db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("Candidate failed SQLite integrity check");
    if (Number(store.db.prepare("SELECT count(*) AS n FROM jobs").get()?.n) !== 0) throw new Error("Migration must never admit historical work");
    store.checkpoint("TRUNCATE");
    const result = { format: "co.legacy-migration-report.v1" as const, status: "prepared-not-live" as const, database, sources: reports };
    writeFileSync(join(out, "report.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
    return result;
  } catch (error) {
    // Preserve even partial snapshots for investigation. No success marker and no automatic cleanup.
    writeFileSync(join(out, "FAILED"), "Preparation failed. Candidate is not eligible for activation. Sources and partial snapshots preserved.\n", { flag: "wx", mode: 0o600 });
    throw error;
  } finally { store?.close(); }
}

/** Offline consistency check, not a live-product qualification or authenticity signature. */
export async function verifyLegacyMigration(directory: string): Promise<{
  verified: true; sources: number; archivedRecords: number; searchableRecords: number; liveCutoverQualified: false;
}> {
  const root = realpathSync(directory);
  if (existsSync(join(root, "FAILED"))) throw new Error("Failed migration candidates cannot be verified");
  const reportPath = join(root, "report.json");
  if (statSync(reportPath).size > 2_000_000) throw new Error("Migration report exceeds size bound");
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    format?: unknown; status?: unknown; database?: unknown; sources?: MigrationSourceReport[];
  };
  if (report.format !== "co.legacy-migration-report.v1" || report.status !== "prepared-not-live"
    || report.database !== join(root, "candidate.sqlite") || !Array.isArray(report.sources)
    || !report.sources.length || report.sources.length > 256) throw new Error("Invalid migration report");
  const confined = (path: string): void => {
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error("Migration bundle contains a redirected path");
  };
  confined(report.database);
  const db = new DatabaseSync(report.database, { readOnly: true });
  let archivedRecords = 0;
  let searchableRecords = 0;
  const seen = new Set<string>();
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("Candidate integrity check failed");
    for (const table of ["jobs", "runs", "memories", "approvals", "mandates", "work_orders", "scouts", "goals"]) {
      if (Number(db.prepare(`SELECT count(*) AS n FROM ${quoted(table)}`).get()?.n) !== 0) throw new Error("Candidate contains live work or promoted beliefs");
    }
    for (const source of report.sources) {
      if (!identifier.test(source.sourceId) || !identifier.test(source.tenantId) || seen.has(source.sourceId)
        || source.snapshot !== join(root, "snapshots", `${source.sourceId}.snapshot`)
        || ![source.bytes, source.archivedRecords, source.searchableRecords, source.unresolvedTimestamps].every(n => Number.isSafeInteger(n) && n >= 0)) {
        throw new Error("Invalid migration source report");
      }
      seen.add(source.sourceId);
      confined(source.snapshot);
      if (statSync(source.snapshot).size !== source.bytes || await fileHash(source.snapshot) !== source.sha256) throw new Error("Preserved source hash mismatch");
      const expectedIds = expectedSnapshotIds(source);
      let actualRecords = 0;
      let actualSearchable = 0;
      for (const event of db.prepare("SELECT id,at,payload_json FROM events WHERE tenant_id=? AND stream=? AND type='legacy.record_imported'")
        .iterate(source.tenantId, `legacy:${source.sourceId}`)) {
        const payload = JSON.parse(String(event.payload_json)) as JsonObject;
        if (payload.sourceId !== source.sourceId || typeof payload.table !== "string" || !Number.isSafeInteger(payload.sourceOffset)
          || !payload.raw || typeof payload.raw !== "object" || Array.isArray(payload.raw)) throw new Error("Corrupt imported record");
        const expected = importedId(source.tenantId, source.sourceId, payload.table, Number(payload.sourceOffset), payload.raw);
        if (event.id !== expected || !expectedIds.delete(expected)) throw new Error("Imported record content commitment mismatch");
        const evidence = db.prepare("SELECT tenant_id,trust_class,observed_at,content FROM evidence WHERE source_event_id=?").all(expected);
        for (const entry of evidence) {
          const expectedTrust = payload.table === "transcript"
            ? payload.raw.role === "user" || payload.raw.role === "human" ? "owner" : payload.raw.role === "assistant" ? "agent" : "untrusted"
            : "untrusted";
          if (entry.tenant_id !== source.tenantId || entry.trust_class !== expectedTrust
            || payload.timestampResolved !== true || entry.observed_at !== event.at) throw new Error("Imported evidence attribution mismatch");
          const original = payload.table === "transcript" ? payload.raw.content : payload.raw.statement;
          if (typeof original !== "string" || entry.content !== original.trim().slice(0, 100_000)) throw new Error("Imported search content mismatch");
        }
        actualRecords++;
        actualSearchable += evidence.length;
      }
      if (expectedIds.size || actualRecords !== source.archivedRecords || actualSearchable !== source.searchableRecords) throw new Error("Imported record counts do not reconcile");
      archivedRecords += actualRecords;
      searchableRecords += actualSearchable;
    }
    if (Number(db.prepare("SELECT count(*) AS n FROM events").get()?.n) !== archivedRecords
      || Number(db.prepare("SELECT count(*) AS n FROM evidence").get()?.n) !== searchableRecords) throw new Error("Candidate contains unaccounted records");
    return { verified: true, sources: seen.size, archivedRecords, searchableRecords, liveCutoverQualified: false };
  } finally { db.close(); }
}
