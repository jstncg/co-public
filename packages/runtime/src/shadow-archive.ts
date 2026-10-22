import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { stableId } from "./id.ts";
import type { CoRuntime } from "./runtime.ts";
import type { JsonObject } from "./types.ts";

interface ShadowArchivePlan {
  format: "co.shadow-archive.v1";
  id: string;
  path: string;
  tenantId: string;
  /** Explicit direct-thread mappings; never infer a member from a filename. */
  routes: Array<{ transport: "linq" | "sendblue"; tenantPhone: string; threadId: string; peerId: string }>;
}

interface Cursor extends JsonObject {
  device: number;
  inode: number;
  offset: number;
  anchor: string;
  head: string;
  headBytes: number;
}

const MAX_LINE_BYTES = 1_000_000;
const MAX_BATCH_BYTES = 2_000_000;
const MAX_BATCH_LINES = 32;
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function loadShadowArchivePlan(path: string): ShadowArchivePlan {
  if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error("Shadow plan requires a canonical absolute path");
  const info = statSync(path);
  if (!info.isFile() || info.size > 64_000 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error("Shadow plan must be a private, owner-controlled bounded file");
  }
  return parsePlan(JSON.parse(readFileSync(path, "utf8")));
}

function parsePlan(value: unknown): ShadowArchivePlan {
  const plan = object(value);
  if (plan.format !== "co.shadow-archive.v1" || typeof plan.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(plan.id)
    || typeof plan.path !== "string" || !isAbsolute(plan.path) || typeof plan.tenantId !== "string" || !plan.tenantId
    || !Array.isArray(plan.routes) || !plan.routes.length || plan.routes.length > 32) throw new Error("Invalid shadow archive plan");
  const keys = new Set<string>();
  const routes = plan.routes.map((entry) => {
    const route = object(entry);
    if ((route.transport !== "linq" && route.transport !== "sendblue")
      || typeof route.tenantPhone !== "string" || !/^\+[1-9]\d{7,14}$/.test(route.tenantPhone)
      || typeof route.threadId !== "string" || !route.threadId || route.threadId.length > 512
      || typeof route.peerId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(route.peerId)) throw new Error("Invalid shadow direct-thread mapping");
    const key = JSON.stringify([route.transport, route.tenantPhone, route.threadId]);
    if (keys.has(key)) throw new Error("Duplicate shadow route mapping");
    keys.add(key);
    return { transport: route.transport, tenantPhone: route.tenantPhone, threadId: route.threadId, peerId: route.peerId } as ShadowArchivePlan["routes"][number];
  });
  return { format: "co.shadow-archive.v1", id: plan.id, path: plan.path, tenantId: plan.tenantId, routes };
}

function readBytes(fd: number, start: number, count: number): Buffer {
  const bytes = Buffer.alloc(count);
  if (readSync(fd, bytes, 0, count, start) !== count) throw new Error("Shadow archive changed during read");
  return bytes;
}

/** Follows the incumbent's local append-only mirror, not the live webhook.
 * Starts at EOF, never sends, never acknowledges the carrier. A cursor and
 * its admitted jobs commit together. This qualifies a local mirror, not the
 * carrier's signature verifier or the archive producer's delivery guarantee. */
export class ShadowArchiveFollower {
  private readonly plan: ShadowArchivePlan;
  private readonly stream: string;
  private readonly runtime: CoRuntime;
  private readonly planHash: string;

  constructor(runtime: CoRuntime, plan: unknown) {
    this.runtime = runtime;
    this.plan = parsePlan(plan);
    if (runtime.config.mode !== "shadow" || this.plan.tenantId !== runtime.config.tenantId
      || !runtime.store.db.prepare("SELECT 1 FROM runtime_execution_mode WHERE mode='shadow'").get()) throw new Error("Archive following requires an isolated tenant-bound shadow database");
    this.stream = `shadow-archive:${this.plan.id}`;
    this.planHash = hash(JSON.stringify(this.plan));
  }

  poll(): { admitted: number; baseline: number; ignored: number } {
    const store = this.runtime.store;
    const tenantId = this.plan.tenantId;
    const counts = { admitted: 0, baseline: 0, ignored: 0 };
    if (realpathSync(this.plan.path) !== this.plan.path) throw new Error("Shadow archive path cannot contain symlinks");
    const fd = openSync(this.plan.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new Error("Shadow archive must be an owner-controlled regular file");
      const row = store.db.prepare("SELECT payload_json FROM events WHERE tenant_id=? AND stream=? AND type='shadow.archive_cursor' ORDER BY seq DESC LIMIT 1")
        .get(tenantId, this.stream) as { payload_json: string } | undefined;
      const saved = row ? object(JSON.parse(row.payload_json)) : undefined;
      if (saved && saved.planHash !== this.planHash) throw new Error("Shadow plan changed; explicit new feed identity required");
      let cursor: Cursor;
      if (!saved) {
        // An incomplete initial line is ambiguous; do not import a suffix as a new message.
        if (info.size && readBytes(fd, info.size - 1, 1)[0] !== 10) throw new Error("Wait for the archive's initial partial line to finish");
        cursor = this.cursor(fd, info.dev, info.ino, info.size, Math.min(info.size, 4096));
        store.transaction(() => {
          if (store.db.prepare("SELECT 1 FROM events WHERE tenant_id=? AND stream=? AND type='shadow.archive_cursor' LIMIT 1").get(tenantId, this.stream)) {
            throw new Error("Shadow cursor initialized concurrently");
          }
          this.saveCursor(cursor);
        });
        return counts;
      }
      if (!["device", "inode", "offset", "headBytes"].every((key) => Number.isSafeInteger(saved[key]) && Number(saved[key]) >= 0)
        || typeof saved.anchor !== "string" || typeof saved.head !== "string" || Number(saved.headBytes) > 4096) throw new Error("Corrupt shadow archive cursor");
      cursor = saved as Cursor;
      if (info.dev !== cursor.device || info.ino !== cursor.inode || info.size < cursor.offset
        || cursor.headBytes > cursor.offset || this.cursor(fd, info.dev, info.ino, cursor.offset, cursor.headBytes).anchor !== cursor.anchor
        || hash(readBytes(fd, 0, cursor.headBytes)) !== cursor.head) throw new Error("Shadow archive replaced, truncated or rewritten; refusing implicit replay");
      const bytes = readBytes(fd, cursor.offset, Math.min(MAX_BATCH_BYTES, info.size - cursor.offset));
      let start = 0;
      for (let line = 0; line < MAX_BATCH_LINES; line++) {
        const end = bytes.indexOf(10, start);
        if (end < 0) {
          if (bytes.length - start > MAX_LINE_BYTES) throw new Error("Oversized partial shadow archive row requires repair");
          break;
        }
        const raw = bytes.subarray(start, end);
        const nextOffset = cursor.offset + end + 1;
        const next = this.cursor(fd, info.dev, info.ino, nextOffset, cursor.headBytes);
        store.transaction(() => {
          // Serialize competing followers using the committed offset, not an in-memory lock.
          const current = store.db.prepare("SELECT payload_json FROM events WHERE tenant_id=? AND stream=? AND type='shadow.archive_cursor' ORDER BY seq DESC LIMIT 1")
            .get(tenantId, this.stream) as { payload_json: string };
          if (object(JSON.parse(current.payload_json)).offset !== cursor.offset + start) throw new Error("Shadow cursor advanced concurrently");
          let envelope: Record<string, unknown> = {};
          try { if (raw.length <= MAX_LINE_BYTES) envelope = object(JSON.parse(raw.toString("utf8"))); } catch { /* Quarantine malformed rows without stopping unrelated work. */ }
          const route = this.plan.routes.find((candidate) => candidate.transport === envelope.transport
            && candidate.tenantPhone === envelope.tenant_phone && candidate.threadId === envelope.external_thread_id);
          const valid = route && typeof envelope.external_message_id === "string" && envelope.external_message_id.length > 0
            && envelope.external_message_id.length <= 512 && typeof envelope.text === "string" && envelope.text.length <= 100_000
            && typeof envelope.sent_at === "string" && Number.isFinite(Date.parse(envelope.sent_at))
            && (envelope.direction === "inbound" || envelope.direction === "outbound");
          if (!valid || !route) {
            counts.ignored++;
            store.appendEvent({ tenantId, stream: this.stream, type: "shadow.archive_row_ignored",
              payload: { offset: cursor.offset + start, bytes: raw.length, sha256: hash(raw), reason: "invalid-or-unmapped" } });
          } else {
            const eventId = stableId("evt", `${this.stream}:${tenantId}:${route.transport}:${route.threadId}:${String(envelope.direction)}:${String(envelope.external_message_id)}:${envelope.status ? String(envelope.status) : "message"}`);
            const contentHash = hash(JSON.stringify([envelope.text, envelope.media_urls ?? []]));
            const prior = store.getEvent<JsonObject>(tenantId, eventId);
            if (prior && prior.payload.contentHash !== contentHash) throw new Error("Shadow message identity reused with different content");
            if (!prior) {
              const inbound = envelope.direction === "inbound";
              store.appendEvent({ id: eventId, tenantId, stream: this.stream, type: inbound ? "shadow.inbound_observed" : "shadow.baseline_observed",
                payload: { peerId: route.peerId, transport: route.transport, externalId: envelope.external_message_id as string,
                  sourceSentAt: envelope.sent_at as string, contentHash, text: envelope.text as string,
                  mediaCount: Array.isArray(envelope.media_urls) ? envelope.media_urls.length : 0, provenance: "local-incumbent-archive-not-carrier-verification" } });
              if (inbound) {
                // This archive has URLs but no MIME or signed attachment binding. Do not
                // fetch unknown media, invent coverage, or promote it into member authority.
                const text = (envelope.text as string) + (Array.isArray(envelope.media_urls) && envelope.media_urls.length
                  ? "\n[Archived attachments are present but not inspected in this comparison.]" : "");
                if (text.trim()) {
                  store.enqueueJob(tenantId, "channel.turn", { channel: "shadow-archive", peerId: route.peerId, text,
                    externalId: eventId, sourceEventId: eventId }, { idempotencyKey: eventId, releaseId: this.runtime.releases.assign(tenantId).release.id });
                  counts.admitted++;
                }
              } else counts.baseline++;
            }
          }
          this.saveCursor(next);
        });
        start = end + 1;
      }
      return counts;
    } finally { closeSync(fd); }
  }

  private cursor(fd: number, device: number, inode: number, offset: number, headBytes: number): Cursor {
    return { device, inode, offset, headBytes, head: hash(readBytes(fd, 0, headBytes)),
      anchor: hash(readBytes(fd, Math.max(0, offset - 4096), Math.min(4096, offset))) };
  }

  private saveCursor(cursor: Cursor): void {
    this.runtime.store.appendEvent({ tenantId: this.plan.tenantId, stream: this.stream, type: "shadow.archive_cursor",
      payload: { ...cursor, planHash: this.planHash } });
  }
}
