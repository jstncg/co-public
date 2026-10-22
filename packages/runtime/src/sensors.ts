import { createHash } from "node:crypto";
import { id, nowIso } from "./id.ts";
import type { SqliteStore } from "./store.ts";
import type { JsonObject, JsonValue, SensorConfig } from "./types.ts";

type Row = Record<string, string | number | bigint | null | Uint8Array>;

export type SensorConsentStatus = "ungranted" | "granted" | "revoked" | "stale";

export interface SensorConsentView extends SensorConfig {
  configured: boolean;
  consentStatus: SensorConsentStatus;
  descriptorHash: string;
  sourceEventId?: string;
  createdByRunId?: string;
  grantedAt?: string;
  revokedAt?: string;
  updatedAt?: string;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function snapshot(sensor: SensorConfig): JsonObject {
  return {
    id: sensor.id, pluginId: sensor.pluginId, displayName: sensor.displayName, kind: sensor.kind,
    purpose: sensor.purpose, dataClasses: sensor.dataClasses, retentionDays: sensor.retentionDays,
    mcpServerName: sensor.mcpServerName, remoteToolName: sensor.remoteToolName, runtimeToolName: sensor.runtimeToolName,
  };
}

function descriptorHash(sensor: SensorConfig): string {
  return createHash("sha256").update(canonicalJson(snapshot(sensor))).digest("hex");
}

function parseSnapshot(value: unknown): SensorConfig | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as SensorConfig;
    if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string" || typeof parsed.runtimeToolName !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export class SensorConsentManager {
  readonly store: SqliteStore;
  readonly configured: SensorConfig[];
  private readonly byId: Map<string, SensorConfig>;
  private readonly byTool: Map<string, SensorConfig>;

  constructor(store: SqliteStore, configured: SensorConfig[]) {
    this.store = store;
    this.configured = configured.map((sensor) => ({ ...sensor, dataClasses: [...sensor.dataClasses] }));
    this.byId = new Map(this.configured.map((sensor) => [sensor.id, sensor]));
    this.byTool = new Map(this.configured.map((sensor) => [sensor.runtimeToolName, sensor]));
    if (this.byId.size !== this.configured.length || this.byTool.size !== this.configured.length) throw new Error("Configured sensors must have unique IDs and runtime tools");
  }

  sensorForTool(toolName: string): SensorConfig | undefined {
    return this.byTool.get(toolName);
  }

  requireGranted(tenantId: string, sensorId: string): SensorConsentView {
    const sensor = this.byId.get(sensorId);
    if (!sensor) throw new Error(`Sensor is not configured: ${sensorId}`);
    const view = this.view(tenantId, sensor);
    if (view.consentStatus === "stale") throw new Error(`Sensor consent is stale because ${sensorId} changed; review and grant it again`);
    if (view.consentStatus !== "granted") throw new Error(`Sensor ${sensorId} requires explicit consent before reading`);
    return view;
  }

  grant(input: { tenantId: string; sensorId: string; expectedDescriptorHash?: string; sourceEventId?: string; createdByRunId?: string }): SensorConsentView {
    const sensor = this.byId.get(input.sensorId);
    if (!sensor) throw new Error(`Sensor is not configured: ${input.sensorId}`);
    if (input.sourceEventId && !this.store.getEvent(input.tenantId, input.sourceEventId)) throw new Error("Sensor consent source event does not belong to tenant");
    if (input.createdByRunId && !this.store.getRun(input.createdByRunId, input.tenantId)) throw new Error("Sensor consent run does not belong to tenant");
    const hash = descriptorHash(sensor);
    if (input.expectedDescriptorHash && input.expectedDescriptorHash !== hash) throw new Error("Sensor descriptor changed before consent was granted; review it again");
    const current = nowIso();
    this.store.transaction(() => {
      const prior = this.row(input.tenantId, sensor.id);
      if (prior?.status === "granted" && prior.descriptor_hash === hash) return;
      this.store.db.prepare(`INSERT INTO sensor_consents(
        tenant_id,sensor_id,descriptor_hash,descriptor_json,status,source_event_id,created_by_run_id,granted_at,revoked_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,sensor_id) DO UPDATE SET
        descriptor_hash=excluded.descriptor_hash,descriptor_json=excluded.descriptor_json,status='granted',
        source_event_id=excluded.source_event_id,created_by_run_id=excluded.created_by_run_id,
        granted_at=excluded.granted_at,revoked_at=NULL,updated_at=excluded.updated_at`).run(
        input.tenantId, sensor.id, hash, JSON.stringify(snapshot(sensor)), "granted", input.sourceEventId ?? null,
        input.createdByRunId ?? null, current, null, current,
      );
      this.store.appendEvent({
        id: id("evt"), tenantId: input.tenantId, stream: `sensor-consent:${sensor.id}`, type: "sensor.consent_granted",
        ...(input.sourceEventId ? { causationId: input.sourceEventId } : {}), ...(input.createdByRunId ? { correlationId: input.createdByRunId } : {}),
        payload: { sensorId: sensor.id, descriptorHash: hash, kind: sensor.kind, dataClasses: sensor.dataClasses, retentionDays: sensor.retentionDays },
      });
    });
    return this.view(input.tenantId, sensor);
  }

  revoke(tenantId: string, sensorId: string): SensorConsentView {
    const prior = this.row(tenantId, sensorId);
    if (!prior) throw new Error(`Sensor consent does not exist: ${sensorId}`);
    if (prior.status === "revoked") return this.viewFromRow(prior, this.byId.get(sensorId));
    const current = nowIso();
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE sensor_consents SET status='revoked',revoked_at=?,updated_at=? WHERE tenant_id=? AND sensor_id=?")
        .run(current, current, tenantId, sensorId);
      this.store.appendEvent({
        id: id("evt"), tenantId, stream: `sensor-consent:${sensorId}`, type: "sensor.consent_revoked",
        payload: { sensorId, priorDescriptorHash: String(prior.descriptor_hash) },
      });
    });
    const updated = this.row(tenantId, sensorId);
    if (!updated) throw new Error(`Sensor consent disappeared: ${sensorId}`);
    return this.viewFromRow(updated, this.byId.get(sensorId));
  }

  get(tenantId: string, sensorId: string): SensorConsentView | undefined {
    const sensor = this.byId.get(sensorId);
    const row = this.row(tenantId, sensorId);
    if (sensor) return this.view(tenantId, sensor);
    return row ? this.viewFromRow(row) : undefined;
  }

  list(tenantId: string): SensorConsentView[] {
    const stored = this.store.db.prepare("SELECT * FROM sensor_consents WHERE tenant_id=? ORDER BY sensor_id").all(tenantId) as Row[];
    const ids = new Set([...this.configured.map((sensor) => sensor.id), ...stored.map((row) => String(row.sensor_id))]);
    return [...ids].sort().flatMap((sensorId) => {
      const view = this.get(tenantId, sensorId);
      return view ? [view] : [];
    });
  }

  asJson(view: SensorConsentView): JsonObject {
    return {
      ...view, sourceEventId: view.sourceEventId ?? null, createdByRunId: view.createdByRunId ?? null,
      grantedAt: view.grantedAt ?? null, revokedAt: view.revokedAt ?? null, updatedAt: view.updatedAt ?? null,
    } as unknown as JsonObject;
  }

  /** Remove retained raw sensor arguments/results after the consented window.
   * Receipts and append-only expiry events retain only cryptographic digests so
   * the audit trail can prove that a read occurred without retaining its data. */
  enforceRetention(tenantId: string, at = new Date()): number {
    let expired = 0;
    for (const sensor of this.configured) {
      const cutoff = new Date(at.getTime() - sensor.retentionDays * 24 * 60 * 60_000).toISOString();
      const rows = this.store.db.prepare(`SELECT id,run_id FROM tool_receipts AS receipt
        WHERE tenant_id=? AND tool_name=? AND completed_at IS NOT NULL AND completed_at<?
          AND NOT EXISTS (
            SELECT 1 FROM events AS event
            WHERE event.tenant_id=receipt.tenant_id AND event.type='sensor.data_expired' AND event.causation_id=receipt.id
          )
        ORDER BY completed_at,id LIMIT 1000`).all(tenantId, sensor.runtimeToolName, cutoff) as Row[];
      for (const row of rows) {
        this.store.transaction(() => {
          const current = this.store.db.prepare(`SELECT arguments_json,output_json,error,completed_at FROM tool_receipts AS receipt
            WHERE tenant_id=? AND id=? AND NOT EXISTS (
              SELECT 1 FROM events AS event
              WHERE event.tenant_id=receipt.tenant_id AND event.type='sensor.data_expired' AND event.causation_id=receipt.id
            )`).get(tenantId, String(row.id)) as Row | undefined;
          if (!current || typeof current.arguments_json !== "string") return;
          const argumentDigest = createHash("sha256").update(current.arguments_json).digest("hex");
          const outputDigest = typeof current.output_json === "string"
            ? createHash("sha256").update(current.output_json).digest("hex") : null;
          const errorDigest = typeof current.error === "string"
            ? createHash("sha256").update(current.error).digest("hex") : null;
          const event = this.store.appendEvent({
            tenantId, stream: `sensor-retention:${sensor.id}`, type: "sensor.data_expired", causationId: String(row.id),
            correlationId: String(row.run_id), payload: {
              sensorId: sensor.id, receiptId: String(row.id), runId: String(row.run_id),
              completedAt: String(current.completed_at), retentionDays: sensor.retentionDays,
              argumentDigest, outputDigest, errorDigest,
            },
          });
          const result = this.store.db.prepare(`UPDATE tool_receipts SET arguments_json=?,output_json=NULL,error=?
            WHERE tenant_id=? AND id=?`).run(
            JSON.stringify({ expired: true, sensorId: sensor.id, argumentDigest, expiryEventId: event.id }),
            errorDigest ? `Sensor error data expired; sha256:${errorDigest}` : null, tenantId, String(row.id),
          );
          if (result.changes === 1) expired += 1;
        });
      }
    }
    return expired;
  }

  private view(tenantId: string, sensor: SensorConfig): SensorConsentView {
    return this.viewFromRow(this.row(tenantId, sensor.id), sensor);
  }

  private viewFromRow(row: Row | undefined, configured?: SensorConfig): SensorConsentView {
    const historical = row ? parseSnapshot(row.descriptor_json) : undefined;
    const sensor = configured ?? historical;
    if (!sensor) throw new Error("Sensor consent has corrupt descriptor metadata");
    const currentHash = configured ? descriptorHash(configured) : String(row?.descriptor_hash ?? descriptorHash(sensor));
    const storedHash = optional(row?.descriptor_hash);
    const storedStatus = optional(row?.status);
    if (row && storedStatus !== "granted" && storedStatus !== "revoked") throw new Error(`Sensor ${sensor.id} has invalid consent state`);
    const consentStatus: SensorConsentStatus = !row ? "ungranted"
      : storedStatus === "granted" && storedHash !== currentHash ? "stale"
        : storedStatus === "granted" ? "granted" : "revoked";
    return {
      ...sensor, dataClasses: [...sensor.dataClasses], configured: Boolean(configured), consentStatus,
      descriptorHash: currentHash,
      ...(optional(row?.source_event_id) ? { sourceEventId: optional(row?.source_event_id) as string } : {}),
      ...(optional(row?.created_by_run_id) ? { createdByRunId: optional(row?.created_by_run_id) as string } : {}),
      ...(optional(row?.granted_at) ? { grantedAt: optional(row?.granted_at) as string } : {}),
      ...(optional(row?.revoked_at) ? { revokedAt: optional(row?.revoked_at) as string } : {}),
      ...(optional(row?.updated_at) ? { updatedAt: optional(row?.updated_at) as string } : {}),
    };
  }

  private row(tenantId: string, sensorId: string): Row | undefined {
    return this.store.db.prepare("SELECT * FROM sensor_consents WHERE tenant_id=? AND sensor_id=?").get(tenantId, sensorId) as Row | undefined;
  }
}
