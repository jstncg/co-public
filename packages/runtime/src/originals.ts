import { createHash } from "node:crypto";
import { nowIso, stableId } from "./id.ts";
import type { SqliteStore } from "./store.ts";

export interface OriginalRecord {
  id: string;
  tenantId: string;
  blobId: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  sourceEventId: string;
  attachmentId: string;
  sourceUri: string;
  finalUri: string;
  filename?: string;
  createdAt: string;
}

interface OriginalRow {
  id: string;
  tenant_id: string;
  blob_id: string;
  sha256: string;
  bytes: number;
  mime_type: string;
  source_event_id: string;
  attachment_id: string;
  source_uri: string;
  final_uri: string;
  filename: string | null;
  created_at: string;
}

function bounded(value: string | undefined, maximum: number): string {
  return (value ?? "").trim().slice(0, maximum);
}

function record(row: OriginalRow): OriginalRecord {
  return {
    id: row.id, tenantId: row.tenant_id, blobId: row.blob_id, sha256: row.sha256,
    bytes: Number(row.bytes), mimeType: row.mime_type, sourceEventId: row.source_event_id,
    attachmentId: row.attachment_id, sourceUri: row.source_uri, finalUri: row.final_uri,
    ...(row.filename ? { filename: row.filename } : {}), createdAt: row.created_at,
  };
}

/** Content-addressed reference implementation. Bytes live in the same
 * tenant-scoped SQLite durability/backup boundary as the event that admitted
 * them; a future multi-host store may replace this interface with object
 * storage without changing attachment or artifact contracts. */
export class OriginalStore {
  readonly store: SqliteStore;
  readonly maximumBytes: number;

  constructor(store: SqliteStore, maximumBytes: number) {
    this.store = store;
    this.maximumBytes = maximumBytes;
  }

  preserve(input: {
    tenantId: string;
    sourceEventId: string;
    attachmentId: string;
    sourceUri: string;
    finalUri: string;
    mimeType?: string;
    filename?: string;
    data: Uint8Array;
  }): OriginalRecord {
    if (!input.tenantId.trim() || !input.sourceEventId.trim() || !input.attachmentId.trim()) throw new Error("Original provenance is incomplete");
    if (!this.store.getEvent(input.tenantId, input.sourceEventId)) throw new Error("Original source event is unavailable or belongs to another tenant");
    if (input.data.byteLength > this.maximumBytes) throw new Error(`Original exceeds ${this.maximumBytes} bytes`);
    const sourceUri = bounded(input.sourceUri, 16_384);
    const finalUri = bounded(input.finalUri, 16_384);
    if (!sourceUri || !finalUri) throw new Error("Original source URI is incomplete");
    const sha256 = createHash("sha256").update(input.data).digest("hex");
    const blobId = stableId("blob", `${input.tenantId}:${sha256}`);
    const referenceId = stableId("original", `${input.tenantId}:${input.sourceEventId}:${input.attachmentId}`);
    const mimeType = bounded(input.mimeType, 256) || "application/octet-stream";
    const filename = bounded(input.filename, 1_024);
    const encoded = Buffer.from(input.data).toString("base64");
    const createdAt = nowIso();
    return this.store.transaction(() => {
      this.store.db.prepare(`INSERT OR IGNORE INTO original_blobs(
        id,tenant_id,sha256,bytes,data_base64,created_at
      ) VALUES(?,?,?,?,?,?)`).run(blobId, input.tenantId, sha256, input.data.byteLength, encoded, createdAt);
      const blob = this.store.db.prepare("SELECT tenant_id,sha256,bytes,data_base64 FROM original_blobs WHERE id=?")
        .get(blobId) as { tenant_id: string; sha256: string; bytes: number; data_base64: string } | undefined;
      if (!blob || blob.tenant_id !== input.tenantId || blob.sha256 !== sha256 || Number(blob.bytes) !== input.data.byteLength || blob.data_base64 !== encoded) {
        throw new Error("Original content-addressed blob binding failed");
      }
      this.store.db.prepare(`INSERT OR IGNORE INTO original_blob_refs(
        id,tenant_id,blob_id,source_event_id,attachment_id,source_uri,final_uri,mime_type,filename,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        referenceId, input.tenantId, blobId, input.sourceEventId, input.attachmentId, sourceUri, finalUri, mimeType, filename || null, createdAt,
      );
      const row = this.store.db.prepare(`SELECT r.*,b.sha256,b.bytes FROM original_blob_refs r
        JOIN original_blobs b ON b.id=r.blob_id AND b.tenant_id=r.tenant_id WHERE r.id=? AND r.tenant_id=?`)
        .get(referenceId, input.tenantId) as unknown as OriginalRow | undefined;
      if (!row || row.blob_id !== blobId || row.source_uri !== sourceUri || row.final_uri !== finalUri
        || row.mime_type !== mimeType || (row.filename ?? "") !== filename) {
        throw new Error("Original attachment reference was reused with different content");
      }
      this.store.appendEvent({
        id: stableId("evt", `original-preserved:${input.tenantId}:${referenceId}`), tenantId: input.tenantId,
        stream: `original:${referenceId}`, type: "original.preserved", causationId: input.sourceEventId,
        payload: { originalId: referenceId, blobId, sha256, bytes: input.data.byteLength, mimeType, attachmentId: input.attachmentId, filename: filename || null },
      });
      return record(row);
    });
  }

  get(tenantId: string, originalId: string): OriginalRecord | undefined {
    const row = this.store.db.prepare(`SELECT r.*,b.sha256,b.bytes FROM original_blob_refs r
      JOIN original_blobs b ON b.id=r.blob_id AND b.tenant_id=r.tenant_id WHERE r.id=? AND r.tenant_id=?`)
      .get(originalId, tenantId) as unknown as OriginalRow | undefined;
    return row ? record(row) : undefined;
  }

  forAttachment(tenantId: string, sourceEventId: string, attachmentId: string): OriginalRecord | undefined {
    const row = this.store.db.prepare(`SELECT r.*,b.sha256,b.bytes FROM original_blob_refs r
      JOIN original_blobs b ON b.id=r.blob_id AND b.tenant_id=r.tenant_id
      WHERE r.tenant_id=? AND r.source_event_id=? AND r.attachment_id=?`)
      .get(tenantId, sourceEventId, attachmentId) as unknown as OriginalRow | undefined;
    return row ? record(row) : undefined;
  }

  bytes(tenantId: string, originalId: string): Buffer | undefined {
    const row = this.store.db.prepare(`SELECT b.data_base64,b.sha256,b.bytes FROM original_blob_refs r
      JOIN original_blobs b ON b.id=r.blob_id AND b.tenant_id=r.tenant_id WHERE r.id=? AND r.tenant_id=?`)
      .get(originalId, tenantId) as { data_base64: string; sha256: string; bytes: number } | undefined;
    if (!row) return undefined;
    const data = Buffer.from(row.data_base64, "base64");
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (data.byteLength !== Number(row.bytes) || sha256 !== row.sha256) throw new Error(`Original ${originalId} failed its content hash`);
    return data;
  }

  list(tenantId: string, limit = 100): OriginalRecord[] {
    return (this.store.db.prepare(`SELECT r.*,b.sha256,b.bytes FROM original_blob_refs r
      JOIN original_blobs b ON b.id=r.blob_id AND b.tenant_id=r.tenant_id
      WHERE r.tenant_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT ?`).all(tenantId, Math.max(1, Math.min(1_000, limit))) as unknown as OriginalRow[])
      .map(record);
  }
}
