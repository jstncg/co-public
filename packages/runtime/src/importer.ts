import { createReadStream, existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { extname, resolve } from "node:path";
import { stableId } from "./id.ts";
import type { JsonObject, JsonValue } from "./types.ts";
import type { SqliteStore } from "./store.ts";

const MAX_TEXT_RECORD = 32_000;

function files(path: string): string[] {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Import path does not exist: ${resolved}`);
  const linkStats = lstatSync(resolved);
  if (linkStats.isSymbolicLink()) return [];
  const stats = statSync(resolved);
  if (stats.isFile()) return [realpathSync(resolved)];
  if (!stats.isDirectory()) return [];
  return readdirSync(resolved, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.isSymbolicLink()) return [];
      return files(`${resolved}/${entry.name}`);
    });
}

function sourceIdentity(path: string): string {
  const stats = statSync(path);
  return stableId("file", `${stats.dev}:${stats.ino}`);
}

function parsedTime(value: unknown): string | undefined {
  const milliseconds = typeof value === "number"
    ? value > 10_000_000_000 ? value : value * 1000
    : typeof value === "string" && /^\d{10,13}$/.test(value) ? (value.length === 10 ? Number(value) * 1000 : Number(value)) : NaN;
  const candidate = Number.isFinite(milliseconds) ? new Date(milliseconds) : typeof value === "string" ? new Date(value) : undefined;
  if (!candidate || Number.isNaN(candidate.getTime())) return undefined;
  const time = candidate.getTime();
  if (time < Date.UTC(2000, 0, 1) || time > Date.now() + 86_400_000) return undefined;
  return candidate.toISOString();
}

function messageText(value: unknown): { role?: string; text: string; observedAt?: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { text: "" };
  const row = value as Record<string, unknown>;
  const message = row.message !== null && typeof row.message === "object" && !Array.isArray(row.message) ? row.message as Record<string, unknown> : row;
  const role = typeof message.role === "string" ? message.role : typeof row.type === "string" ? row.type : undefined;
  const observedAt = [row.timestamp, row.created_at, row.createdAt, row.date, message.timestamp, message.created_at, message.createdAt]
    .map(parsedTime).find(Boolean);
  const content = message.content;
  if (typeof content === "string") return { ...(role ? { role } : {}), ...(observedAt ? { observedAt } : {}), text: content };
  if (Array.isArray(content)) {
    const text = content.flatMap((part) => {
      if (part !== null && typeof part === "object" && !Array.isArray(part) && typeof (part as Record<string, unknown>).text === "string") return [(part as Record<string, unknown>).text as string];
      return [];
    }).join("\n");
    return { ...(role ? { role } : {}), ...(observedAt ? { observedAt } : {}), text };
  }
  return { ...(role ? { role } : {}), ...(observedAt ? { observedAt } : {}), text: "" };
}

export class LogImporter {
  readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  async importPath(tenantId: string, path: string): Promise<{ files: number; imported: number; skipped: number }> {
    const candidates = files(path).filter((file) => [".jsonl", ".ndjson", ".md", ".txt"].includes(extname(file).toLowerCase()));
    let imported = 0;
    let skipped = 0;
    for (const file of candidates) {
      const result = file.endsWith(".jsonl") || file.endsWith(".ndjson")
        ? await this.importJsonl(tenantId, file)
        : await this.importText(tenantId, file);
      imported += result.imported;
      skipped += result.skipped;
    }
    return { files: candidates.length, imported, skipped };
  }

  private record(tenantId: string, sourceKey: string, path: string, offset: number, payload: JsonObject): boolean {
    return this.store.transaction(() => {
      const exists = this.store.db.prepare("SELECT source_key FROM imports WHERE tenant_id=? AND source_key=?").get(tenantId, sourceKey);
      if (exists) return false;
      const eventId = stableId("evt", `${tenantId}:${sourceKey}`);
      const event = this.store.appendEvent({
        id: eventId,
        tenantId,
        stream: `import:${sourceIdentity(path)}`,
        type: "log.imported",
        ...(typeof payload.observedAt === "string" ? { at: payload.observedAt } : {}),
        payload: { ...payload, provenance: "imported-untrusted", contentHash: stableId("sha256", JSON.stringify(payload)) },
      });
      const role = typeof payload.role === "string" ? payload.role.toLowerCase() : "";
      const text = typeof payload.text === "string" && payload.text.trim()
        ? payload.text
        : typeof payload.raw === "string" ? payload.raw : "";
      this.store.indexEvidence({
        tenantId,
        sourceEventId: event.id,
        kind: `import.${String(payload.format ?? "unknown")}`,
        trustClass: role === "user" || role === "human" ? "owner" : role === "assistant" ? "agent" : "untrusted",
        content: text,
        observedAt: event.at,
        metadata: { sourcePath: path, sourceOffset: offset, role: role || "unknown" },
      });
      this.store.db.prepare("INSERT INTO imports(source_key,tenant_id,source_path,source_offset,event_id,imported_at) VALUES(?,?,?,?,?,?)")
        .run(sourceKey, tenantId, path, offset, eventId, new Date().toISOString());
      return true;
    });
  }

  private async importJsonl(tenantId: string, path: string): Promise<{ imported: number; skipped: number }> {
    const identity = sourceIdentity(path);
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    let offset = 0;
    let imported = 0;
    let skipped = 0;
    for await (const line of lines) {
      offset += 1;
      if (!line.trim()) continue;
      const sourceKey = stableId("src", `${identity}:jsonl:${offset}:${line}`);
      let parsed: unknown = line;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Malformed records remain evidence rather than disappearing.
      }
      const extracted = messageText(parsed);
      const payload: JsonObject = {
        sourcePath: path, sourceIdentity: identity, sourceOffset: offset, format: "jsonl", role: extracted.role ?? "unknown", text: extracted.text,
        ...(extracted.observedAt ? { observedAt: extracted.observedAt } : {}),
        raw: (typeof parsed === "string" ? parsed.slice(0, 100_000) : parsed) as JsonValue,
      };
      if (this.record(tenantId, sourceKey, path, offset, payload)) imported += 1;
      else skipped += 1;
    }
    return { imported, skipped };
  }

  private async importText(tenantId: string, path: string): Promise<{ imported: number; skipped: number }> {
    const identity = sourceIdentity(path);
    const format = extname(path).slice(1).toLowerCase();
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    let lineNumber = 0;
    let imported = 0;
    let skipped = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (!line) continue;
      const parts = Math.max(1, Math.ceil(line.length / MAX_TEXT_RECORD));
      for (let part = 0; part < parts; part += 1) {
        const text = line.slice(part * MAX_TEXT_RECORD, (part + 1) * MAX_TEXT_RECORD);
        const sourceKey = stableId("src", `${identity}:${format}:${lineNumber}:${part}:${text}`);
        const payload: JsonObject = {
          sourcePath: path, sourceIdentity: identity, sourceOffset: lineNumber, sourcePart: part, format, text,
        };
        if (this.record(tenantId, sourceKey, path, lineNumber, payload)) imported += 1;
        else skipped += 1;
      }
    }
    return { imported, skipped };
  }
}
