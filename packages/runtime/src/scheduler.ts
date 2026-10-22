import { id, nowIso, stableId } from "./id.ts";
import { absoluteTime } from "./time.ts";
import type { JsonObject } from "./types.ts";
import type { SqliteStore } from "./store.ts";

type Row = Record<string, string | number | null>;

export interface ScheduleRecord {
  id: string;
  tenantId: string;
  name: string;
  prompt: string;
  channel: string;
  peerId: string;
  mode: "once" | "interval";
  intervalMinutes?: number;
  nextRunAt: string;
  status: "active" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

function fromRow(row: Row): ScheduleRecord {
  const intervalMinutes = typeof row.interval_minutes === "number" ? row.interval_minutes : undefined;
  return {
    id: String(row.id), tenantId: String(row.tenant_id), name: String(row.name), prompt: String(row.prompt),
    channel: String(row.channel), peerId: String(row.peer_id), mode: String(row.mode) as ScheduleRecord["mode"],
    ...(intervalMinutes !== undefined ? { intervalMinutes } : {}), nextRunAt: String(row.next_run_at),
    status: String(row.status) as ScheduleRecord["status"], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export class Scheduler {
  readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  create(input: {
    tenantId: string;
    name: string;
    prompt: string;
    channel: string;
    peerId: string;
    runAt?: string;
    everyMinutes?: number;
  }): ScheduleRecord {
    const everyMinutes = input.everyMinutes ? Math.max(1, Math.floor(input.everyMinutes)) : undefined;
    const runAt = input.runAt ? new Date(absoluteTime(input.runAt, "runAt")) : new Date(Date.now() + (everyMinutes ?? 1) * 60_000);
    if (Number.isNaN(runAt.getTime())) throw new Error("runAt must be an ISO-8601 date/time");
    if (!everyMinutes && !input.runAt) throw new Error("Provide runAt or everyMinutes");
    const scheduleId = id("sch");
    const current = nowIso();
    this.store.db.prepare(`INSERT INTO schedules(id,tenant_id,name,prompt,channel,peer_id,mode,interval_minutes,next_run_at,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      scheduleId, input.tenantId, input.name, input.prompt, input.channel, input.peerId, everyMinutes ? "interval" : "once",
      everyMinutes ?? null, runAt.toISOString(), "active", current, current,
    );
    this.store.appendEvent({ tenantId: input.tenantId, stream: `schedule:${scheduleId}`, type: "schedule.created", payload: { scheduleId, name: input.name, runAt: runAt.toISOString(), everyMinutes: everyMinutes ?? null, channel: input.channel, peerId: input.peerId } });
    return this.get(scheduleId, input.tenantId) as ScheduleRecord;
  }

  get(scheduleId: string, tenantId?: string): ScheduleRecord | undefined {
    const row = tenantId
      ? this.store.db.prepare("SELECT * FROM schedules WHERE id=? AND tenant_id=?").get(scheduleId, tenantId) as Row | undefined
      : this.store.db.prepare("SELECT * FROM schedules WHERE id=?").get(scheduleId) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(tenantId: string, status?: ScheduleRecord["status"]): ScheduleRecord[] {
    const rows = status
      ? this.store.db.prepare("SELECT * FROM schedules WHERE tenant_id=? AND status=? ORDER BY next_run_at").all(tenantId, status)
      : this.store.db.prepare("SELECT * FROM schedules WHERE tenant_id=? ORDER BY next_run_at").all(tenantId);
    return (rows as Row[]).map(fromRow);
  }

  cancel(tenantId: string, scheduleId: string): ScheduleRecord {
    this.store.db.prepare("UPDATE schedules SET status='cancelled',updated_at=? WHERE id=? AND tenant_id=?").run(nowIso(), scheduleId, tenantId);
    const record = this.get(scheduleId, tenantId);
    if (!record) throw new Error(`Unknown schedule ${scheduleId}`);
    this.store.appendEvent({ tenantId, stream: `schedule:${scheduleId}`, type: "schedule.cancelled", payload: { scheduleId } });
    return record;
  }

  materializeDue(limit = 20, tenantId?: string): number {
    const due = tenantId
      ? this.store.db.prepare("SELECT id FROM schedules WHERE tenant_id=? AND status='active' AND next_run_at<=? ORDER BY next_run_at LIMIT ?").all(tenantId, nowIso(), limit) as Array<{ id: string }>
      : this.store.db.prepare("SELECT id FROM schedules WHERE status='active' AND next_run_at<=? ORDER BY next_run_at LIMIT ?").all(nowIso(), limit) as Array<{ id: string }>;
    let fired = 0;
    for (const item of due) {
      this.store.transaction(() => {
        const schedule = this.get(item.id, tenantId);
        if (!schedule || schedule.status !== "active" || schedule.nextRunAt > nowIso()) return;
        const currentTime = Date.now();
        const externalId = `schedule:${schedule.id}:${schedule.nextRunAt}`;
        const authorizationEventId = stableId("evt", `schedule-fired:${schedule.tenantId}:${schedule.id}:${schedule.nextRunAt}`);
        this.store.appendEvent({
          id: authorizationEventId, tenantId: schedule.tenantId, stream: `schedule:${schedule.id}`, type: "schedule.fired",
          payload: {
            scheduleId: schedule.id, scheduledFor: schedule.nextRunAt,
            textDigest: stableId("content", schedule.prompt), channel: schedule.channel, peerId: schedule.peerId, externalId,
          },
        });
        this.store.enqueueJob(schedule.tenantId, "channel.turn", {
          channel: schedule.channel, peerId: schedule.peerId, text: schedule.prompt, externalId,
          originClass: "schedule", scheduleId: schedule.id, scheduleAuthorizationEventId: authorizationEventId,
        }, { idempotencyKey: `schedule:${schedule.id}:${schedule.nextRunAt}` });
        const intervalMs = (schedule.intervalMinutes ?? 0) * 60_000;
        const scheduledTime = Date.parse(schedule.nextRunAt);
        const elapsedIntervals = intervalMs ? Math.max(1, Math.floor((currentTime - scheduledTime) / intervalMs) + 1) : 0;
        const next = intervalMs ? new Date(scheduledTime + elapsedIntervals * intervalMs).toISOString() : schedule.nextRunAt;
        this.store.db.prepare("UPDATE schedules SET status=?,next_run_at=?,updated_at=? WHERE id=?")
          .run(schedule.mode === "once" ? "completed" : "active", next, nowIso(), schedule.id);
        this.store.appendEvent({
          id: stableId("evt", `schedule-advanced:${schedule.tenantId}:${schedule.id}:${schedule.nextRunAt}`),
          tenantId: schedule.tenantId, stream: `schedule:${schedule.id}`, type: "schedule.advanced",
          causationId: authorizationEventId,
          payload: { scheduleId: schedule.id, scheduledFor: schedule.nextRunAt, nextRunAt: schedule.mode === "interval" ? next : null, skippedIntervals: Math.max(0, elapsedIntervals - 1) },
        });
        fired += 1;
      });
    }
    return fired;
  }

  asJson(record: ScheduleRecord): JsonObject {
    return { ...record, intervalMinutes: record.intervalMinutes ?? null } as unknown as JsonObject;
  }
}
