import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { id, nowIso, stableId } from "./id.ts";
import type {
  EventRecord,
  JobRecord,
  JsonObject,
  JsonValue,
  RunRecord,
  RunState,
  RunStatus,
  RuntimeMessage,
} from "./types.ts";

type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, SqlValue>;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parse<T>(value: SqlValue | undefined, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseRunState(value: SqlValue | undefined, runId: string): RunState | undefined {
  if (typeof value !== "string" || !value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Run ${runId} has corrupt durable state: state_json is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Run ${runId} has corrupt durable state: expected an object`);
  }
  const state = parsed as Partial<RunState>;
  const stringArray = (candidate: unknown): candidate is string[] => Array.isArray(candidate) && candidate.every((item) => typeof item === "string");
  const validInteger = (candidate: unknown, minimum: number): candidate is number => Number.isSafeInteger(candidate) && Number(candidate) >= minimum;
  if (typeof state.system !== "string") throw new Error(`Run ${runId} has corrupt durable state: system is invalid`);
  if (!Array.isArray(state.messages)) throw new Error(`Run ${runId} has corrupt durable state: messages is invalid`);
  if (state.responseRepairReason !== undefined && !["owed_answer_omitted", "unbacked_future_promise"].includes(state.responseRepairReason)) {
    throw new Error(`Run ${runId} has corrupt durable state: responseRepairReason is invalid`);
  }
  if (state.inputPrincipal !== undefined && state.inputPrincipal !== "member" && state.inputPrincipal !== "agent") {
    throw new Error(`Run ${runId} has corrupt durable state: inputPrincipal is invalid`);
  }
  if (state.inputKind !== undefined && ![
    "conversation.user", "schedule.instruction", "work.instruction", "agent.instruction",
  ].includes(state.inputKind)) {
    throw new Error(`Run ${runId} has corrupt durable state: inputKind is invalid`);
  }
  if ((state.inputPrincipal === "member" && state.inputKind !== "conversation.user")
    || (state.inputPrincipal === "agent" && state.inputKind === "conversation.user")) {
    throw new Error(`Run ${runId} has corrupt durable state: input provenance is inconsistent`);
  }
  if (state.release !== undefined) {
    if (!state.release || typeof state.release !== "object" || Array.isArray(state.release)) throw new Error(`Run ${runId} has corrupt durable state: release is invalid`);
    const release = state.release as Record<string, unknown>;
    if (typeof release.id !== "string" || typeof release.digest !== "string" || typeof release.label !== "string"
      || typeof release.rolloutId !== "string" || (release.cohort !== "stable" && release.cohort !== "canary")) {
      throw new Error(`Run ${runId} has corrupt durable state: release is invalid`);
    }
  }
  if (state.policyAutoApproveRisks !== undefined && (!stringArray(state.policyAutoApproveRisks)
    || state.policyAutoApproveRisks.some((risk) => !["read", "local-write", "external-write", "destructive"].includes(risk)))) {
    throw new Error(`Run ${runId} has corrupt durable state: policyAutoApproveRisks is invalid`);
  }
  if (!stringArray(state.toolNames)) throw new Error(`Run ${runId} has corrupt durable state: toolNames is invalid`);
  if (state.authorityToolNames !== undefined && !stringArray(state.authorityToolNames)) {
    throw new Error(`Run ${runId} has corrupt durable state: authorityToolNames is invalid`);
  }
  if (!validInteger(state.iteration, 0)) throw new Error(`Run ${runId} has corrupt durable state: iteration is invalid`);
  if (!Array.isArray(state.pendingCalls)) throw new Error(`Run ${runId} has corrupt durable state: pendingCalls is invalid`);
  if (!validInteger(state.nextToolIndex, 0) || state.nextToolIndex > state.pendingCalls.length) {
    throw new Error(`Run ${runId} has corrupt durable state: nextToolIndex is invalid`);
  }
  if (!validInteger(state.depth, 0)) throw new Error(`Run ${runId} has corrupt durable state: depth is invalid`);
  if (!validInteger(state.tokenBudget, 1)) throw new Error(`Run ${runId} has corrupt durable state: tokenBudget is invalid`);
  if (state.estimatedCostUsd !== undefined && (typeof state.estimatedCostUsd !== "number"
    || !Number.isFinite(state.estimatedCostUsd) || state.estimatedCostUsd < 0 || state.estimatedCostUsd > 1_000_000)) {
    throw new Error(`Run ${runId} has corrupt durable state: estimatedCostUsd is invalid`);
  }
  return state as RunState;
}

function optional(value: SqlValue | undefined): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export interface ApprovalRecord {
  id: string;
  tenantId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  arguments: JsonObject;
  risk: string;
  status: "pending" | "approved" | "denied";
  reason: string;
  createdAt: string;
  decidedAt?: string;
}

export type ToolReceiptStatus = "running" | "succeeded" | "failed" | "uncertain";
export type ToolEffectState = "not_started" | "accepted" | "confirmed" | "failed" | "uncertain";

export interface ToolReceiptRecord {
  id: string;
  tenantId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  arguments: JsonObject;
  output?: JsonValue;
  risk: string;
  evidenceClass: "read" | "local-write" | "external-write" | "destructive";
  evidenceScope: "request" | "outcome";
  status: ToolReceiptStatus;
  effectState: ToolEffectState;
  error?: string;
  leaseToken?: string;
  idempotencyKey: string;
  startedAt: string;
  effectUpdatedAt: string;
  completedAt?: string;
}

export interface ToolReceiptClaim {
  receipt: ToolReceiptRecord;
  claimed: boolean;
}

export type OutboundDeliveryState = "not_started" | "running" | "retryable" | "accepted" | "failed" | "uncertain";

export interface OutboundDeliveryClaim {
  state: "claimed" | "in_flight" | "accepted" | "failed" | "uncertain";
  attempt: number;
  claimToken?: string;
  leaseExpiresAt?: string;
  error?: string;
}

export interface ExpiredOutboundDelivery {
  intentId: string;
  tenantId: string;
  runId: string;
  channel: string;
  peerId: string;
  error: string;
}

export interface OutboundDeliveryReconciliation {
  intentId: string;
  state: "accepted" | "failed";
  channel: string;
  peerId: string;
  eventId: string;
  applied: boolean;
}

export interface SessionRecord {
  id: string;
  tenantId: string;
  channel: string;
  peerId: string;
  deliveryChannel?: string;
  deliveryPeerId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IngressRecord {
  tenantId: string;
  scope: string;
  externalId: string;
  eventId: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
}

export type EvidenceTrust = "owner" | "agent" | "untrusted";

export interface EvidenceRecord {
  id: string;
  tenantId: string;
  sourceEventId: string;
  kind: string;
  trustClass: EvidenceTrust;
  content: string;
  observedAt: string;
  metadata: JsonObject;
  excerpt?: string;
  rank?: number;
}

export type SkillProposalStatus = "proposed" | "approved" | "rejected" | "installed" | "retired";

export interface SkillProposalRecord {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  description: string;
  instructions: string;
  evidenceEventIds: string[];
  status: SkillProposalStatus;
  sourceRunId?: string;
  sourceEventId: string;
  supersedesId?: string;
  installedPath?: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
}

export const CURRENT_SCHEMA_VERSION = 58;
const DEFAULT_LEASE_MS = 30_000;
const EVIDENCE_STOP_WORDS = new Set([
  "about", "after", "again", "also", "because", "been", "before", "could", "does", "from", "have", "into", "just",
  "more", "said", "should", "that", "their", "them", "then", "there", "these", "they", "think", "this", "what", "when",
  "where", "which", "with", "would", "your", "you", "were", "will", "did", "the", "and", "for", "are", "but", "not",
]);

export class SqliteStore {
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  private jobReleaseResolver?: (tenantId: string) => string;

  constructor(path: string, options: { synchronous?: "NORMAL" | "FULL"; busyTimeoutMs?: number } = {}) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    const synchronous = options.synchronous ?? "NORMAL";
    const busyTimeout = Math.max(1_000, Math.floor(options.busyTimeoutMs ?? 5_000));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=${synchronous}; PRAGMA busy_timeout=${busyTimeout}; PRAGMA temp_store=MEMORY; PRAGMA journal_size_limit=67108864;`);
    this.transaction(() => this.migrate());
    this.db.exec("PRAGMA trusted_schema=OFF;");
    this.secureFiles(path);
  }

  close(): void {
    try { this.db.exec("PRAGMA wal_checkpoint(PASSIVE)"); } catch { /* another process may own the checkpoint */ }
    this.db.close();
  }

  checkpoint(mode: "PASSIVE" | "FULL" | "TRUNCATE" = "PASSIVE"): void {
    this.db.exec(`PRAGMA wal_checkpoint(${mode})`);
  }

  /** Runtime-owned stores pin every newly admitted job to behavior at enqueue.
   * Standalone storage utilities may omit this resolver, but workers must never
   * execute those legacy/unattributed jobs. */
  setJobReleaseResolver(resolver: (tenantId: string) => string): void {
    this.jobReleaseResolver = resolver;
  }

  private secureFiles(path: string): void {
    if (process.platform === "win32") return;
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
  }

  schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as Row;
    return Number(row.user_version ?? 0);
  }

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL,
        description TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenant_lifecycle_audit (
        id TEXT PRIMARY KEY,
        tenant_hash TEXT NOT NULL,
        operation TEXT NOT NULL,
        export_digest TEXT,
        state_digest TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        row_counts_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tenant_lifecycle_audit_tenant_time
        ON tenant_lifecycle_audit(tenant_hash,occurred_at);

      CREATE TABLE IF NOT EXISTS release_manifests (
        id TEXT PRIMARY KEY,
        distribution_id TEXT NOT NULL,
        label TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        manifest_digest TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS release_manifests_distribution_created
        ON release_manifests(distribution_id,created_at);

      CREATE TABLE IF NOT EXISTS release_rollouts (
        id TEXT PRIMARY KEY,
        distribution_id TEXT NOT NULL,
        stable_release_id TEXT NOT NULL,
        candidate_release_id TEXT,
        candidate_basis_points INTEGER NOT NULL,
        cohort_salt TEXT NOT NULL,
        rollback_release_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ended_at TEXT,
        FOREIGN KEY(stable_release_id) REFERENCES release_manifests(id),
        FOREIGN KEY(candidate_release_id) REFERENCES release_manifests(id),
        FOREIGN KEY(rollback_release_id) REFERENCES release_manifests(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS release_rollouts_one_active
        ON release_rollouts(distribution_id) WHERE status='active';

      CREATE TABLE IF NOT EXISTS release_assignments (
        tenant_id TEXT NOT NULL,
        rollout_id TEXT NOT NULL,
        release_id TEXT NOT NULL,
        cohort TEXT NOT NULL,
        assigned_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,rollout_id),
        FOREIGN KEY(rollout_id) REFERENCES release_rollouts(id),
        FOREIGN KEY(release_id) REFERENCES release_manifests(id)
      );
      CREATE INDEX IF NOT EXISTS release_assignments_release_cohort
        ON release_assignments(release_id,cohort,assigned_at);

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        correlation_id TEXT,
        causation_id TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_tenant_stream_seq ON events(tenant_id, stream, seq);
      CREATE INDEX IF NOT EXISTS events_tenant_type_at ON events(tenant_id, type, at);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        delivery_channel TEXT,
        delivery_peer_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tenant_id, channel, peer_id)
      );

      CREATE TABLE IF NOT EXISTS connector_routes (
        tenant_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        external_thread_id TEXT NOT NULL,
        status TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, connector_id, peer_id),
        UNIQUE(tenant_id, connector_id, external_thread_id)
      );

      CREATE TABLE IF NOT EXISTS promises (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        due_at TEXT NOT NULL,
        status TEXT NOT NULL,
        work_order_id TEXT,
        resolution TEXT,
        created_by_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS promises_due ON promises(tenant_id,status,due_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        parts_json TEXT NOT NULL,
        phase TEXT,
        created_at TEXT NOT NULL,
        event_id TEXT,
        delivery_state TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS messages_session_created ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_tenant_event ON messages(tenant_id,event_id);

      CREATE TABLE IF NOT EXISTS member_outcome_feedback (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        target_message_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        context_advantage TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id,source_event_id),
        FOREIGN KEY(session_id) REFERENCES sessions(id),
        FOREIGN KEY(target_message_id) REFERENCES messages(id),
        FOREIGN KEY(source_event_id) REFERENCES events(id)
      );
      CREATE INDEX IF NOT EXISTS member_outcome_feedback_tenant_created
        ON member_outcome_feedback(tenant_id,created_at);
      CREATE INDEX IF NOT EXISTS member_outcome_feedback_target
        ON member_outcome_feedback(tenant_id,target_message_id,created_at);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        parent_run_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        model_role TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        release_id TEXT,
        subject_type TEXT,
        subject_id TEXT,
        release_digest TEXT,
        release_label TEXT,
        rollout_id TEXT,
        release_cohort TEXT,
        input TEXT NOT NULL,
        output TEXT,
        state_json TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_expires_at TEXT,
        resume_not_before TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS runs_tenant_status_updated ON runs(tenant_id, status, updated_at);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        UNIQUE(run_id, tool_call_id),
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );

      CREATE TABLE IF NOT EXISTS tool_receipts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        output_json TEXT,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        effect_state TEXT NOT NULL DEFAULT 'not_started',
        effect_updated_at TEXT NOT NULL,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(run_id, tool_call_id)
      );

      CREATE TABLE IF NOT EXISTS tool_receipt_reconciliations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        receipt_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        prior_status TEXT NOT NULL,
        prior_effect_state TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(receipt_id) REFERENCES tool_receipts(id),
        FOREIGN KEY(run_id) REFERENCES runs(id),
        FOREIGN KEY(event_id) REFERENCES events(id)
      );
      CREATE INDEX IF NOT EXISTS tool_receipt_reconciliations_tenant_created
        ON tool_receipt_reconciliations(tenant_id,created_at);

      CREATE TABLE IF NOT EXISTS run_state_quarantine (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        state_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        quarantined_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );

      CREATE TABLE IF NOT EXISTS recovery_quarantine (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        record_kind TEXT NOT NULL,
        record_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        raw_value TEXT NOT NULL,
        reason TEXT NOT NULL,
        quarantined_at TEXT NOT NULL,
        remediated_at TEXT,
        UNIQUE(tenant_id,record_kind,record_id,field_name)
      );
      CREATE INDEX IF NOT EXISTS recovery_quarantine_tenant_time ON recovery_quarantine(tenant_id,quarantined_at);

      CREATE TABLE IF NOT EXISTS personal_nodes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        node_key TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        first_observed_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tenant_id,kind,node_key)
      );
      CREATE INDEX IF NOT EXISTS personal_nodes_tenant_kind_updated ON personal_nodes(tenant_id,kind,updated_at);

      CREATE TABLE IF NOT EXISTS source_aliases (
        tenant_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        source_node_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,alias),
        FOREIGN KEY(source_node_id) REFERENCES personal_nodes(id)
      );
      CREATE INDEX IF NOT EXISTS source_aliases_node ON source_aliases(tenant_id,source_node_id);

      CREATE TABLE IF NOT EXISTS personal_node_evidence (
        tenant_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,node_id,event_id,relation),
        FOREIGN KEY(node_id) REFERENCES personal_nodes(id),
        FOREIGN KEY(event_id) REFERENCES events(id)
      );
      CREATE INDEX IF NOT EXISTS personal_node_evidence_event ON personal_node_evidence(tenant_id,event_id);

      CREATE TABLE IF NOT EXISTS personal_edges (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        from_node_id TEXT NOT NULL,
        to_node_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id,from_node_id,to_node_id,relation,source_event_id),
        FOREIGN KEY(from_node_id) REFERENCES personal_nodes(id),
        FOREIGN KEY(to_node_id) REFERENCES personal_nodes(id),
        FOREIGN KEY(source_event_id) REFERENCES events(id)
      );
      CREATE INDEX IF NOT EXISTS personal_edges_from ON personal_edges(tenant_id,from_node_id,created_at);
      CREATE INDEX IF NOT EXISTS personal_edges_to ON personal_edges(tenant_id,to_node_id,created_at);

      CREATE TABLE IF NOT EXISTS source_affinity_signals (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source_node_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        weight REAL NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id,source_node_id,source_event_id,kind),
        FOREIGN KEY(source_node_id) REFERENCES personal_nodes(id),
        FOREIGN KEY(source_event_id) REFERENCES events(id)
      );
      CREATE INDEX IF NOT EXISTS source_affinity_signals_source ON source_affinity_signals(tenant_id,source_node_id,created_at);

      CREATE TABLE IF NOT EXISTS research_commissions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        objective TEXT NOT NULL,
        why_now TEXT NOT NULL,
        status TEXT NOT NULL,
        minimum_independent_sources INTEGER NOT NULL,
        required_primary_sources INTEGER NOT NULL,
        retrieval_tool_names_json TEXT NOT NULL,
        work_order_id TEXT,
        failure_reason TEXT,
        created_by_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(tenant_id,work_order_id),
        FOREIGN KEY(source_event_id) REFERENCES events(id),
        FOREIGN KEY(session_id) REFERENCES sessions(id),
        FOREIGN KEY(work_order_id) REFERENCES work_orders(id)
      );
      CREATE INDEX IF NOT EXISTS research_commissions_tenant_status_updated
        ON research_commissions(tenant_id,status,updated_at);

      CREATE TABLE IF NOT EXISTS research_source_receipts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        commission_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        retrieval_receipt_id TEXT NOT NULL,
        retrieval_tool_name TEXT NOT NULL,
        url TEXT NOT NULL,
        domain TEXT NOT NULL,
        title TEXT NOT NULL,
        publisher TEXT NOT NULL,
        creator TEXT,
        published_at TEXT,
        source_class TEXT NOT NULL,
        coverage TEXT NOT NULL,
        claim TEXT NOT NULL,
        quality_basis TEXT NOT NULL,
        limitations TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id,commission_id,url,claim),
        FOREIGN KEY(commission_id) REFERENCES research_commissions(id),
        FOREIGN KEY(run_id) REFERENCES runs(id),
        FOREIGN KEY(retrieval_receipt_id) REFERENCES tool_receipts(id)
      );
      CREATE INDEX IF NOT EXISTS research_sources_commission_created
        ON research_source_receipts(tenant_id,commission_id,created_at);

      CREATE TABLE IF NOT EXISTS research_findings (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        commission_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        mapping TEXT NOT NULL,
        limitations TEXT NOT NULL,
        changed_implication TEXT NOT NULL,
        counterevidence TEXT NOT NULL,
        source_receipt_ids_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id,commission_id),
        FOREIGN KEY(commission_id) REFERENCES research_commissions(id),
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE INDEX IF NOT EXISTS research_findings_commission_created
        ON research_findings(tenant_id,commission_id,created_at);

      CREATE TABLE IF NOT EXISTS inquiries (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        session_id TEXT,
        trigger_kind TEXT NOT NULL,
        trigger_basis TEXT NOT NULL,
        question TEXT NOT NULL,
        concrete_benefit TEXT NOT NULL,
        answerability TEXT NOT NULL CHECK(answerability IN ('records','public','member','unavailable')),
        status TEXT NOT NULL CHECK(status IN ('proposed','investigating','resolved','insufficient','needs_member','expired','retired')),
        competing_hypotheses_json TEXT NOT NULL,
        falsifiers_json TEXT NOT NULL,
        retrieval_plan_json TEXT NOT NULL,
        max_steps INTEGER NOT NULL CHECK(max_steps BETWEEN 1 AND 32),
        stop_condition TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        finding TEXT,
        counterevidence TEXT,
        remaining_uncertainty TEXT,
        next_permitted_consequence TEXT,
        member_question TEXT,
        foreground_disposition TEXT NOT NULL CHECK(foreground_disposition IN ('backstage','natural_opening','interrupt','suppressed','expired')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE(id,tenant_id),
        FOREIGN KEY(source_event_id) REFERENCES events(id),
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS inquiries_tenant_status_expiry
        ON inquiries(tenant_id,status,expires_at,updated_at);
      CREATE INDEX IF NOT EXISTS inquiries_tenant_source
        ON inquiries(tenant_id,source_event_id,created_at);

      CREATE TABLE IF NOT EXISTS inquiry_foreground_decisions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        inquiry_id TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('backstage','natural_opening','interrupt','suppressed','expired')),
        member_delta REAL NOT NULL CHECK(member_delta BETWEEN 0 AND 1),
        why_now TEXT NOT NULL,
        best_quiet_alternative TEXT NOT NULL,
        answer_unavailable_privately INTEGER NOT NULL CHECK(answer_unavailable_privately IN (0,1)),
        timing_loss REAL NOT NULL CHECK(timing_loss BETWEEN 0 AND 1),
        natural_opening_event_id TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(inquiry_id,tenant_id) REFERENCES inquiries(id,tenant_id),
        FOREIGN KEY(natural_opening_event_id) REFERENCES events(id)
      );
      CREATE INDEX IF NOT EXISTS inquiry_foreground_decisions_inquiry
        ON inquiry_foreground_decisions(tenant_id,inquiry_id,created_at);

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        release_id TEXT,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        run_after TEXT NOT NULL,
        locked_at TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(status, run_after, created_at);

      CREATE TABLE IF NOT EXISTS outbound_deliveries (
        intent_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        claim_token TEXT,
        lease_expires_at TEXT,
        acceptance_event_id TEXT,
        accepted_at TEXT,
        delivered_at TEXT,
        read_at TEXT,
        failed_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbound_deliveries_tenant_state
        ON outbound_deliveries(tenant_id,state,updated_at);

      CREATE TABLE IF NOT EXISTS relationship_admissions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        delivery_key TEXT NOT NULL,
        delivery_intent_id TEXT NOT NULL,
        delivery_class TEXT NOT NULL,
        precedence INTEGER NOT NULL,
        attention_class TEXT NOT NULL,
        urgency REAL NOT NULL,
        content_digest TEXT NOT NULL,
        authority_ref TEXT NOT NULL,
        binding_digest TEXT NOT NULL,
        intervention_id TEXT,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        not_before TEXT,
        expires_at TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        admitted_at TEXT,
        settled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tenant_id,delivery_intent_id),
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS relationship_admissions_one_active
        ON relationship_admissions(tenant_id,session_id) WHERE status='admitted';
      CREATE INDEX IF NOT EXISTS relationship_admissions_due
        ON relationship_admissions(tenant_id,session_id,status,not_before,precedence,created_at);
      CREATE INDEX IF NOT EXISTS relationship_admissions_delivery
        ON relationship_admissions(tenant_id,delivery_intent_id,status);

      CREATE TABLE IF NOT EXISTS quality_review_plans (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK(scope_kind='tenant'),
        scope_key TEXT NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        population_version TEXT NOT NULL,
        rubric_version TEXT NOT NULL,
        evidence_origin TEXT NOT NULL CHECK(evidence_origin IN ('live_external','synthetic')),
        strata_json TEXT NOT NULL,
        sample_sizes_json TEXT NOT NULL,
        thresholds_json TEXT NOT NULL,
        seed_commitment TEXT NOT NULL,
        seed_reveal TEXT,
        status TEXT NOT NULL CHECK(status IN ('registered','frozen','closed')),
        registered_at TEXT NOT NULL,
        frozen_at TEXT,
        population_digest TEXT,
        manifest_digest TEXT NOT NULL,
        UNIQUE(id,tenant_id)
      );
      CREATE INDEX IF NOT EXISTS quality_review_plans_scope_window
        ON quality_review_plans(scope_kind,scope_key,window_start,window_end);

      CREATE TABLE IF NOT EXISTS quality_review_units (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        stratum TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('relationship_admission','silence_event')),
        target_id TEXT NOT NULL,
        decision_kind TEXT NOT NULL,
        selected INTEGER NOT NULL CHECK(selected IN (0,1)),
        selection_rank TEXT NOT NULL,
        inclusion_probability REAL NOT NULL CHECK(inclusion_probability>0 AND inclusion_probability<=1),
        packet_json TEXT NOT NULL,
        packet_digest TEXT NOT NULL,
        UNIQUE(plan_id,target_kind,target_id),
        UNIQUE(id,plan_id,tenant_id),
        FOREIGN KEY(plan_id,tenant_id) REFERENCES quality_review_plans(id,tenant_id),
        FOREIGN KEY(source_event_id) REFERENCES events(id)
      );
      CREATE INDEX IF NOT EXISTS quality_review_units_plan_stratum
        ON quality_review_units(plan_id,stratum,selected,selection_rank);

      CREATE TABLE IF NOT EXISTS quality_reviews (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        reviewer_id TEXT NOT NULL,
        reviewer_kind TEXT NOT NULL CHECK(reviewer_kind='external_human'),
        review_role TEXT NOT NULL CHECK(review_role IN ('primary','adjudicator')),
        rubric_version TEXT NOT NULL,
        worthwhile TEXT NOT NULL CHECK(worthwhile IN ('yes','no','unknown')),
        harmful TEXT NOT NULL CHECK(harmful IN ('yes','no','unknown')),
        unnecessary_interruption TEXT NOT NULL CHECK(unnecessary_interruption IN ('yes','no','not_applicable','unknown')),
        missed_worthwhile_opportunity TEXT NOT NULL CHECK(missed_worthwhile_opportunity IN ('yes','no','not_applicable','unknown')),
        unsupported_inference TEXT NOT NULL CHECK(unsupported_inference IN ('yes','no','unknown')),
        action_useful TEXT NOT NULL CHECK(action_useful IN ('yes','no','not_applicable','unknown')),
        rationale TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        supersedes_review_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        UNIQUE(id,plan_id,tenant_id),
        FOREIGN KEY(unit_id,plan_id,tenant_id) REFERENCES quality_review_units(id,plan_id,tenant_id),
        FOREIGN KEY(supersedes_review_id,plan_id,tenant_id) REFERENCES quality_reviews(id,plan_id,tenant_id)
      );
      CREATE INDEX IF NOT EXISTS quality_reviews_unit_reviewer
        ON quality_reviews(plan_id,unit_id,reviewer_id,created_at);

      CREATE TRIGGER IF NOT EXISTS quality_review_plans_preregistration_immutable
      BEFORE UPDATE ON quality_review_plans
      WHEN NEW.scope_kind<>OLD.scope_kind OR NEW.scope_key<>OLD.scope_key
        OR NEW.window_start<>OLD.window_start OR NEW.window_end<>OLD.window_end
        OR NEW.population_version<>OLD.population_version OR NEW.rubric_version<>OLD.rubric_version
        OR NEW.evidence_origin<>OLD.evidence_origin OR NEW.strata_json<>OLD.strata_json
        OR NEW.sample_sizes_json<>OLD.sample_sizes_json OR NEW.thresholds_json<>OLD.thresholds_json
        OR NEW.seed_commitment<>OLD.seed_commitment OR NEW.registered_at<>OLD.registered_at
        OR NEW.manifest_digest<>OLD.manifest_digest
      BEGIN SELECT RAISE(ABORT,'quality review preregistration is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS quality_review_plans_lifecycle_append_only
      BEFORE UPDATE ON quality_review_plans
      WHEN (OLD.status='registered' AND NEW.status<>'frozen')
        OR (OLD.status='frozen' AND NEW.status<>'closed')
        OR OLD.status='closed'
        OR (OLD.status<>'registered' AND (
          NEW.seed_reveal IS NOT OLD.seed_reveal OR NEW.frozen_at IS NOT OLD.frozen_at
          OR NEW.population_digest IS NOT OLD.population_digest
        ))
      BEGIN SELECT RAISE(ABORT,'quality review lifecycle is append-only'); END;
      CREATE TABLE IF NOT EXISTS tenant_deletion_permits (
        tenant_id TEXT PRIMARY KEY,
        audit_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS quality_review_plans_no_delete
      BEFORE DELETE ON quality_review_plans
      WHEN NOT EXISTS(SELECT 1 FROM tenant_deletion_permits WHERE tenant_id=OLD.tenant_id)
      BEGIN SELECT RAISE(ABORT,'quality review preregistration is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS quality_review_units_immutable
      BEFORE UPDATE ON quality_review_units BEGIN SELECT RAISE(ABORT,'quality review population is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS quality_review_units_no_delete
      BEFORE DELETE ON quality_review_units
      WHEN NOT EXISTS(SELECT 1 FROM tenant_deletion_permits WHERE tenant_id=OLD.tenant_id)
      BEGIN SELECT RAISE(ABORT,'quality review population is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS quality_reviews_immutable
      BEFORE UPDATE ON quality_reviews BEGIN SELECT RAISE(ABORT,'quality reviews are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS quality_reviews_no_delete
      BEFORE DELETE ON quality_reviews
      WHEN NOT EXISTS(SELECT 1 FROM tenant_deletion_permits WHERE tenant_id=OLD.tenant_id)
      BEGIN SELECT RAISE(ABORT,'quality reviews are append-only'); END;

      CREATE TABLE IF NOT EXISTS outbound_delivery_reconciliations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        intent_id TEXT NOT NULL UNIQUE,
        decision TEXT NOT NULL,
        prior_state TEXT NOT NULL,
        provider_message_id TEXT,
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(intent_id) REFERENCES outbound_deliveries(intent_id),
        FOREIGN KEY(event_id) REFERENCES events(id)
      );
      CREATE INDEX IF NOT EXISTS outbound_delivery_reconciliations_tenant_created
        ON outbound_delivery_reconciliations(tenant_id,created_at);

      CREATE TABLE IF NOT EXISTS retained_agents (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        owner_session_id TEXT NOT NULL,
        parent_agent_id TEXT,
        admitted_by_run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        objective TEXT NOT NULL,
        deliverable TEXT NOT NULL,
        model_role TEXT NOT NULL,
        token_budget INTEGER NOT NULL,
        depth INTEGER NOT NULL,
        allowed_tools_json TEXT NOT NULL,
        status TEXT NOT NULL,
        last_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        retired_at TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id),
        FOREIGN KEY(owner_session_id) REFERENCES sessions(id),
        FOREIGN KEY(parent_agent_id) REFERENCES retained_agents(id),
        FOREIGN KEY(admitted_by_run_id) REFERENCES runs(id)
      );
      CREATE INDEX IF NOT EXISTS retained_agents_tenant_status_updated ON retained_agents(tenant_id,status,updated_at);
      CREATE INDEX IF NOT EXISTS retained_agents_owner_session ON retained_agents(tenant_id,owner_session_id,updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS retained_agents_session ON retained_agents(tenant_id,session_id);

      CREATE TABLE IF NOT EXISTS agent_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        sender_agent_id TEXT,
        sender_run_id TEXT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        completed_at TEXT,
        FOREIGN KEY(agent_id) REFERENCES retained_agents(id),
        FOREIGN KEY(sender_agent_id) REFERENCES retained_agents(id),
        FOREIGN KEY(sender_run_id) REFERENCES runs(id),
        FOREIGN KEY(run_id) REFERENCES runs(id),
        UNIQUE(tenant_id,idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS agent_messages_agent_seq ON agent_messages(tenant_id,agent_id,seq);
      CREATE INDEX IF NOT EXISTS agent_messages_status_created ON agent_messages(tenant_id,status,created_at);

      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        success_contract TEXT NOT NULL,
        status TEXT NOT NULL,
        agent_id TEXT,
        created_by_run_id TEXT,
        source_event_id TEXT,
        source_quote TEXT,
        standards_mandate_id TEXT,
        gate_type TEXT NOT NULL,
        gate_config_json TEXT NOT NULL,
        max_continuations INTEGER NOT NULL,
        continuation_count INTEGER NOT NULL DEFAULT 0,
        max_tokens INTEGER NOT NULL,
        spent_tokens INTEGER NOT NULL DEFAULT 0,
        deadline_at TEXT,
        last_gate_input_hash TEXT,
        last_gate_status TEXT,
        last_gate_reason TEXT,
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY(agent_id) REFERENCES retained_agents(id),
        FOREIGN KEY(created_by_run_id) REFERENCES runs(id)
      );
      CREATE INDEX IF NOT EXISTS goals_tenant_status_updated ON goals(tenant_id,status,updated_at);
      CREATE INDEX IF NOT EXISTS goals_agent_status ON goals(tenant_id,agent_id,status);

      CREATE TABLE IF NOT EXISTS goal_gate_results (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        passed INTEGER NOT NULL,
        reason TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(goal_id) REFERENCES goals(id),
        UNIQUE(tenant_id,goal_id,input_hash)
      );
      CREATE INDEX IF NOT EXISTS goal_gate_results_goal_seq ON goal_gate_results(tenant_id,goal_id,seq);

      CREATE TABLE IF NOT EXISTS goal_reality_checks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        decision_quote TEXT NOT NULL,
        rendered TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        run_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        surfaced_at TEXT NOT NULL,
        UNIQUE(tenant_id,goal_id,input_hash)
      );
      CREATE INDEX IF NOT EXISTS goal_reality_checks_goal_time ON goal_reality_checks(tenant_id,goal_id,surfaced_at);

      CREATE TABLE IF NOT EXISTS goal_motive_hypotheses (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        hypothesis TEXT NOT NULL,
        strongest_alternative TEXT NOT NULL,
        falsifier TEXT NOT NULL,
        origin_class TEXT NOT NULL,
        decision_cues_json TEXT NOT NULL,
        evidence_event_ids_json TEXT NOT NULL,
        substitution_json TEXT,
        reference_peak_json TEXT,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        source_run_id TEXT,
        supersedes_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        superseded_at TEXT,
        FOREIGN KEY(goal_id) REFERENCES goals(id),
        FOREIGN KEY(source_event_id) REFERENCES events(id),
        FOREIGN KEY(source_run_id) REFERENCES runs(id),
        FOREIGN KEY(supersedes_id) REFERENCES goal_motive_hypotheses(id)
      );
      CREATE INDEX IF NOT EXISTS goal_motives_goal_status_updated
        ON goal_motive_hypotheses(tenant_id,goal_id,status,updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS goal_motives_one_active
        ON goal_motive_hypotheses(tenant_id,goal_id) WHERE status='active';

      CREATE TABLE IF NOT EXISTS refinement_proposals (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        target_id TEXT NOT NULL,
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        expected_effect TEXT NOT NULL,
        patch_json TEXT NOT NULL,
        evidence_event_ids_json TEXT NOT NULL,
        source_run_id TEXT,
        source_event_id TEXT NOT NULL,
        supersedes_id TEXT,
        base_version INTEGER NOT NULL,
        proposed_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        review_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT,
        applied_at TEXT,
        retired_at TEXT,
        FOREIGN KEY(source_run_id) REFERENCES runs(id),
        FOREIGN KEY(supersedes_id) REFERENCES refinement_proposals(id)
      );
      CREATE INDEX IF NOT EXISTS refinement_proposals_tenant_status_created ON refinement_proposals(tenant_id,status,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS refinement_proposals_one_live_successor ON refinement_proposals(supersedes_id)
        WHERE supersedes_id IS NOT NULL AND status IN ('proposed','approved','applied');

      CREATE TABLE IF NOT EXISTS harness_overlays (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        target_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        source_proposal_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        superseded_at TEXT,
        retired_at TEXT,
        FOREIGN KEY(source_proposal_id) REFERENCES refinement_proposals(id),
        UNIQUE(tenant_id,kind,scope,target_id,version)
      );
      CREATE INDEX IF NOT EXISTS harness_overlays_active ON harness_overlays(tenant_id,kind,scope,target_id,status);
      CREATE UNIQUE INDEX IF NOT EXISTS harness_overlays_one_active ON harness_overlays(tenant_id,kind,scope,target_id) WHERE status='active';

      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        interval_minutes INTEGER,
        next_run_at TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status,next_run_at);

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        statement TEXT NOT NULL,
        normalized_statement TEXT NOT NULL,
        confidence REAL NOT NULL,
        salience REAL NOT NULL,
        status TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        observed_at TEXT NOT NULL,
        last_confirmed_at TEXT,
        source_event_id TEXT NOT NULL,
        supersedes_id TEXT,
        user_confirmed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS memories_tenant_status_kind ON memories(tenant_id, status, kind);
      CREATE INDEX IF NOT EXISTS memories_tenant_normalized ON memories(tenant_id, normalized_statement);

      CREATE TABLE IF NOT EXISTS skill_proposals (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        evidence_event_ids_json TEXT NOT NULL,
        status TEXT NOT NULL,
        source_run_id TEXT,
        source_event_id TEXT NOT NULL,
        supersedes_id TEXT,
        installed_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT,
        UNIQUE(tenant_id,name,version)
      );
      CREATE INDEX IF NOT EXISTS skill_proposals_tenant_status_created ON skill_proposals(tenant_id,status,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS skill_proposals_one_active_revision ON skill_proposals(supersedes_id)
        WHERE supersedes_id IS NOT NULL AND status IN ('proposed','approved','installed');

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_uri TEXT NOT NULL,
        title TEXT,
        content TEXT,
        metadata_json TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id, source_uri)
      );

      CREATE TABLE IF NOT EXISTS artifact_versions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        version_digest TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_uri TEXT NOT NULL,
        title TEXT,
        content TEXT,
        metadata_json TEXT NOT NULL,
        coverage TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(artifact_id) REFERENCES artifacts(id),
        UNIQUE(tenant_id,artifact_id,version_digest)
      );
      CREATE INDEX IF NOT EXISTS artifact_versions_tenant_artifact_created
        ON artifact_versions(tenant_id,artifact_id,created_at);

      CREATE TABLE IF NOT EXISTS original_blobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        data_base64 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id,sha256),
        UNIQUE(id,tenant_id)
      );

      CREATE TABLE IF NOT EXISTS original_blob_refs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        blob_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        source_uri TEXT NOT NULL,
        final_uri TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        filename TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(blob_id,tenant_id) REFERENCES original_blobs(id,tenant_id),
        UNIQUE(tenant_id,source_event_id,attachment_id)
      );
      CREATE INDEX IF NOT EXISTS original_blob_refs_tenant_source
        ON original_blob_refs(tenant_id,source_event_id,created_at);

      CREATE TABLE IF NOT EXISTS interventions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        topic_key TEXT NOT NULL,
        score REAL NOT NULL,
        urgency REAL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        content TEXT,
        channel TEXT,
        peer_id TEXT,
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_delivery_error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE INDEX IF NOT EXISTS interventions_tenant_created ON interventions(tenant_id, created_at);

      CREATE TABLE IF NOT EXISTS perception_hypotheses (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        topic_key TEXT NOT NULL,
        statement TEXT NOT NULL,
        rationale TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        specificity REAL NOT NULL,
        novelty REAL NOT NULL,
        perceptual_value REAL NOT NULL,
        genericity REAL NOT NULL,
        sensitivity REAL NOT NULL,
        interruption_cost REAL NOT NULL,
        alternative_explanations_json TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        session_id TEXT,
        channel TEXT,
        peer_id TEXT,
        supersedes_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ready_at TEXT,
        surfaced_at TEXT,
        resolved_at TEXT,
        UNIQUE(tenant_id,fingerprint),
        FOREIGN KEY(supersedes_id) REFERENCES perception_hypotheses(id)
      );
      CREATE INDEX IF NOT EXISTS perception_hypotheses_tenant_status_updated
        ON perception_hypotheses(tenant_id,status,updated_at);
      CREATE INDEX IF NOT EXISTS perception_hypotheses_session_status
        ON perception_hypotheses(tenant_id,session_id,status,updated_at);

      CREATE TABLE IF NOT EXISTS perception_evidence (
        tenant_id TEXT NOT NULL,
        hypothesis_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        rationale TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,hypothesis_id,event_id,relation),
        FOREIGN KEY(hypothesis_id) REFERENCES perception_hypotheses(id),
        FOREIGN KEY(event_id) REFERENCES events(id)
      );
      CREATE INDEX IF NOT EXISTS perception_evidence_hypothesis_observed
        ON perception_evidence(tenant_id,hypothesis_id,observed_at);

      CREATE TABLE IF NOT EXISTS perception_feedback (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        hypothesis_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id,hypothesis_id,source_event_id),
        FOREIGN KEY(hypothesis_id) REFERENCES perception_hypotheses(id),
        FOREIGN KEY(source_event_id) REFERENCES events(id)
      );
      CREATE INDEX IF NOT EXISTS perception_feedback_hypothesis_created
        ON perception_feedback(tenant_id,hypothesis_id,created_at);

      CREATE TABLE IF NOT EXISTS mandates (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        service_contract TEXT NOT NULL,
        status TEXT NOT NULL,
        authority_json TEXT NOT NULL,
        delivery_json TEXT NOT NULL,
        source_event_id TEXT,
        created_by_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approved_at TEXT,
        retired_at TEXT
      );
      CREATE INDEX IF NOT EXISTS mandates_tenant_status_updated ON mandates(tenant_id,status,updated_at);

      CREATE TABLE IF NOT EXISTS mandate_authority_uses (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        mandate_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        rule_index INTEGER NOT NULL,
        used_at TEXT NOT NULL,
        UNIQUE(tenant_id,run_id,tool_call_id),
        FOREIGN KEY(mandate_id) REFERENCES mandates(id),
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE INDEX IF NOT EXISTS mandate_authority_uses_mandate_used
        ON mandate_authority_uses(tenant_id,mandate_id,used_at);

      CREATE TABLE IF NOT EXISTS sensor_consents (
        tenant_id TEXT NOT NULL,
        sensor_id TEXT NOT NULL,
        descriptor_hash TEXT NOT NULL,
        descriptor_json TEXT NOT NULL,
        status TEXT NOT NULL,
        source_event_id TEXT,
        created_by_run_id TEXT,
        granted_at TEXT,
        revoked_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,sensor_id)
      );
      CREATE INDEX IF NOT EXISTS sensor_consents_tenant_status
        ON sensor_consents(tenant_id,status,updated_at);

      CREATE TABLE IF NOT EXISTS matters (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        mandate_id TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        source_event_id TEXT,
        created_by_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        closed_at TEXT,
        FOREIGN KEY(mandate_id) REFERENCES mandates(id)
      );
      CREATE INDEX IF NOT EXISTS matters_tenant_status_activity ON matters(tenant_id,status,last_activity_at);

      CREATE TABLE IF NOT EXISTS matter_evidence (
        tenant_id TEXT NOT NULL,
        matter_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,matter_id,event_id),
        FOREIGN KEY(matter_id) REFERENCES matters(id),
        FOREIGN KEY(event_id) REFERENCES events(id)
      );

      CREATE TABLE IF NOT EXISTS prepared_artifacts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        matter_id TEXT,
        mandate_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        created_by_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        used_at TEXT,
        FOREIGN KEY(matter_id) REFERENCES matters(id),
        FOREIGN KEY(mandate_id) REFERENCES mandates(id)
      );
      CREATE INDEX IF NOT EXISTS prepared_artifacts_tenant_status_updated ON prepared_artifacts(tenant_id,status,updated_at);

      CREATE TABLE IF NOT EXISTS attention_items (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        matter_id TEXT,
        artifact_id TEXT,
        source_event_id TEXT,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        reason TEXT NOT NULL,
        priority INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT,
        resolved_at TEXT,
        FOREIGN KEY(matter_id) REFERENCES matters(id),
        FOREIGN KEY(artifact_id) REFERENCES prepared_artifacts(id)
      );
      CREATE INDEX IF NOT EXISTS attention_items_tenant_status_priority ON attention_items(tenant_id,status,priority,created_at);

      CREATE TABLE IF NOT EXISTS consequence_plans (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        session_id TEXT,
        disposition TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        rationale TEXT NOT NULL,
        member_delta TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL,
        novelty REAL NOT NULL,
        usefulness REAL NOT NULL,
        urgency REAL NOT NULL,
        artifact_id TEXT,
        matter_id TEXT,
        attention_id TEXT,
        work_order_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tenant_id,source_kind,source_id),
        FOREIGN KEY(source_event_id) REFERENCES events(id),
        FOREIGN KEY(session_id) REFERENCES sessions(id),
        FOREIGN KEY(artifact_id) REFERENCES prepared_artifacts(id),
        FOREIGN KEY(matter_id) REFERENCES matters(id),
        FOREIGN KEY(attention_id) REFERENCES attention_items(id),
        FOREIGN KEY(work_order_id) REFERENCES work_orders(id)
      );
      CREATE INDEX IF NOT EXISTS consequence_plans_tenant_status_created
        ON consequence_plans(tenant_id,status,created_at);

      CREATE TABLE IF NOT EXISTS scouts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        idempotency_key TEXT,
        name TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        read_tool_name TEXT NOT NULL,
        read_arguments_json TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL,
        next_run_at TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        channel TEXT,
        peer_id TEXT,
        release_id TEXT,
        wake_mode TEXT NOT NULL DEFAULT 'poll',
        freshness_minutes INTEGER NOT NULL DEFAULT 180,
        expires_at TEXT,
        last_attempt_at TEXT,
        source_cursor TEXT,
        source_watermark_at TEXT,
        last_source_seq INTEGER NOT NULL DEFAULT 0,
        wake_generation INTEGER NOT NULL DEFAULT 0,
        processed_wake_generation INTEGER NOT NULL DEFAULT 0,
        last_fingerprint TEXT,
        last_success_at TEXT,
        last_change_at TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tenant_id,idempotency_key),
        FOREIGN KEY(source_event_id) REFERENCES events(id),
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS scouts_tenant_due ON scouts(tenant_id,status,next_run_at);

      CREATE TABLE IF NOT EXISTS scout_runs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        scout_id TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        work_order_id TEXT NOT NULL,
        trigger_kind TEXT NOT NULL DEFAULT 'poll',
        wake_generation INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(tenant_id,scout_id,scheduled_for),
        UNIQUE(tenant_id,work_order_id),
        FOREIGN KEY(scout_id) REFERENCES scouts(id),
        FOREIGN KEY(work_order_id) REFERENCES work_orders(id)
      );
      CREATE INDEX IF NOT EXISTS scout_runs_scout_scheduled ON scout_runs(tenant_id,scout_id,scheduled_for);

      CREATE TABLE IF NOT EXISTS scout_observations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        scout_id TEXT NOT NULL,
        scout_run_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        retrieval_receipt_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        changed INTEGER NOT NULL,
        summary TEXT NOT NULL,
        source_event_id TEXT,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id,scout_run_id,retrieval_receipt_id),
        FOREIGN KEY(scout_id) REFERENCES scouts(id),
        FOREIGN KEY(scout_run_id) REFERENCES scout_runs(id),
        FOREIGN KEY(run_id) REFERENCES runs(id),
        FOREIGN KEY(retrieval_receipt_id) REFERENCES tool_receipts(id),
        FOREIGN KEY(source_event_id) REFERENCES events(id)
      );
      CREATE INDEX IF NOT EXISTS scout_observations_scout_time ON scout_observations(tenant_id,scout_id,observed_at);

      CREATE TABLE IF NOT EXISTS credential_items (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        label TEXT NOT NULL,
        field_names_json TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retired_at TEXT
      );
      CREATE INDEX IF NOT EXISTS credential_items_tenant_status_created
        ON credential_items(tenant_id,status,created_at);

      CREATE TABLE IF NOT EXISTS work_orders (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        idempotency_key TEXT,
        objective TEXT NOT NULL,
        success_contract TEXT NOT NULL,
        evidence_policy TEXT NOT NULL,
        evidence_requirements_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        model_role TEXT NOT NULL,
        token_budget INTEGER NOT NULL,
        allowed_tools_json TEXT NOT NULL,
        source_channel TEXT NOT NULL,
        source_peer_id TEXT NOT NULL,
        run_id TEXT,
        approval_id TEXT,
        result TEXT,
        failure_reason TEXT,
        evidence_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id),
        FOREIGN KEY(approval_id) REFERENCES approvals(id),
        UNIQUE(tenant_id,idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS work_orders_tenant_status_updated ON work_orders(tenant_id,status,updated_at);
      CREATE INDEX IF NOT EXISTS work_orders_run ON work_orders(tenant_id,run_id);

      CREATE TABLE IF NOT EXISTS email_verification_challenges (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        request_key TEXT NOT NULL,
        email TEXT NOT NULL,
        email_hash TEXT NOT NULL,
        purpose TEXT NOT NULL,
        code_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        resend_after TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_message_id TEXT,
        delivery_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        verified_at TEXT,
        UNIQUE(tenant_id,request_key)
      );
      CREATE INDEX IF NOT EXISTS email_challenges_tenant_email_created ON email_verification_challenges(tenant_id,email_hash,created_at);
      CREATE INDEX IF NOT EXISTS email_challenges_tenant_status_expires ON email_verification_challenges(tenant_id,status,expires_at);

      CREATE TABLE IF NOT EXISTS verified_email_identities (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        email TEXT NOT NULL,
        email_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        source_challenge_id TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(tenant_id,email_hash),
        FOREIGN KEY(source_challenge_id) REFERENCES email_verification_challenges(id)
      );
      CREATE INDEX IF NOT EXISTS verified_emails_tenant_status_updated ON verified_email_identities(tenant_id,status,updated_at);

      CREATE TABLE IF NOT EXISTS imports (
        source_key TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_offset INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, source_key)
      );

      CREATE TABLE IF NOT EXISTS inbound_receipts (
        tenant_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        external_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, scope, external_id)
      );
      CREATE INDEX IF NOT EXISTS inbound_receipts_event ON inbound_receipts(tenant_id,event_id);

      CREATE TABLE IF NOT EXISTS session_leases (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        lease_token TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,session_id),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        trust_class TEXT NOT NULL,
        content TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        UNIQUE(tenant_id,source_event_id,kind)
      );
      CREATE TABLE IF NOT EXISTS semantic_vectors (
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('memory','evidence')),
        record_id TEXT NOT NULL,
        model_key TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK(dimensions>0),
        vector BLOB NOT NULL,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,kind,record_id,model_key)
      );
      CREATE TABLE IF NOT EXISTS runtime_execution_mode (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        mode TEXT NOT NULL CHECK(mode='shadow')
      );
      CREATE TABLE IF NOT EXISTS embedding_usage (
        tenant_id TEXT NOT NULL,
        day TEXT NOT NULL,
        calls INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,day)
      );
      CREATE INDEX IF NOT EXISTS evidence_tenant_observed ON evidence(tenant_id,observed_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
        evidence_id UNINDEXED,
        tenant_id UNINDEXED,
        content,
        tokenize='unicode61'
      );
    `);

    // Existing pre-versioned databases are migrated in place. The old import
    // table is retained as a recovery copy because its primary key was global
    // rather than tenant-scoped.
    this.ensureColumn("runs", "lease_token", "TEXT");
    this.ensureColumn("messages", "delivery_state", "TEXT");
    this.ensureColumn("runs", "lease_expires_at", "TEXT");
    this.ensureColumn("runs", "release_id", "TEXT");
    this.ensureColumn("runs", "release_digest", "TEXT");
    this.ensureColumn("runs", "release_label", "TEXT");
    this.ensureColumn("runs", "rollout_id", "TEXT");
    this.ensureColumn("runs", "release_cohort", "TEXT");
    this.ensureColumn("runs", "resume_not_before", "TEXT");
    this.ensureColumn("recovery_quarantine", "remediated_at", "TEXT");
    this.ensureColumn("jobs", "lease_token", "TEXT");
    this.ensureColumn("jobs", "lease_expires_at", "TEXT");
    this.ensureColumn("jobs", "release_id", "TEXT");
    this.ensureColumn("jobs", "subject_type", "TEXT");
    this.ensureColumn("jobs", "subject_id", "TEXT");
    this.ensureColumn("goals", "source_quote", "TEXT");
    this.ensureColumn("goals", "standards_mandate_id", "TEXT");
    this.ensureColumn("goal_reality_checks", "delivery_state", "TEXT NOT NULL DEFAULT 'authored'");
    this.ensureColumn("goal_reality_checks", "authored_at", "TEXT");
    this.ensureColumn("goal_reality_checks", "accepted_at", "TEXT");
    this.ensureColumn("goal_reality_checks", "acceptance_event_id", "TEXT");
    this.ensureColumn("goal_reality_checks", "delivery_intent_id", "TEXT");
    this.ensureColumn("goal_reality_checks", "motive_hypothesis_id", "TEXT");
    this.ensureColumn("goal_motive_hypotheses", "substitution_json", "TEXT");
    this.ensureColumn("goal_motive_hypotheses", "reference_peak_json", "TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS goals_tenant_standards_status ON goals(tenant_id,standards_mandate_id,status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS goal_reality_checks_delivery_state ON goal_reality_checks(tenant_id,run_id,delivery_state)");
    this.db.prepare(`UPDATE jobs SET subject_type=type,subject_id=CASE
      WHEN json_valid(payload_json) THEN COALESCE(
        json_extract(payload_json,'$.workOrderId'),json_extract(payload_json,'$.messageId'),json_extract(payload_json,'$.approvalId'),
        json_extract(payload_json,'$.goalId'),json_extract(payload_json,'$.promiseId'),json_extract(payload_json,'$.sourceEventId')
      ) ELSE NULL END
      WHERE subject_id IS NULL`).run();
    this.ensureColumn("interventions", "delivery_attempts", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("interventions", "next_attempt_at", "TEXT");
    this.ensureColumn("interventions", "last_delivery_error", "TEXT");
    this.ensureColumn("interventions", "accepted_at", "TEXT");
    this.ensureColumn("interventions", "delivered_at", "TEXT");
    this.ensureColumn("interventions", "read_at", "TEXT");
    this.ensureColumn("interventions", "failed_at", "TEXT");
    this.ensureColumn("interventions", "attention_reserved_at", "TEXT");
    this.ensureColumn("interventions", "urgency", "REAL");
    this.ensureColumn("consequence_plans", "work_order_id", "TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS consequence_plans_work_order ON consequence_plans(tenant_id,work_order_id) WHERE work_order_id IS NOT NULL");
    this.ensureColumn("outbound_deliveries", "accepted_at", "TEXT");
    this.ensureColumn("outbound_deliveries", "delivered_at", "TEXT");
    this.ensureColumn("outbound_deliveries", "read_at", "TEXT");
    this.ensureColumn("outbound_deliveries", "failed_at", "TEXT");
    this.ensureColumn("sessions", "delivery_channel", "TEXT");
    this.ensureColumn("sessions", "delivery_peer_id", "TEXT");
    this.ensureColumn("work_orders", "evidence_requirements_json", "TEXT NOT NULL DEFAULT '{}'");
    this.migrateWorkOrderEvidenceRequirements();
    this.ensureColumn("tool_receipts", "evidence_class", "TEXT");
    this.ensureColumn("tool_receipts", "evidence_scope", "TEXT");
    this.ensureColumn("tool_receipts", "lease_token", "TEXT");
    this.ensureColumn("tool_receipts", "idempotency_key", "TEXT");
    this.ensureColumn("tool_receipts", "effect_state", "TEXT");
    this.ensureColumn("tool_receipts", "effect_updated_at", "TEXT");
    this.db.prepare("UPDATE tool_receipts SET status='succeeded' WHERE status='completed'").run();
    this.db.prepare("UPDATE tool_receipts SET evidence_class=risk WHERE evidence_class IS NULL OR evidence_class=''").run();
    this.db.prepare(`UPDATE tool_receipts SET evidence_scope='request'
      WHERE evidence_scope IS NULL OR evidence_scope=''`).run();
    this.db.prepare(`UPDATE tool_receipts SET evidence_scope='request',effect_state=CASE WHEN status='succeeded' THEN 'accepted' ELSE effect_state END
      WHERE evidence_scope='outcome' AND (
        tool_name IN ('goal.check','agent.send','agent.follow_up','email.verification.request','email.send_verified')
        OR (tool_name LIKE 'mcp_%' AND risk!='read')
      )`).run();
    this.db.prepare("UPDATE tool_receipts SET idempotency_key='legacy:' || id WHERE idempotency_key IS NULL OR idempotency_key=''").run();
    this.db.prepare(`UPDATE tool_receipts SET effect_state=CASE
      WHEN status='succeeded' AND evidence_scope='request' THEN 'accepted'
      WHEN status='succeeded' THEN 'confirmed'
      WHEN status='failed' THEN 'failed'
      WHEN status='uncertain' OR status='running' THEN 'uncertain'
      ELSE 'uncertain' END
      WHERE effect_state IS NULL OR effect_state=''`).run();
    this.db.prepare("UPDATE tool_receipts SET effect_updated_at=COALESCE(completed_at,started_at,?) WHERE effect_updated_at IS NULL OR effect_updated_at=''").run(nowIso());
    this.ensureColumn("interventions", "hypothesis_id", "TEXT");
    this.db.exec(`CREATE TABLE IF NOT EXISTS responsibilities (
      id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,source_event_id TEXT NOT NULL,owner_session_id TEXT NOT NULL,
      objective TEXT NOT NULL,status TEXT NOT NULL,token_limit INTEGER NOT NULL,model_call_limit INTEGER NOT NULL,
      tool_call_limit INTEGER NOT NULL,deadline_at TEXT NOT NULL,idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(tenant_id,idempotency_key));
      CREATE INDEX IF NOT EXISTS responsibilities_tenant_status ON responsibilities(tenant_id,status);
      CREATE TABLE IF NOT EXISTS responsibility_bindings (
        tenant_id TEXT NOT NULL,entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,responsibility_id TEXT NOT NULL,
        PRIMARY KEY(tenant_id,entity_kind,entity_id));
      CREATE INDEX IF NOT EXISTS responsibility_bindings_owner ON responsibility_bindings(tenant_id,responsibility_id);
      CREATE TABLE IF NOT EXISTS responsibility_reservations (
        id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,responsibility_id TEXT NOT NULL,run_id TEXT NOT NULL,
        kind TEXT NOT NULL,charged_tokens INTEGER NOT NULL CHECK(charged_tokens>=0),state TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS responsibility_reservations_owner ON responsibility_reservations(tenant_id,responsibility_id);`);
    this.ensureColumn("interventions", "inquiry_decision_id", "TEXT");
    this.ensureColumn("inquiry_foreground_decisions", "revoked_at", "TEXT");
    this.ensureColumn("scouts", "release_id", "TEXT");
    const sourceAwarenessMigration = !this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=55").get();
    this.ensureColumn("scouts", "wake_mode", "TEXT NOT NULL DEFAULT 'poll'");
    this.ensureColumn("scouts", "freshness_minutes", "INTEGER NOT NULL DEFAULT 180");
    this.ensureColumn("scouts", "expires_at", "TEXT");
    this.ensureColumn("scouts", "last_attempt_at", "TEXT");
    this.ensureColumn("scouts", "source_cursor", "TEXT");
    this.ensureColumn("scouts", "source_watermark_at", "TEXT");
    this.ensureColumn("scouts", "last_source_seq", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("scouts", "wake_generation", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("scouts", "processed_wake_generation", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("scout_runs", "trigger_kind", "TEXT NOT NULL DEFAULT 'poll'");
    this.ensureColumn("scout_runs", "wake_generation", "INTEGER NOT NULL DEFAULT 0");
    if (sourceAwarenessMigration) {
      this.db.prepare("UPDATE scouts SET freshness_minutes=MAX(interval_minutes*3,60) WHERE wake_mode='poll'").run();
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS scouts_tenant_expiry ON scouts(tenant_id,expires_at)
      WHERE status IN ('active','paused','repair_required') AND expires_at IS NOT NULL`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS inquiries_tenant_expiry ON inquiries(tenant_id,expires_at)
      WHERE status NOT IN ('expired','retired') AND foreground_disposition!='expired'`);
    this.db.exec("CREATE INDEX IF NOT EXISTS interventions_hypothesis ON interventions(tenant_id,hypothesis_id,created_at)");
    this.migrateImportsPrimaryKey();
    if (!this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=36").get()) {
      // v35 and older stored only the latest artifact projection. Preserve that
      // exact state as the first immutable version before any future refresh can
      // replace the projection. Corrupt metadata is retained byte-for-byte; only
      // its derived coverage label falls back to unknown. The migration marker
      // prevents later startups from misclassifying a post-v36 artifact as legacy.
      this.db.exec(`INSERT OR IGNORE INTO artifact_versions(
        id,artifact_id,tenant_id,version_digest,kind,source_uri,title,content,metadata_json,coverage,source_event_id,created_at
      ) SELECT
        'av_legacy_' || id,id,tenant_id,'legacy:' || id,kind,source_uri,title,content,metadata_json,
        CASE WHEN json_valid(metadata_json) THEN COALESCE(json_extract(metadata_json,'$.coverage'),'unknown') ELSE 'unknown' END,
        source_event_id,created_at
      FROM artifacts`);
    }
    const migratedAt = nowIso();
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(8, migratedAt, "institutional office records and attention holding");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(9, migratedAt, "durable evidence-gated work orders");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(10, migratedAt, "email verification challenges and verified identities");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(11, migratedAt, "additive longitudinal perception hypotheses, evidence, and feedback");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(12, migratedAt, "lease-fenced effect receipts and lossless corrupt-run quarantine");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(13, migratedAt, "transport-independent relationship sessions and durable connector routes");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(14, migratedAt, "durable accepted promises with deadline-backed recovery");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(15, migratedAt, "explicit effect lifecycle and lease-fenced effect initiation");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(16, migratedAt, "inspectable quarantine for corrupt durable JSON outside run state");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(17, migratedAt, "evidence-backed thought, concept, source-affinity, and latent-thesis projections");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(18, migratedAt, "author/domain source affinity with durable artifact aliases");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(19, migratedAt, "provenance-bound WorldScout commissions, source receipts, and findings");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(20, migratedAt, "durable reversible consequence planning from accepted intelligence");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(21, migratedAt, "persistent receipt-bound read-only scouts with change detection");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(22, migratedAt, "workspace-bound origin-bound encrypted browser credential handles");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(23, migratedAt, "bounded revocable standing mandate authority claims");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(24, migratedAt, "version-bound progressive consent for plugin sensor reads");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(25, migratedAt, "integrity-checked tenant export, audit, and deliberate deletion lifecycle");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(26, migratedAt, "immutable behavior releases with deterministic canaries and rollback");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(27, migratedAt, "release-pinned durable jobs and bounded proactive delivery retry state");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(28, migratedAt, "lease-fenced outbound connector effects and exact request rebinding");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(29, migratedAt, "run retry not-before fencing across stale recovery");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(30, migratedAt, "separate provider acceptance from member delivery, read, and failure evidence");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(31, migratedAt, "normalized durable job subjects survive corrupt payload quarantine");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(32, migratedAt, "append-only operator reconciliation for uncertain or request-scoped effects");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(33, migratedAt, "crash-atomic corrupt-record quarantine remediation");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(34, migratedAt, "conversation-visible connector delivery state");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(35, migratedAt, "append-only operator reconciliation for ambiguous outbound deliveries");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(36, migratedAt, "append-only source artifact versions with a latest-state projection");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(37, migratedAt, "fail-safe persistent scout repair lifecycle and creation-release provenance");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(38, migratedAt, "owner-provenanced member outcome feedback for product-quality measurement");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(39, migratedAt, "owner-quoted model-created goals and revocable conversational goal control");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(40, migratedAt, "one-shot evidence-bound arithmetic reality checks for explicit owner goals");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(41, migratedAt, "member-approved standards mandate boundary for foreground accountability");
    const realityDeliveryMigration = !this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=42").get();
    if (realityDeliveryMigration) {
      // v40/41 rows represented an already-surfaced fact, even though they did
      // not retain the connector acceptance that established it. Keep that
      // history readable, but never promote it to new receipt-backed evidence.
      this.db.prepare(`UPDATE goal_reality_checks
        SET delivery_state='legacy_accepted',
          authored_at=COALESCE(authored_at,surfaced_at),
          accepted_at=COALESCE(accepted_at,surfaced_at)
        WHERE delivery_state='authored' AND COALESCE(surfaced_at,'')<>''`).run();
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(42, migratedAt, "separate authored goal reality checks from receipt-backed member delivery");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(43, migratedAt, "distinguish accepted reality checks from authenticated delivered or read surface evidence");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(44, migratedAt, "fail-closed release binding and explicit repair for preserved legacy scouts");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(45, migratedAt, "private falsifiable goal-motive hypotheses for silent standards relevance");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(46, migratedAt, "private evidence-bound substitution hypotheses within goal motives");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(47, migratedAt, "runtime-counted motive-matched personal reference peaks");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(48, migratedAt, "delivery-time attention reservations independent of candidate creation time");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(49, migratedAt, "prepared consequence promotion to verified work orders");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(50, migratedAt, "delivery-time relationship arbitration with explicit intervention urgency");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(51, migratedAt, "durable relationship-level delivery admission arbitration");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(52, migratedAt, "preregistered independent human product-quality review samples");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(53, migratedAt, "portable content-addressed preservation for inbound attachment bytes");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(54, migratedAt, "bounded backstage inquiries with separately gated foreground decisions");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(55, migratedAt, "quiet source health, durable event watermarks, wake coalescing, catch-up, and expiry");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(56, migratedAt, "exact inquiry decision authority through delayed relationship delivery");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(57, migratedAt, "explicit execution responsibility bindings and shared model/tool reservations");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at,description) VALUES(?,?,?)")
      .run(58, migratedAt, "tenant and model bound semantic vectors with durable embedding call reservations");
    this.db.exec(`PRAGMA user_version=${CURRENT_SCHEMA_VERSION}`);
  }

  scanCorruptJsonRows(tenantId: string, limit = 50): number {
    const targets = [
      ["events", "payload_json"], ["messages", "parts_json"], ["jobs", "payload_json"],
      ["retained_agents", "allowed_tools_json"], ["goals", "gate_config_json"],
      ["goal_gate_results", "evidence_ids_json"], ["goal_reality_checks", "evidence_ids_json"], ["goal_motive_hypotheses", "decision_cues_json"],
      ["goal_motive_hypotheses", "evidence_event_ids_json"], ["goal_motive_hypotheses", "substitution_json"],
      ["goal_motive_hypotheses", "reference_peak_json"], ["refinement_proposals", "patch_json"],
      ["refinement_proposals", "evidence_event_ids_json"], ["refinement_proposals", "review_json"],
      ["harness_overlays", "content_json"], ["skill_proposals", "evidence_event_ids_json"],
      ["artifacts", "metadata_json"], ["artifact_versions", "metadata_json"], ["perception_hypotheses", "alternative_explanations_json"],
      ["mandates", "authority_json"],
      ["mandates", "delivery_json"], ["prepared_artifacts", "source_event_ids_json"],
      ["work_orders", "allowed_tools_json"], ["work_orders", "evidence_ids_json"],
      ["work_orders", "evidence_requirements_json"], ["tool_receipts", "arguments_json"],
      ["tool_receipts", "output_json"], ["evidence", "metadata_json"],
      ["research_commissions", "retrieval_tool_names_json"], ["research_findings", "source_receipt_ids_json"],
      ["inquiries", "competing_hypotheses_json"], ["inquiries", "falsifiers_json"], ["inquiries", "retrieval_plan_json"],
      ["scouts", "read_arguments_json"],
      ["credential_items", "field_names_json"],
      ["sensor_consents", "descriptor_json"],
    ] as const;
    const maximum = Math.max(1, Math.min(500, Math.floor(limit)));
    let recorded = 0;
    for (const [table, field] of targets) {
      if (recorded >= maximum) break;
      const kind = table;
      const recordColumn = table === "sensor_consents" ? "sensor_id" : "id";
      const rows = this.db.prepare(`SELECT ${recordColumn} AS id,${field} AS raw_value${table === "jobs" ? ",subject_type,subject_id" : ""} FROM ${table}
        WHERE tenant_id=? AND ${field} IS NOT NULL AND json_valid(${field})=0
        AND NOT EXISTS (SELECT 1 FROM recovery_quarantine q WHERE q.tenant_id=?
          AND q.record_kind=? AND q.record_id=CAST(${table}.${recordColumn} AS TEXT) AND q.field_name=? AND q.remediated_at IS NOT NULL)
        ORDER BY rowid LIMIT ?`).all(tenantId, tenantId, kind, field, maximum - recorded) as Row[];
      for (const row of rows) {
        const recordId = String(row.id);
        const raw = typeof row.raw_value === "string" ? row.raw_value : String(row.raw_value ?? "");
        const reason = `${table}.${field} is not valid JSON`;
        const quarantinedAt = nowIso();
        const remediated = this.transaction(() => {
          const quarantineId = stableId("quarantine", `${tenantId}:${table}:${recordId}:${field}`);
          this.db.prepare(`INSERT OR IGNORE INTO recovery_quarantine(
            id,tenant_id,record_kind,record_id,field_name,raw_value,reason,quarantined_at,remediated_at
          ) VALUES(?,?,?,?,?,?,?,?,NULL)`).run(quarantineId, tenantId, kind, recordId, field, raw, reason, quarantinedAt);
          const quarantine = this.db.prepare("SELECT remediated_at FROM recovery_quarantine WHERE tenant_id=? AND record_kind=? AND record_id=? AND field_name=?")
            .get(tenantId, kind, recordId, field) as Row | undefined;
          if (quarantine?.remediated_at) return false;
          if (table === "jobs") {
            const subjectType = optional(row.subject_type);
            const subjectId = optional(row.subject_id);
            if ((subjectType === "promise.check" || subjectType === "goal.check") && subjectId) {
              const key = subjectType === "promise.check" ? "promiseId" : "goalId";
              this.db.prepare(`UPDATE jobs SET status='queued',payload_json=?,last_error=?,locked_at=NULL,lease_token=NULL,lease_expires_at=NULL,run_after=?,updated_at=?
                WHERE tenant_id=? AND id=? AND status IN ('queued','running','failed')`)
                .run(json({ [key]: subjectId }), `Recovered normalized subject after ${reason}`, quarantinedAt, quarantinedAt, tenantId, recordId);
            } else if (subjectType === "agent.turn" && subjectId) {
              const message = this.db.prepare("SELECT agent_id FROM agent_messages WHERE tenant_id=? AND id=?").get(tenantId, subjectId) as Row | undefined;
              if (message) this.db.prepare(`UPDATE jobs SET status='queued',payload_json=?,last_error=?,locked_at=NULL,lease_token=NULL,lease_expires_at=NULL,run_after=?,updated_at=?
                WHERE tenant_id=? AND id=? AND status IN ('queued','running','failed')`)
                .run(json({ agentId: String(message.agent_id), messageId: subjectId }), `Recovered normalized subject after ${reason}`, quarantinedAt, quarantinedAt, tenantId, recordId);
              else this.db.prepare(`UPDATE jobs SET status='failed',last_error=?,locked_at=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
                WHERE tenant_id=? AND id=? AND status IN ('queued','running')`).run(`Recovery blocked: ${reason}`, quarantinedAt, tenantId, recordId);
            } else {
              this.db.prepare(`UPDATE jobs SET status='failed',last_error=?,locked_at=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
                WHERE tenant_id=? AND id=? AND status IN ('queued','running')`).run(`Recovery blocked: ${reason}`, quarantinedAt, tenantId, recordId);
            }
            if (subjectType === "work.execute" && subjectId) {
              this.db.prepare(`UPDATE work_orders SET status='failed',failure_reason=?,updated_at=?,completed_at=?
                WHERE tenant_id=? AND id=? AND status IN ('queued','running','waiting_approval')`)
                .run(`Recovery blocked: ${reason}`, quarantinedAt, quarantinedAt, tenantId, subjectId);
              this.appendEvent({
                id: stableId("evt", `work-order-job-recovery-blocked:${tenantId}:${subjectId}:${recordId}`), tenantId,
                stream: `work-order:${subjectId}`, type: "work_order.recovery_blocked", correlationId: subjectId,
                payload: { workOrderId: subjectId, jobId: recordId, reason },
              });
            } else if (subjectType === "approval.decide" && subjectId) {
              const approval = this.db.prepare("SELECT run_id FROM approvals WHERE tenant_id=? AND id=?").get(tenantId, subjectId) as Row | undefined;
              this.appendEvent({
                id: stableId("evt", `approval-job-recovery-blocked:${tenantId}:${subjectId}:${recordId}`), tenantId,
                stream: approval ? `run:${String(approval.run_id)}` : "runtime:recovery", type: "approval.recovery_blocked",
                ...(approval ? { correlationId: String(approval.run_id) } : {}),
                payload: { approvalId: subjectId, jobId: recordId, reason, retryWithNewInboundMessage: true },
              });
            }
          }
          if (table === "tool_receipts") {
            const projection = field === "output_json" ? "output_json=NULL," : field === "arguments_json" ? "arguments_json='{}'," : "";
            this.db.prepare(`UPDATE tool_receipts SET ${projection}status='uncertain',effect_state='uncertain',error=?,completed_at=COALESCE(completed_at,?),effect_updated_at=?
              WHERE tenant_id=? AND id=?`).run(`Recovery blocked: ${reason}`, quarantinedAt, quarantinedAt, tenantId, recordId);
          }
          if (table === "goal_motive_hypotheses") {
            const projection = field === "decision_cues_json" ? "decision_cues_json='[]',"
              : field === "evidence_event_ids_json" ? "evidence_event_ids_json='[]',"
                : field === "substitution_json" ? "substitution_json=NULL," : "reference_peak_json=NULL,";
            this.db.prepare(`UPDATE goal_motive_hypotheses SET ${projection}status='rejected',superseded_at=COALESCE(superseded_at,?),updated_at=?
              WHERE tenant_id=? AND id=?`).run(quarantinedAt, quarantinedAt, tenantId, recordId);
          }
          this.appendEvent({
            id: stableId("evt", `record-quarantined:${tenantId}:${table}:${recordId}:${field}`), tenantId,
            stream: "runtime:recovery", type: "record.recovery_blocked",
            payload: { recordKind: kind, recordId, field, reason, quarantineId },
          });
          this.db.prepare("UPDATE recovery_quarantine SET remediated_at=? WHERE id=? AND remediated_at IS NULL").run(quarantinedAt, quarantineId);
          return true;
        });
        if (remediated) recorded += 1;
      }
    }
    return recorded;
  }

  private tableExists(name: string): boolean {
    return Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!columns.some((row) => String(row.name) === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private migrateWorkOrderEvidenceRequirements(): void {
    const rows = this.db.prepare("SELECT id,status,evidence_policy,evidence_requirements_json FROM work_orders").all() as Row[];
    for (const row of rows) {
      if (typeof row.evidence_requirements_json !== "string") continue;
      let parsed: unknown;
      try { parsed = JSON.parse(row.evidence_requirements_json); } catch { continue; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || "version" in parsed) continue;
      const legacy = parsed as { minimumReceipts?: unknown; requiredToolNames?: unknown };
      const names = Array.isArray(legacy.requiredToolNames) && legacy.requiredToolNames.every((name) => typeof name === "string" && name.length > 0)
        ? [...new Set(legacy.requiredToolNames)]
        : undefined;
      const policy = String(row.evidence_policy);
      const terminal = ["completed", "failed", "cancelled", "needs_input"].includes(String(row.status));
      const minimum = policy === "run" ? 0 : legacy.minimumReceipts;
      const safeMinimum = Number.isSafeInteger(minimum) && Number(minimum) >= (policy === "run" ? 0 : 1);
      // Historical terminal records are immutable evidence. Active records are
      // only upgraded when their old requirement was already unambiguous.
      if (!names || !safeMinimum || (!terminal && policy !== "run" && names.length === 0)) continue;
      this.db.prepare("UPDATE work_orders SET evidence_requirements_json=? WHERE id=?")
        .run(json({ version: 1, minimumReceipts: Number(minimum), requiredToolNames: names }), String(row.id));
    }
  }

  private migrateImportsPrimaryKey(): void {
    const columns = this.db.prepare("PRAGMA table_info(imports)").all() as Row[];
    const tenantPrimary = columns.some((row) => String(row.name) === "tenant_id" && Number(row.pk) > 0);
    if (tenantPrimary) {
      if (this.tableExists("imports_v1_backup")) {
        this.db.exec(`INSERT OR IGNORE INTO imports(source_key,tenant_id,source_path,source_offset,event_id,imported_at)
          SELECT source_key,tenant_id,source_path,source_offset,event_id,imported_at FROM imports_v1_backup`);
      }
      return;
    }
    this.transaction(() => {
      if (!this.tableExists("imports_v1_backup")) this.db.exec("ALTER TABLE imports RENAME TO imports_v1_backup");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS imports (
          source_key TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          source_path TEXT NOT NULL,
          source_offset INTEGER NOT NULL,
          event_id TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          PRIMARY KEY(tenant_id, source_key)
        )
      `);
      this.db.exec(`INSERT OR IGNORE INTO imports(source_key,tenant_id,source_path,source_offset,event_id,imported_at)
        SELECT source_key,tenant_id,source_path,source_offset,event_id,imported_at FROM imports_v1_backup`);
    });
  }

  appendEvent<T extends JsonValue>(input: {
    id?: string;
    tenantId: string;
    stream: string;
    type: string;
    payload: T;
    at?: string;
    correlationId?: string;
    causationId?: string;
  }): EventRecord<T> {
    const eventId = input.id ?? id("evt");
    const at = input.at ?? nowIso();
    const inserted = this.db.prepare(
      "INSERT OR IGNORE INTO events(id,tenant_id,stream,type,at,correlation_id,causation_id,payload_json) VALUES(?,?,?,?,?,?,?,?)",
    ).run(eventId, input.tenantId, input.stream, input.type, at, input.correlationId ?? null, input.causationId ?? null, json(input.payload));
    const row = this.db.prepare("SELECT * FROM events WHERE id=? AND tenant_id=?").get(eventId, input.tenantId) as Row | undefined;
    if (!row) throw new Error(`Event ID ${eventId} is already owned by another tenant`);
    if (!inserted.changes && (String(row.stream) !== input.stream || String(row.type) !== input.type)) {
      throw new Error(`Event ID ${eventId} was reused for a different event`);
    }
    return this.eventFromRow<T>(row);
  }

  getEvent<T extends JsonValue = JsonValue>(tenantId: string, eventId: string): EventRecord<T> | undefined {
    const row = this.db.prepare("SELECT * FROM events WHERE tenant_id=? AND id=?").get(tenantId, eventId) as Row | undefined;
    return row ? this.eventFromRow<T>(row) : undefined;
  }

  listEvents(tenantId: string, options: { stream?: string; type?: string; correlationId?: string; afterSeq?: number; limit?: number } = {}): EventRecord[] {
    const clauses = ["tenant_id=?", "seq>?"];
    const values: SqlValue[] = [tenantId, options.afterSeq ?? 0];
    if (options.stream) {
      clauses.push("stream=?");
      values.push(options.stream);
    }
    if (options.type) {
      clauses.push("type=?");
      values.push(options.type);
    }
    if (options.correlationId) {
      clauses.push("correlation_id=?");
      values.push(options.correlationId);
    }
    values.push(options.limit ?? 100);
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY seq ASC LIMIT ?`).all(...values) as Row[];
    return rows.map((row) => this.eventFromRow(row));
  }

  private eventFromRow<T extends JsonValue = JsonValue>(row: Row): EventRecord<T> {
    const correlationId = optional(row.correlation_id);
    const causationId = optional(row.causation_id);
    return {
      seq: Number(row.seq),
      id: String(row.id),
      tenantId: String(row.tenant_id),
      stream: String(row.stream),
      type: String(row.type),
      at: String(row.at),
      ...(correlationId ? { correlationId } : {}),
      ...(causationId ? { causationId } : {}),
      payload: parse<T>(row.payload_json, {} as T),
    };
  }

  indexEvidence(input: {
    tenantId: string;
    sourceEventId: string;
    kind: string;
    trustClass: EvidenceTrust;
    content: string;
    observedAt?: string;
    metadata?: JsonObject;
  }): EvidenceRecord | undefined {
    const content = input.content.trim().slice(0, 100_000);
    if (!content) return undefined;
    const evidenceId = stableId("evi", `${input.tenantId}:${input.sourceEventId}:${input.kind}`);
    const observedAt = input.observedAt ?? nowIso();
    const metadata = input.metadata ?? {};
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT content FROM evidence WHERE tenant_id=? AND id=?").get(input.tenantId, evidenceId) as { content: string } | undefined;
      if (prior && prior.content !== content) this.db.prepare("DELETE FROM semantic_vectors WHERE tenant_id=? AND kind='evidence' AND record_id=?").run(input.tenantId, evidenceId);
      this.db.prepare(`INSERT INTO evidence(id,tenant_id,source_event_id,kind,trust_class,content,observed_at,metadata_json)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,source_event_id,kind) DO UPDATE SET
        trust_class=excluded.trust_class,content=excluded.content,observed_at=excluded.observed_at,metadata_json=excluded.metadata_json`)
        .run(evidenceId, input.tenantId, input.sourceEventId, input.kind, input.trustClass, content, observedAt, json(metadata));
      this.db.prepare("DELETE FROM evidence_fts WHERE tenant_id=? AND evidence_id=?").run(input.tenantId, evidenceId);
      this.db.prepare("INSERT INTO evidence_fts(evidence_id,tenant_id,content) VALUES(?,?,?)").run(evidenceId, input.tenantId, content);
      return {
        id: evidenceId, tenantId: input.tenantId, sourceEventId: input.sourceEventId, kind: input.kind,
        trustClass: input.trustClass, content, observedAt, metadata,
      };
    });
  }

  searchEvidence(tenantId: string, query: string, options: { limit?: number; trustClasses?: EvidenceTrust[] } = {}): EvidenceRecord[] {
    const allTerms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
    const meaningful = allTerms.filter((term) => !EVIDENCE_STOP_WORDS.has(term));
    const terms = (meaningful.length ? meaningful : allTerms).slice(0, 16);
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    const trustClasses = options.trustClasses?.length ? options.trustClasses : ["owner", "agent"];
    const placeholders = trustClasses.map(() => "?").join(",");
    // Select within time buckets before imposing the global limit. A dense
    // recent month must not crowd an older, more relevant owner record out of
    // the candidate set before temporal diversification even runs.
    const buckets = this.db.prepare(`SELECT DISTINCT substr(e.observed_at,1,7) AS bucket
      FROM evidence_fts JOIN evidence e ON e.id=evidence_fts.evidence_id
      WHERE evidence_fts.tenant_id=? AND evidence_fts MATCH ? AND e.trust_class IN (${placeholders})
      ORDER BY bucket DESC`).all(tenantId, match, ...trustClasses) as Row[];
    const rows = buckets.flatMap((bucket) => this.db.prepare(`SELECT e.*,snippet(evidence_fts,2,'','',' … ',28) AS excerpt,bm25(evidence_fts) AS rank
      FROM evidence_fts JOIN evidence e ON e.id=evidence_fts.evidence_id
      WHERE evidence_fts.tenant_id=? AND evidence_fts MATCH ? AND e.trust_class IN (${placeholders})
      AND substr(e.observed_at,1,7)=? ORDER BY rank ASC,e.observed_at DESC LIMIT 2`)
      .all(tenantId, match, ...trustClasses, String(bucket.bucket)) as Row[])
      .sort((left, right) => Number(left.rank ?? 0) - Number(right.rank ?? 0)
        || String(right.observed_at).localeCompare(String(left.observed_at)));
    const result: EvidenceRecord[] = [];
    const monthCounts = new Map<string, number>();
    const limit = Math.max(1, Math.min(50, options.limit ?? 8));
    for (const row of rows) {
      const observedAt = String(row.observed_at);
      const bucket = observedAt.slice(0, 7);
      const count = monthCounts.get(bucket) ?? 0;
      if (count >= 2) continue;
      result.push({
        id: String(row.id), tenantId: String(row.tenant_id), sourceEventId: String(row.source_event_id), kind: String(row.kind),
        trustClass: String(row.trust_class) as EvidenceTrust, content: String(row.content), observedAt,
        metadata: parse<JsonObject>(row.metadata_json, {}), excerpt: String(row.excerpt ?? ""), rank: Number(row.rank ?? 0),
      });
      monthCounts.set(bucket, count + 1);
      if (result.length >= limit) break;
    }
    return result;
  }

  rebuildEvidence(tenantId: string): { indexed: number } {
    return this.transaction(() => {
      // Search is disposable; provenance-bearing evidence is not. Older
      // versions deleted the evidence table here and reconstructed only three
      // kinds, which silently discarded research, scout, correction, and
      // perception records. Repair only missing baseline projections, then
      // rebuild FTS from every retained evidence row.
      const insertMissing = (input: {
        sourceEventId: string; kind: string; trustClass: EvidenceTrust; content: string; observedAt: string; metadata: JsonObject;
      }): void => {
        const content = input.content.trim().slice(0, 100_000);
        if (!content) return;
        const evidenceId = stableId("evi", `${tenantId}:${input.sourceEventId}:${input.kind}`);
        this.db.prepare(`INSERT OR IGNORE INTO evidence(id,tenant_id,source_event_id,kind,trust_class,content,observed_at,metadata_json)
          VALUES(?,?,?,?,?,?,?,?)`).run(
          evidenceId, tenantId, input.sourceEventId, input.kind, input.trustClass, content, input.observedAt, json(input.metadata),
        );
      };
      const eventRows = this.db.prepare(`SELECT id,type,at,payload_json FROM events WHERE tenant_id=?
        AND type IN ('message.received','schedule.instruction_received','work.instruction_received','agent.instruction_received','run.completed','log.imported')
        ORDER BY seq`).all(tenantId) as Row[];
      for (const row of eventRows) {
        const payload = parse<JsonObject>(row.payload_json, {});
        const type = String(row.type);
        const text = type === "run.completed" ? payload.output : payload.text;
        if (typeof text !== "string" || !text.trim()) continue;
        const role = typeof payload.role === "string" ? payload.role.toLowerCase() : "";
        const trustClass: EvidenceTrust = type === "message.received" || (type === "log.imported" && (role === "user" || role === "human"))
          ? "owner"
          : type === "run.completed" || type.endsWith(".instruction_received") || role === "assistant"
            ? "agent"
            : "untrusted";
        const kind = type === "message.received" ? "conversation.user"
          : type === "run.completed" ? "conversation.assistant"
            : type === "log.imported" ? `import.${String(payload.format ?? "unknown")}`
              : type.slice(0, -"_received".length);
        insertMissing({
          sourceEventId: String(row.id), kind, trustClass, content: text,
          observedAt: typeof payload.observedAt === "string" ? payload.observedAt : String(row.at),
          metadata: { rebuiltFromEvent: true, importedRole: role || null },
        });
      }
      const artifacts = this.db.prepare("SELECT source_event_id,kind,source_uri,content,created_at FROM artifacts WHERE tenant_id=? AND content IS NOT NULL")
        .all(tenantId) as Row[];
      for (const row of artifacts) {
        insertMissing({
          sourceEventId: String(row.source_event_id), kind: `artifact.${String(row.kind)}`, trustClass: "untrusted",
          content: String(row.content), observedAt: String(row.created_at), metadata: { sourceUri: String(row.source_uri) },
        });
      }
      this.db.prepare("DELETE FROM evidence_fts WHERE tenant_id=?").run(tenantId);
      this.db.prepare(`INSERT INTO evidence_fts(evidence_id,tenant_id,content)
        SELECT id,tenant_id,content FROM evidence WHERE tenant_id=? ORDER BY observed_at,id`).run(tenantId);
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE tenant_id=?").get(tenantId) as Row;
      return { indexed: Number(count.count) };
    });
  }

  ensureSession(tenantId: string, channel: string, peerId: string, delivery?: { channel: string; peerId: string }): SessionRecord {
    const current = nowIso();
    const sessionId = id("ses");
    this.db.prepare(
      `INSERT INTO sessions(id,tenant_id,channel,peer_id,delivery_channel,delivery_peer_id,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,channel,peer_id) DO UPDATE SET
       delivery_channel=COALESCE(excluded.delivery_channel,sessions.delivery_channel),
       delivery_peer_id=COALESCE(excluded.delivery_peer_id,sessions.delivery_peer_id),updated_at=excluded.updated_at`,
    ).run(sessionId, tenantId, channel, peerId, delivery?.channel ?? null, delivery?.peerId ?? null, current, current);
    const row = this.db.prepare("SELECT * FROM sessions WHERE tenant_id=? AND channel=? AND peer_id=?").get(tenantId, channel, peerId) as Row;
    const deliveryChannel = optional(row.delivery_channel);
    const deliveryPeerId = optional(row.delivery_peer_id);
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      channel: String(row.channel),
      peerId: String(row.peer_id),
      ...(deliveryChannel ? { deliveryChannel } : {}),
      ...(deliveryPeerId ? { deliveryPeerId } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  getSession(sessionId: string, tenantId?: string): SessionRecord | undefined {
    const row = tenantId
      ? this.db.prepare("SELECT * FROM sessions WHERE id=? AND tenant_id=?").get(sessionId, tenantId) as Row | undefined
      : this.db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId) as Row | undefined;
    if (!row) return undefined;
    const deliveryChannel = optional(row.delivery_channel);
    const deliveryPeerId = optional(row.delivery_peer_id);
    return {
      id: String(row.id), tenantId: String(row.tenant_id), channel: String(row.channel), peerId: String(row.peer_id),
      ...(deliveryChannel ? { deliveryChannel } : {}),
      ...(deliveryPeerId ? { deliveryPeerId } : {}),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  noteConnectorRoute(input: {
    tenantId: string;
    connectorId: string;
    peerId?: string;
    externalThreadId: string;
    status: "active" | "blocked";
    sourceEventId: string;
  }): void {
    if (!input.externalThreadId) throw new Error("Connector route requires an external thread ID");
    const current = nowIso();
    if (input.status === "blocked") {
      this.db.prepare(`UPDATE connector_routes SET status='blocked',source_event_id=?,updated_at=?
        WHERE tenant_id=? AND connector_id=? AND external_thread_id=?`)
        .run(input.sourceEventId, current, input.tenantId, input.connectorId, input.externalThreadId);
      return;
    }
    if (!input.peerId) throw new Error("Active connector route requires a peer ID");
    const owner = this.db.prepare(`SELECT peer_id FROM connector_routes
      WHERE tenant_id=? AND connector_id=? AND external_thread_id=?`).get(input.tenantId, input.connectorId, input.externalThreadId) as Row | undefined;
    if (owner && String(owner.peer_id) !== input.peerId) throw new Error("Connector thread is already bound to another peer");
    this.db.prepare(`INSERT INTO connector_routes(tenant_id,connector_id,peer_id,external_thread_id,status,source_event_id,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,connector_id,peer_id) DO UPDATE SET
      external_thread_id=excluded.external_thread_id,status='active',source_event_id=excluded.source_event_id,updated_at=excluded.updated_at`)
      .run(input.tenantId, input.connectorId, input.peerId, input.externalThreadId, "active", input.sourceEventId, current);
  }

  connectorRoute(tenantId: string, connectorId: string, peerId: string): string | undefined {
    const row = this.db.prepare(`SELECT external_thread_id FROM connector_routes
      WHERE tenant_id=? AND connector_id=? AND peer_id=? AND status='active'`)
      .get(tenantId, connectorId, peerId) as Row | undefined;
    return row ? String(row.external_thread_id) : undefined;
  }

  connectorPeer(tenantId: string, connectorId: string, externalThreadId: string): string | undefined {
    const row = this.db.prepare(`SELECT peer_id FROM connector_routes
      WHERE tenant_id=? AND connector_id=? AND external_thread_id=? AND status='active'`)
      .get(tenantId, connectorId, externalThreadId) as Row | undefined;
    return row ? String(row.peer_id) : undefined;
  }

  addMessage(tenantId: string, sessionId: string, message: RuntimeMessage, eventId?: string): void {
    if (!this.getSession(sessionId, tenantId)) throw new Error(`Session ${sessionId} does not belong to tenant ${tenantId}`);
    const inserted = this.db.prepare("INSERT OR IGNORE INTO messages(id,tenant_id,session_id,role,parts_json,phase,created_at,event_id) VALUES(?,?,?,?,?,?,?,?)")
      .run(message.id, tenantId, sessionId, message.role, json(message.parts), message.phase ?? null, message.createdAt, eventId ?? null);
    if (!inserted.changes) {
      const owner = this.db.prepare("SELECT tenant_id,session_id FROM messages WHERE id=?").get(message.id) as Row | undefined;
      if (!owner || String(owner.tenant_id) !== tenantId || String(owner.session_id) !== sessionId) {
        throw new Error(`Message ID ${message.id} is already owned by another session`);
      }
    }
    this.db.prepare("UPDATE sessions SET updated_at=? WHERE id=? AND tenant_id=?").run(message.createdAt, sessionId, tenantId);
  }

  listMessages(tenantId: string, sessionId: string, limit = 40): RuntimeMessage[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE tenant_id=? AND session_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?").all(tenantId, sessionId, limit) as Row[];
    return rows.reverse().map((row) => {
      const phase = optional(row.phase);
      const deliveryState = optional(row.delivery_state);
      const parts = parse<RuntimeMessage["parts"]>(row.parts_json, []);
      if (row.role === "assistant" && (deliveryState === "accepted" || deliveryState === "failed")) {
        parts.push({
          type: "text",
          text: deliveryState === "failed"
            ? "[Delivery status: failed. The member did not receive the preceding assistant message.]"
            : "[Delivery status: accepted by the provider, but member delivery is not yet confirmed.]",
        });
      }
      return {
        id: String(row.id),
        role: String(row.role) as RuntimeMessage["role"],
        parts,
        createdAt: String(row.created_at),
        ...(phase === "commentary" || phase === "final" ? { phase } : {}),
      };
    });
  }

  createRun(run: RunRecord): void {
    if (!this.getSession(run.sessionId, run.tenantId)) throw new Error(`Session ${run.sessionId} does not belong to tenant ${run.tenantId}`);
    if (run.parentRunId && !this.getRun(run.parentRunId, run.tenantId)) throw new Error(`Parent run ${run.parentRunId} does not belong to tenant ${run.tenantId}`);
    this.db.prepare(`INSERT INTO runs(id,tenant_id,session_id,parent_run_id,kind,status,model_role,provider,model,release_id,release_digest,release_label,rollout_id,release_cohort,input,output,state_json,input_tokens,output_tokens,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      run.id, run.tenantId, run.sessionId, run.parentRunId ?? null, run.kind, run.status, run.modelRole,
      run.provider ?? null, run.model ?? null, run.releaseId ?? null, run.releaseDigest ?? null, run.releaseLabel ?? null,
      run.rolloutId ?? null, run.releaseCohort ?? null, run.input, run.output ?? null, run.state ? json(run.state) : null,
      run.inputTokens, run.outputTokens, run.createdAt, run.updatedAt,
    );
  }

  updateRun(runId: string, update: {
    status?: RunStatus;
    provider?: string;
    model?: string;
    output?: string;
    state?: RunState | null;
    inputTokens?: number;
    outputTokens?: number;
  }, leaseToken?: string): void {
    const current = this.getRun(runId);
    if (!current) throw new Error(`Unknown run ${runId}`);
    const updatedAt = nowIso();
    const where = leaseToken ? "id=? AND lease_token=? AND lease_expires_at>?" : "id=?";
    const values: SqlValue[] = [
      update.status ?? current.status,
      update.provider ?? current.provider ?? null,
      update.model ?? current.model ?? null,
      update.output ?? current.output ?? null,
      update.state === null ? null : json(update.state ?? current.state ?? {} as RunState),
      update.inputTokens ?? current.inputTokens,
      update.outputTokens ?? current.outputTokens,
      updatedAt,
      runId,
    ];
    if (leaseToken) values.push(leaseToken, updatedAt);
    const result = this.db.prepare(`UPDATE runs SET status=?,provider=?,model=?,output=?,state_json=?,input_tokens=?,output_tokens=?,updated_at=? WHERE ${where}`).run(...values);
    if (leaseToken && result.changes !== 1) throw new Error(`Run lease lost for ${runId}`);
  }

  setRunResumeNotBefore(tenantId: string, runId: string, value: string | undefined, leaseToken: string): boolean {
    const current = nowIso();
    const result = this.db.prepare(`UPDATE runs SET resume_not_before=?,updated_at=? WHERE tenant_id=? AND id=?
      AND status='running' AND lease_token=? AND lease_expires_at>?`).run(value ?? null, current, tenantId, runId, leaseToken, current);
    return result.changes === 1;
  }

  getRun(runId: string, tenantId?: string): RunRecord | undefined {
    const row = tenantId
      ? this.db.prepare("SELECT * FROM runs WHERE id=? AND tenant_id=?").get(runId, tenantId) as Row | undefined
      : this.db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as Row | undefined;
    if (!row) return undefined;
    const parentRunId = optional(row.parent_run_id);
    const providerName = optional(row.provider);
    const model = optional(row.model);
    const releaseId = optional(row.release_id);
    const releaseDigest = optional(row.release_digest);
    const releaseLabel = optional(row.release_label);
    const rolloutId = optional(row.rollout_id);
    const releaseCohort = row.release_cohort === "stable" || row.release_cohort === "canary" ? row.release_cohort : undefined;
    const output = optional(row.output);
    const state = parseRunState(row.state_json, String(row.id));
    if (state?.release && (state.release.id !== releaseId || state.release.digest !== releaseDigest
      || state.release.label !== releaseLabel || state.release.rolloutId !== rolloutId || state.release.cohort !== releaseCohort)) {
      throw new Error(`Run ${String(row.id)} has release state that does not match its immutable run metadata`);
    }
    return {
      id: String(row.id), tenantId: String(row.tenant_id), sessionId: String(row.session_id),
      ...(parentRunId ? { parentRunId } : {}),
      kind: String(row.kind) as RunRecord["kind"], status: String(row.status) as RunStatus,
      modelRole: String(row.model_role) as RunRecord["modelRole"],
      ...(providerName ? { provider: providerName } : {}), ...(model ? { model } : {}),
      ...(releaseId ? { releaseId } : {}), ...(releaseDigest ? { releaseDigest } : {}), ...(releaseLabel ? { releaseLabel } : {}),
      ...(rolloutId ? { rolloutId } : {}), ...(releaseCohort ? { releaseCohort } : {}),
      input: String(row.input), ...(output ? { output } : {}), ...(state ? { state } : {}),
      inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  listRuns(tenantId: string, limit = 50): RunRecord[] {
    const rows = this.db.prepare("SELECT id FROM runs WHERE tenant_id=? ORDER BY updated_at DESC LIMIT ?").all(tenantId, limit) as Row[];
    return rows.flatMap((row) => {
      const run = this.getRun(String(row.id), tenantId);
      return run ? [run] : [];
    });
  }

  getIngress(tenantId: string, scope: string, externalId: string): IngressRecord | undefined {
    const row = this.db.prepare("SELECT * FROM inbound_receipts WHERE tenant_id=? AND scope=? AND external_id=?")
      .get(tenantId, scope, externalId) as Row | undefined;
    if (!row) return undefined;
    const runId = optional(row.run_id);
    return {
      tenantId: String(row.tenant_id), scope: String(row.scope), externalId: String(row.external_id), eventId: String(row.event_id),
      ...(runId ? { runId } : {}), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  claimIngress(input: { tenantId: string; scope: string; externalId: string; eventId: string }): boolean {
    const current = nowIso();
    const result = this.db.prepare(`INSERT OR IGNORE INTO inbound_receipts(tenant_id,scope,external_id,event_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).run(input.tenantId, input.scope, input.externalId, input.eventId, current, current);
    return result.changes === 1;
  }

  linkIngressRun(tenantId: string, scope: string, externalId: string, runId: string): void {
    if (!this.getRun(runId, tenantId)) throw new Error(`Run ${runId} does not belong to tenant ${tenantId}`);
    const result = this.db.prepare(`UPDATE inbound_receipts SET run_id=?,updated_at=?
      WHERE tenant_id=? AND scope=? AND external_id=? AND (run_id IS NULL OR run_id=?)`)
      .run(runId, nowIso(), tenantId, scope, externalId, runId);
    if (result.changes !== 1) throw new Error(`Ingress ${scope}/${externalId} is already linked to another run`);
  }

  acquireSessionLease(tenantId: string, sessionId: string, leaseMs = DEFAULT_LEASE_MS): string | undefined {
    if (!this.getSession(sessionId, tenantId)) throw new Error(`Session ${sessionId} does not belong to tenant ${tenantId}`);
    return this.transaction(() => {
      const current = nowIso();
      this.db.prepare("DELETE FROM session_leases WHERE tenant_id=? AND session_id=? AND lease_expires_at<=?")
        .run(tenantId, sessionId, current);
      const leaseToken = id("lease");
      const expiresAt = new Date(Date.now() + leaseMs).toISOString();
      const claimed = this.db.prepare(`INSERT OR IGNORE INTO session_leases(tenant_id,session_id,lease_token,lease_expires_at,updated_at)
        VALUES(?,?,?,?,?)`).run(tenantId, sessionId, leaseToken, expiresAt, current);
      return claimed.changes === 1 ? leaseToken : undefined;
    });
  }

  heartbeatSessionLease(tenantId: string, sessionId: string, leaseToken: string, leaseMs = DEFAULT_LEASE_MS): boolean {
    const current = nowIso();
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const result = this.db.prepare(`UPDATE session_leases SET lease_expires_at=?,updated_at=?
      WHERE tenant_id=? AND session_id=? AND lease_token=? AND lease_expires_at>?`)
      .run(expiresAt, current, tenantId, sessionId, leaseToken, current);
    return result.changes === 1;
  }

  hasActiveSessionLease(tenantId: string, sessionId: string, leaseToken: string, at = nowIso()): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM session_leases WHERE tenant_id=? AND session_id=?
      AND lease_token=? AND lease_expires_at>? LIMIT 1`).get(tenantId, sessionId, leaseToken, at));
  }

  releaseSessionLease(tenantId: string, sessionId: string, leaseToken: string): void {
    this.db.prepare("DELETE FROM session_leases WHERE tenant_id=? AND session_id=? AND lease_token=?")
      .run(tenantId, sessionId, leaseToken);
  }

  acquireRunLease(tenantId: string, runId: string, leaseMs = DEFAULT_LEASE_MS): string | undefined {
    const current = nowIso();
    const leaseToken = id("lease");
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const result = this.db.prepare(`UPDATE runs SET lease_token=?,lease_expires_at=?,updated_at=?
      WHERE id=? AND tenant_id=? AND status='running' AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=?)`)
      .run(leaseToken, expiresAt, current, runId, tenantId, current);
    return result.changes === 1 ? leaseToken : undefined;
  }

  hasActiveRunLease(tenantId: string, runId: string, leaseToken: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM runs
      WHERE tenant_id=? AND id=? AND lease_token=? AND status='running' AND lease_expires_at>?`)
      .get(tenantId, runId, leaseToken, nowIso()));
  }

  heartbeatRunLease(tenantId: string, runId: string, leaseToken: string, leaseMs = DEFAULT_LEASE_MS): boolean {
    const current = nowIso();
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const result = this.db.prepare(`UPDATE runs SET lease_expires_at=?,updated_at=?
      WHERE id=? AND tenant_id=? AND lease_token=? AND status='running' AND lease_expires_at>?`)
      .run(expiresAt, current, runId, tenantId, leaseToken, current);
    return result.changes === 1;
  }

  releaseRunLease(tenantId: string, runId: string, leaseToken: string): void {
    this.db.prepare("UPDATE runs SET lease_token=NULL,lease_expires_at=NULL WHERE id=? AND tenant_id=? AND lease_token=?")
      .run(runId, tenantId, leaseToken);
  }

  createApproval(input: Omit<ApprovalRecord, "id" | "status" | "createdAt">): ApprovalRecord {
    if (!this.getRun(input.runId, input.tenantId)) throw new Error(`Run ${input.runId} does not belong to tenant ${input.tenantId}`);
    const approvalId = id("apr");
    const createdAt = nowIso();
    this.db.prepare(`INSERT INTO approvals(id,tenant_id,run_id,tool_call_id,tool_name,arguments_json,risk,status,reason,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,tool_call_id) DO NOTHING`).run(
      approvalId, input.tenantId, input.runId, input.toolCallId, input.toolName, json(input.arguments), input.risk, "pending", input.reason, createdAt,
    );
    const row = this.db.prepare("SELECT * FROM approvals WHERE run_id=? AND tool_call_id=?").get(input.runId, input.toolCallId) as Row;
    return this.approvalFromRow(row);
  }

  getApproval(approvalId: string): ApprovalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id=?").get(approvalId) as Row | undefined;
    return row ? this.approvalFromRow(row) : undefined;
  }

  getApprovalForCall(runId: string, toolCallId: string): ApprovalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE run_id=? AND tool_call_id=?").get(runId, toolCallId) as Row | undefined;
    return row ? this.approvalFromRow(row) : undefined;
  }

  listApprovals(tenantId: string, status = "pending"): ApprovalRecord[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE tenant_id=? AND status=? ORDER BY created_at").all(tenantId, status) as Row[])
      .map((row) => this.approvalFromRow(row));
  }

  decideApproval(approvalId: string, decision: "approved" | "denied"): ApprovalRecord {
    this.db.prepare("UPDATE approvals SET status=?,decided_at=? WHERE id=? AND status='pending'").run(decision, nowIso(), approvalId);
    const approval = this.getApproval(approvalId);
    if (!approval) throw new Error(`Unknown approval ${approvalId}`);
    return approval;
  }

  private approvalFromRow(row: Row): ApprovalRecord {
    const decidedAt = optional(row.decided_at);
    return {
      id: String(row.id), tenantId: String(row.tenant_id), runId: String(row.run_id), toolCallId: String(row.tool_call_id),
      toolName: String(row.tool_name), arguments: parse<JsonObject>(row.arguments_json, {}), risk: String(row.risk),
      status: String(row.status) as ApprovalRecord["status"], reason: String(row.reason), createdAt: String(row.created_at),
      ...(decidedAt ? { decidedAt } : {}),
    };
  }

  claimReceipt(input: {
    tenantId: string;
    runId: string;
    runLeaseToken: string;
    toolCallId: string;
    toolName: string;
    arguments: JsonObject;
    risk: "read" | "local-write" | "external-write" | "destructive";
    idempotencyKey: string;
  }): ToolReceiptClaim {
    return this.transaction(() => {
      const current = nowIso();
      const run = this.db.prepare("SELECT status,lease_token,lease_expires_at FROM runs WHERE id=? AND tenant_id=?")
        .get(input.runId, input.tenantId) as Row | undefined;
      if (!run) throw new Error(`Run ${input.runId} does not belong to tenant ${input.tenantId}`);
      if (run.status !== "running" || run.lease_token !== input.runLeaseToken
        || typeof run.lease_expires_at !== "string" || run.lease_expires_at <= current) {
        throw new Error(`Run lease lost for ${input.runId}`);
      }
      const receiptId = id("rcp");
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO tool_receipts(
        id,tenant_id,run_id,tool_call_id,tool_name,arguments_json,risk,evidence_class,status,effect_state,effect_updated_at,lease_token,idempotency_key,started_at,evidence_scope
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        receiptId, input.tenantId, input.runId, input.toolCallId, input.toolName, json(input.arguments), input.risk,
        input.risk, "running", "not_started", current, input.runLeaseToken, input.idempotencyKey, current, "request",
      );
      let claimed = inserted.changes === 1;
      let row = this.db.prepare("SELECT * FROM tool_receipts WHERE tenant_id=? AND run_id=? AND tool_call_id=?")
        .get(input.tenantId, input.runId, input.toolCallId) as Row | undefined;
      if (!row) throw new Error(`Receipt claim disappeared for ${input.runId}/${input.toolCallId}`);
      if (String(row.tool_name) !== input.toolName || String(row.arguments_json) !== json(input.arguments) || String(row.risk) !== input.risk) {
        throw new Error(`Receipt ${String(row.id)} no longer matches tool call ${input.toolCallId}`);
      }
      // A replacement lease may resume only when the prior owner durably proved
      // that it had not begun the effect. Once accepted, the receipt becomes a
      // reconciliation problem instead of a retry opportunity.
      const priorLease = typeof row.lease_token === "string" ? row.lease_token : null;
      if (!claimed && row.status === "running" && row.effect_state === "not_started" && priorLease !== input.runLeaseToken) {
        const reclaimed = this.db.prepare(`UPDATE tool_receipts SET lease_token=?,effect_updated_at=?
          WHERE id=? AND status='running' AND effect_state='not_started' AND lease_token IS ?`).run(
          input.runLeaseToken, current, String(row.id), priorLease,
        );
        claimed = reclaimed.changes === 1;
        if (claimed) {
          row = this.db.prepare("SELECT * FROM tool_receipts WHERE id=?").get(String(row.id)) as Row;
        }
      }
      return { receipt: this.receiptFromRow(row), claimed };
    });
  }

  beginReceiptEffect(receiptId: string, leaseToken: string, standingAuthorityUseId?: string): boolean {
    const current = nowIso();
    const result = this.db.prepare(`UPDATE tool_receipts SET effect_state='accepted',effect_updated_at=?
      WHERE id=? AND status='running' AND effect_state='not_started' AND lease_token=?
      AND EXISTS (
        SELECT 1 FROM runs WHERE runs.id=tool_receipts.run_id AND runs.tenant_id=tool_receipts.tenant_id
        AND runs.status='running' AND runs.lease_token=? AND runs.lease_expires_at>?
      )
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM mandate_authority_uses u JOIN mandates m ON m.id=u.mandate_id AND m.tenant_id=u.tenant_id
        WHERE u.id=? AND u.tenant_id=tool_receipts.tenant_id AND u.run_id=tool_receipts.run_id
          AND u.tool_call_id=tool_receipts.tool_call_id AND u.tool_name=tool_receipts.tool_name
          AND m.status='active' AND json_valid(m.authority_json)
          AND json_extract(m.authority_json,'$.version')=1
          AND (
            json_extract(m.authority_json,'$.rules[' || u.rule_index || '].expiresAt') IS NULL
            OR json_extract(m.authority_json,'$.rules[' || u.rule_index || '].expiresAt')>?
          )
      ))`).run(
      current, receiptId, leaseToken, leaseToken, current,
      standingAuthorityUseId ?? null, standingAuthorityUseId ?? null, current,
    );
    return result.changes === 1;
  }

  failReceiptBeforeEffect(receiptId: string, leaseToken: string, reason: string): boolean {
    const current = nowIso();
    const result = this.db.prepare(`UPDATE tool_receipts SET status='failed',effect_state='failed',effect_updated_at=?,error=?,completed_at=?
      WHERE id=? AND status='running' AND effect_state='not_started' AND lease_token=?
      AND EXISTS (
        SELECT 1 FROM runs WHERE runs.id=tool_receipts.run_id AND runs.tenant_id=tool_receipts.tenant_id
        AND runs.status='running' AND runs.lease_token=? AND runs.lease_expires_at>?
      )`).run(current, reason.slice(0, 4_000), current, receiptId, leaseToken, leaseToken, current);
    return result.changes === 1;
  }

  markReceiptRecoveryUncertain(receiptId: string, reason: string): boolean {
    const current = nowIso();
    const result = this.db.prepare(`UPDATE tool_receipts
      SET status='uncertain',effect_state='uncertain',effect_updated_at=?,error=?,completed_at=?
      WHERE id=? AND status='running'`).run(current, reason.slice(0, 4_000), current, receiptId);
    return result.changes === 1;
  }

  finishReceipt(input: {
    receiptId: string;
    leaseToken: string;
    status: Exclude<ToolReceiptStatus, "running">;
    output?: JsonValue;
    error?: string;
    evidenceScope?: "request" | "outcome";
  }): boolean {
    const evidenceScope = input.evidenceScope ?? "request";
    const effectState: ToolEffectState = input.status === "succeeded"
      ? evidenceScope === "request" ? "accepted" : "confirmed"
      : input.status;
    const completedAt = nowIso();
    const result = this.db.prepare(`UPDATE tool_receipts SET output_json=?,status=?,effect_state=?,effect_updated_at=?,error=?,evidence_scope=?,completed_at=?
      WHERE id=? AND status='running' AND effect_state='accepted' AND lease_token=?`).run(
      input.output === undefined ? null : json(input.output), input.status, effectState, completedAt,
      input.error ?? null, evidenceScope, completedAt, input.receiptId, input.leaseToken,
    );
    return result.changes === 1;
  }

  getReceipt(tenantId: string, runId: string, toolCallId: string): ToolReceiptRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tool_receipts WHERE tenant_id=? AND run_id=? AND tool_call_id=?")
      .get(tenantId, runId, toolCallId) as Row | undefined;
    return row ? this.receiptFromRow(row) : undefined;
  }

  getReceiptById(tenantId: string, receiptId: string): ToolReceiptRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tool_receipts WHERE tenant_id=? AND id=?").get(tenantId, receiptId) as Row | undefined;
    return row ? this.receiptFromRow(row) : undefined;
  }

  reconcileReceipt(input: {
    tenantId: string;
    receiptId: string;
    decision: "confirmed" | "failed";
    reason: string;
    evidence?: JsonObject;
    output?: JsonValue;
  }): ToolReceiptRecord {
    return this.transaction(() => {
      const receipt = this.getReceiptById(input.tenantId, input.receiptId);
      if (!receipt) throw new Error(`Tool receipt ${input.receiptId} was not found`);
      const prior = this.db.prepare("SELECT decision FROM tool_receipt_reconciliations WHERE tenant_id=? AND receipt_id=?")
        .get(input.tenantId, input.receiptId) as { decision: string } | undefined;
      if (prior) {
        if (prior.decision !== input.decision) throw new Error(`Tool receipt ${input.receiptId} was already reconciled as ${prior.decision}`);
        return receipt;
      }
      const reconcilable = receipt.status === "uncertain" || receipt.effectState === "uncertain"
        || (receipt.status === "succeeded" && receipt.effectState === "accepted" && receipt.evidenceScope === "request");
      if (!reconcilable) throw new Error(`Tool receipt ${input.receiptId} is ${receipt.status}/${receipt.effectState}; only uncertain or accepted request-scoped effects can be reconciled`);
      const reason = input.reason.trim().slice(0, 4_000);
      if (!reason) throw new Error("Receipt reconciliation requires an operator evidence statement");
      const current = nowIso();
      const event = this.appendEvent({
        id: stableId("evt", `receipt-reconciliation:${input.tenantId}:${input.receiptId}`),
        tenantId: input.tenantId,
        stream: `run:${receipt.runId}`,
        type: "tool.receipt_reconciled",
        correlationId: receipt.runId,
        causationId: receipt.id,
        payload: {
          receiptId: receipt.id,
          toolName: receipt.toolName,
          decision: input.decision,
          priorStatus: receipt.status,
          priorEffectState: receipt.effectState,
          reason,
          evidence: input.evidence ?? {},
        },
      });
      const status = input.decision === "confirmed" ? "succeeded" : "failed";
      const evidenceScope = input.decision === "confirmed" ? "outcome" : receipt.evidenceScope;
      const output = input.output === undefined ? null : json(input.output);
      const changed = this.db.prepare(`UPDATE tool_receipts SET
        status=?,effect_state=?,evidence_scope=?,output_json=CASE WHEN ? IS NULL THEN output_json ELSE ? END,
        error=?,effect_updated_at=?,completed_at=?
        WHERE tenant_id=? AND id=? AND (
          status='uncertain' OR effect_state='uncertain'
          OR (status='succeeded' AND effect_state='accepted' AND evidence_scope='request')
        )`).run(
        status, input.decision, evidenceScope, output, output,
        input.decision === "failed" ? reason : null, current, current, input.tenantId, input.receiptId,
      );
      if (changed.changes !== 1) throw new Error(`Tool receipt ${input.receiptId} changed while it was being reconciled`);
      this.db.prepare(`INSERT INTO tool_receipt_reconciliations(
        id,tenant_id,receipt_id,run_id,decision,prior_status,prior_effect_state,reason,evidence_json,event_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        stableId("rrc", `${input.tenantId}:${input.receiptId}`), input.tenantId, input.receiptId, receipt.runId,
        input.decision, receipt.status, receipt.effectState, reason, json(input.evidence ?? {}), event.id, current,
      );
      return this.getReceiptById(input.tenantId, input.receiptId) as ToolReceiptRecord;
    });
  }

  private receiptFromRow(row: Row): ToolReceiptRecord {
    const output = typeof row.output_json === "string" ? JSON.parse(row.output_json) as JsonValue : undefined;
    const error = optional(row.error);
    const leaseToken = optional(row.lease_token);
    const completedAt = optional(row.completed_at);
    const evidenceClass = String(row.evidence_class || row.risk) as ToolReceiptRecord["evidenceClass"];
    const evidenceScope = String(row.evidence_scope ?? "") as ToolReceiptRecord["evidenceScope"];
    const status = String(row.status) as ToolReceiptStatus;
    const effectState = String(row.effect_state || "uncertain") as ToolEffectState;
    if (!["running", "succeeded", "failed", "uncertain"].includes(status)) throw new Error(`Receipt ${String(row.id)} has invalid status ${status}`);
    if (!["read", "local-write", "external-write", "destructive"].includes(evidenceClass)) {
      throw new Error(`Receipt ${String(row.id)} has invalid evidence class ${evidenceClass}`);
    }
    if (evidenceScope !== "request" && evidenceScope !== "outcome") throw new Error(`Receipt ${String(row.id)} has invalid evidence scope ${evidenceScope}`);
    if (!["not_started", "accepted", "confirmed", "failed", "uncertain"].includes(effectState)) {
      throw new Error(`Receipt ${String(row.id)} has invalid effect state ${effectState}`);
    }
    return {
      id: String(row.id), tenantId: String(row.tenant_id), runId: String(row.run_id), toolCallId: String(row.tool_call_id),
      toolName: String(row.tool_name), arguments: parse<JsonObject>(row.arguments_json, {}), ...(output !== undefined ? { output } : {}),
      risk: String(row.risk), evidenceClass, evidenceScope, status, effectState, ...(error ? { error } : {}), ...(leaseToken ? { leaseToken } : {}),
      idempotencyKey: String(row.idempotency_key), startedAt: String(row.started_at), effectUpdatedAt: String(row.effect_updated_at), ...(completedAt ? { completedAt } : {}),
    };
  }

  getOutboundDeliveryState(tenantId: string, intentId: string): OutboundDeliveryState | undefined {
    const row = this.db.prepare("SELECT tenant_id,state FROM outbound_deliveries WHERE intent_id=?").get(intentId) as Row | undefined;
    if (!row) return undefined;
    if (row.tenant_id !== tenantId) throw new Error(`Outbound delivery ${intentId} belongs to another tenant`);
    const state = String(row.state);
    if (!["not_started", "running", "retryable", "accepted", "failed", "uncertain"].includes(state)) {
      throw new Error(`Outbound delivery ${intentId} has invalid state ${state}`);
    }
    return state as OutboundDeliveryState;
  }

  assertOutboundDeliveryBinding(input: { tenantId: string; intentId: string; requestDigest: string; channel: string; peerId: string }): void {
    const row = this.db.prepare(`SELECT tenant_id,request_digest,channel,peer_id FROM outbound_deliveries WHERE intent_id=?`)
      .get(input.intentId) as Row | undefined;
    if (!row) throw new Error(`Outbound delivery ${input.intentId} was not found`);
    if (row.tenant_id !== input.tenantId) throw new Error(`Outbound delivery ${input.intentId} belongs to another tenant`);
    if (row.request_digest !== input.requestDigest || row.channel !== input.channel || row.peer_id !== input.peerId) {
      throw new Error(`Outbound delivery idempotency key ${input.intentId} was rebound to different content or routing`);
    }
  }

  registerLegacyUncertainOutboundDelivery(input: {
    tenantId: string;
    intentId: string;
    requestDigest: string;
    channel: string;
    peerId: string;
    error: string;
  }): void {
    this.transaction(() => {
      const current = nowIso();
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO outbound_deliveries(
        intent_id,tenant_id,request_digest,channel,peer_id,state,attempt,last_error,created_at,updated_at
      ) VALUES(?,?,?,?,?,'uncertain',1,?,?,?)`).run(
        input.intentId, input.tenantId, input.requestDigest, input.channel, input.peerId,
        input.error.slice(0, 4_000), current, current,
      );
      if (!inserted.changes) this.assertOutboundDeliveryBinding(input);
    });
  }

  reconcileOutboundDelivery(input: {
    tenantId: string;
    intentId: string;
    decision: "accepted" | "failed";
    reason: string;
    evidence?: JsonObject;
    providerMessageId?: string;
  }): OutboundDeliveryReconciliation {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM outbound_deliveries WHERE tenant_id=? AND intent_id=?")
        .get(input.tenantId, input.intentId) as Row | undefined;
      if (!row) throw new Error(`Outbound delivery ${input.intentId} was not found`);
      const reason = input.reason.trim().slice(0, 4_000);
      if (!reason) throw new Error("Delivery reconciliation requires an operator evidence statement");
      const providerMessageId = input.providerMessageId?.trim().slice(0, 1_000);
      if (input.decision === "accepted" && !providerMessageId) {
        throw new Error("Accepted delivery reconciliation requires the provider message ID");
      }
      const prior = this.db.prepare(`SELECT decision,provider_message_id,event_id FROM outbound_delivery_reconciliations
        WHERE tenant_id=? AND intent_id=?`).get(input.tenantId, input.intentId) as Row | undefined;
      if (prior) {
        if (String(prior.decision) !== input.decision) {
          throw new Error(`Outbound delivery ${input.intentId} was already reconciled as ${String(prior.decision)}`);
        }
        const priorProviderId = optional(prior.provider_message_id);
        if (input.decision === "accepted" && priorProviderId !== providerMessageId) {
          throw new Error(`Outbound delivery ${input.intentId} was already reconciled with a different provider message ID`);
        }
        return {
          intentId: input.intentId, state: input.decision, channel: String(row.channel), peerId: String(row.peer_id),
          eventId: String(prior.event_id), applied: false,
        };
      }
      if (String(row.state) !== "uncertain") {
        throw new Error(`Outbound delivery ${input.intentId} is ${String(row.state)}; only uncertain deliveries can be reconciled`);
      }
      const current = nowIso();
      const started = this.getEvent<JsonObject>(input.tenantId, input.intentId);
      const correlationId = started?.correlationId ?? `delivery:${input.intentId}`;
      const event = this.appendEvent({
        id: stableId("evt", `delivery-reconciliation:${input.tenantId}:${input.intentId}`),
        tenantId: input.tenantId,
        stream: started?.stream ?? `delivery:${input.intentId}`,
        type: "message.delivery_reconciled",
        correlationId,
        causationId: input.intentId,
        payload: {
          intentId: input.intentId,
          decision: input.decision,
          priorState: String(row.state),
          channel: String(row.channel),
          peerId: String(row.peer_id),
          providerMessageId: providerMessageId ?? null,
          reason,
          evidence: input.evidence ?? {},
        },
      });
      const changed = input.decision === "accepted"
        ? this.db.prepare(`UPDATE outbound_deliveries SET state='accepted',claim_token=NULL,lease_expires_at=NULL,
            acceptance_event_id=?,accepted_at=COALESCE(accepted_at,?),failed_at=NULL,last_error=NULL,updated_at=?
            WHERE tenant_id=? AND intent_id=? AND state='uncertain'`)
          .run(event.id, current, current, input.tenantId, input.intentId)
        : this.db.prepare(`UPDATE outbound_deliveries SET state='failed',claim_token=NULL,lease_expires_at=NULL,
            acceptance_event_id=NULL,accepted_at=NULL,delivered_at=NULL,read_at=NULL,failed_at=COALESCE(failed_at,?),last_error=?,updated_at=?
            WHERE tenant_id=? AND intent_id=? AND state='uncertain'`)
          .run(current, reason, current, input.tenantId, input.intentId);
      if (changed.changes !== 1) throw new Error(`Outbound delivery ${input.intentId} changed while it was being reconciled`);
      this.db.prepare(`INSERT INTO outbound_delivery_reconciliations(
        id,tenant_id,intent_id,decision,prior_state,provider_message_id,reason,evidence_json,event_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        stableId("drc", `${input.tenantId}:${input.intentId}`), input.tenantId, input.intentId, input.decision,
        String(row.state), providerMessageId ?? null, reason, json(input.evidence ?? {}), event.id, current,
      );
      return {
        intentId: input.intentId, state: input.decision, channel: String(row.channel), peerId: String(row.peer_id),
        eventId: event.id, applied: true,
      };
    });
  }

  claimOutboundDelivery(input: {
    tenantId: string;
    intentId: string;
    requestDigest: string;
    channel: string;
    peerId: string;
  }, leaseMs = 120_000): OutboundDeliveryClaim {
    return this.transaction(() => {
      const current = nowIso();
      const leaseExpiresAt = new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString();
      const claimToken = id("lease");
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO outbound_deliveries(
        intent_id,tenant_id,request_digest,channel,peer_id,state,attempt,claim_token,lease_expires_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,'not_started',1,?,?,?,?)`).run(
        input.intentId, input.tenantId, input.requestDigest, input.channel, input.peerId,
        claimToken, leaseExpiresAt, current, current,
      );
      if (inserted.changes === 1) return { state: "claimed", attempt: 1, claimToken, leaseExpiresAt };

      const row = this.db.prepare("SELECT * FROM outbound_deliveries WHERE intent_id=?").get(input.intentId) as Row | undefined;
      if (!row) throw new Error(`Outbound delivery claim ${input.intentId} disappeared`);
      if (row.tenant_id !== input.tenantId) throw new Error(`Outbound delivery ${input.intentId} belongs to another tenant`);
      if (row.request_digest !== input.requestDigest || row.channel !== input.channel || row.peer_id !== input.peerId) {
        throw new Error(`Outbound delivery ${input.intentId} was rebound to different content or routing`);
      }
      const attempt = Number(row.attempt);
      if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error(`Outbound delivery ${input.intentId} has an invalid attempt count`);
      const state = String(row.state);
      const error = optional(row.last_error);
      if (state === "accepted") return { state: "accepted", attempt, ...(error ? { error } : {}) };
      if (state === "failed") return { state: "failed", attempt, ...(error ? { error } : {}) };
      if (state === "uncertain") return { state: "uncertain", attempt, ...(error ? { error } : {}) };
      if (state === "running") {
        if (typeof row.lease_expires_at === "string" && row.lease_expires_at > current) {
          return { state: "in_flight", attempt, leaseExpiresAt: row.lease_expires_at };
        }
        const reason = "Outbound delivery owner disappeared after effect initiation; reconcile the provider outcome before retrying.";
        this.db.prepare(`UPDATE outbound_deliveries SET state='uncertain',claim_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=?
          WHERE intent_id=? AND state='running'`).run(reason, current, input.intentId);
        return { state: "uncertain", attempt, error: reason };
      }
      if (state !== "not_started" && state !== "retryable") throw new Error(`Outbound delivery ${input.intentId} has invalid state ${state}`);
      if (state === "not_started" && typeof row.lease_expires_at === "string" && row.lease_expires_at > current) {
        return { state: "in_flight", attempt, leaseExpiresAt: row.lease_expires_at };
      }
      const nextAttempt = state === "retryable" ? attempt + 1 : attempt;
      const reclaimed = this.db.prepare(`UPDATE outbound_deliveries
        SET state='not_started',attempt=?,claim_token=?,lease_expires_at=?,last_error=NULL,updated_at=?
        WHERE intent_id=? AND state=?`).run(nextAttempt, claimToken, leaseExpiresAt, current, input.intentId, state);
      if (reclaimed.changes !== 1) return { state: "in_flight", attempt };
      return { state: "claimed", attempt: nextAttempt, claimToken, leaseExpiresAt };
    });
  }

  failOutboundBeforeEffect(intentId: string, tenantId: string, claimToken: string, reason: string): boolean {
    const current = nowIso();
    return this.db.prepare(`UPDATE outbound_deliveries SET state='failed',claim_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=?
      WHERE intent_id=? AND tenant_id=? AND state='not_started' AND claim_token=? AND lease_expires_at>?`)
      .run(reason.slice(0, 4_000), current, intentId, tenantId, claimToken, current).changes === 1;
  }

  beginOutboundDelivery(intentId: string, tenantId: string, claimToken: string): boolean {
    const current = nowIso();
    const result = this.db.prepare(`UPDATE outbound_deliveries SET state='running',updated_at=?
      WHERE intent_id=? AND tenant_id=? AND state='not_started' AND claim_token=? AND lease_expires_at>?`)
      .run(current, intentId, tenantId, claimToken, current);
    return result.changes === 1;
  }

  settleOutboundDelivery(input: {
    intentId: string;
    tenantId: string;
    claimToken: string;
    state: "retryable" | "accepted" | "failed" | "uncertain";
    acceptanceEventId?: string;
    error?: string;
  }): boolean {
    const result = this.db.prepare(`UPDATE outbound_deliveries
      SET state=?,claim_token=NULL,lease_expires_at=NULL,acceptance_event_id=?,last_error=?,updated_at=?
      WHERE intent_id=? AND tenant_id=? AND state='running' AND claim_token=?`).run(
      input.state, input.acceptanceEventId ?? null, input.error?.slice(0, 4_000) ?? null, nowIso(),
      input.intentId, input.tenantId, input.claimToken,
    );
    return result.changes === 1;
  }

  reconcileOutboundDeliveryAcceptance(tenantId: string, intentId: string, acceptanceEventId: string): boolean {
    const event = this.db.prepare(`SELECT id FROM events WHERE id=? AND tenant_id=? AND causation_id=?
      AND type IN ('message.delivery_accepted','message.reaction_accepted','message.delivered')`).get(acceptanceEventId, tenantId, intentId);
    if (!event) throw new Error(`Event ${acceptanceEventId} does not prove acceptance for outbound delivery ${intentId}`);
    const result = this.db.prepare(`UPDATE outbound_deliveries
      SET state='accepted',claim_token=NULL,lease_expires_at=NULL,acceptance_event_id=?,accepted_at=COALESCE(accepted_at,?),last_error=NULL,updated_at=?
      WHERE intent_id=? AND tenant_id=? AND state IN ('not_started','running','retryable','uncertain')`).run(acceptanceEventId, nowIso(), nowIso(), intentId, tenantId);
    return result.changes === 1;
  }

  reconcileOutboundDeliveryStatus(
    tenantId: string,
    acceptanceEventId: string,
    status: "delivered" | "read" | "failed",
    statusAt = nowIso(),
  ): { intentId: string; applied: boolean } | undefined {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT intent_id FROM outbound_deliveries WHERE tenant_id=? AND acceptance_event_id=?")
        .get(tenantId, acceptanceEventId) as Row | undefined;
      if (!row) return undefined;
      const intentId = String(row.intent_id);
      const assignment = status === "delivered"
        ? "delivered_at=COALESCE(delivered_at,?)"
        : status === "read"
          ? "read_at=COALESCE(read_at,?),delivered_at=COALESCE(delivered_at,?)"
          : "failed_at=COALESCE(failed_at,?),delivered_at=NULL,read_at=NULL,state='failed'";
      const values: SqlValue[] = status === "read" ? [statusAt, statusAt] : [statusAt];
      const guard = status === "failed" ? "" : " AND failed_at IS NULL AND state!='failed'";
      const changed = this.db.prepare(`UPDATE outbound_deliveries SET ${assignment},updated_at=? WHERE tenant_id=? AND intent_id=?${guard}`)
        .run(...values, statusAt, tenantId, intentId);
      return { intentId, applied: changed.changes === 1 };
    });
  }

  expireStaleOutboundDeliveries(tenantId: string, at = nowIso()): ExpiredOutboundDelivery[] {
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT d.intent_id,d.tenant_id,d.channel,d.peer_id,e.correlation_id
        FROM outbound_deliveries d LEFT JOIN events e ON e.id=d.intent_id AND e.tenant_id=d.tenant_id
        WHERE d.tenant_id=? AND d.state='running' AND d.lease_expires_at IS NOT NULL AND d.lease_expires_at<=?
        ORDER BY d.updated_at,d.intent_id`).all(tenantId, at) as Row[];
      const error = "Outbound delivery owner disappeared after effect initiation; reconcile the provider outcome before retrying.";
      const expired: ExpiredOutboundDelivery[] = [];
      for (const row of rows) {
        const changed = this.db.prepare(`UPDATE outbound_deliveries SET state='uncertain',claim_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=?
          WHERE tenant_id=? AND intent_id=? AND state='running' AND lease_expires_at<=?`).run(error, at, tenantId, String(row.intent_id), at);
        if (changed.changes === 1) expired.push({
          intentId: String(row.intent_id), tenantId: String(row.tenant_id), runId: optional(row.correlation_id) ?? `delivery:${String(row.intent_id)}`,
          channel: String(row.channel), peerId: String(row.peer_id), error,
        });
      }
      return expired;
    });
  }

  enqueueJob(tenantId: string, type: string, payload: JsonObject, options: { runAfter?: string; maxAttempts?: number; idempotencyKey?: string; releaseId?: string } = {}): JobRecord {
    const jobId = options.idempotencyKey ? stableId("job", `${tenantId}:${type}:${options.idempotencyKey}`) : id("job");
    const current = nowIso();
    const runAfter = options.runAfter ?? current;
    const maxAttempts = options.maxAttempts ?? 3;
    const releaseId = options.releaseId ?? this.jobReleaseResolver?.(tenantId);
    const subjectId = ["workOrderId", "messageId", "approvalId", "goalId", "promiseId", "sourceEventId"]
      .map((key) => payload[key]).find((value): value is string => typeof value === "string" && value.length > 0);
    this.db.prepare(`INSERT OR IGNORE INTO jobs(id,tenant_id,type,status,release_id,subject_type,subject_id,payload_json,attempts,max_attempts,run_after,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(jobId, tenantId, type, "queued", releaseId ?? null, subjectId ? type : null, subjectId ?? null, json(payload), 0, maxAttempts, runAfter, current, current);
    let job = this.getJob(jobId, tenantId);
    if (!job) throw new Error(`Job ${jobId} could not be persisted`);
    if (releaseId && job.releaseId && job.releaseId !== releaseId) {
      throw new Error(`Job ${jobId} is already pinned to a different behavior release`);
    }
    if (releaseId && !job.releaseId) {
      const bound = this.db.prepare("UPDATE jobs SET release_id=?,updated_at=? WHERE id=? AND tenant_id=? AND status='queued' AND release_id IS NULL")
        .run(releaseId, current, jobId, tenantId);
      if (bound.changes !== 1) throw new Error(`Job ${jobId} changed before its behavior release could be pinned`);
      job = this.getJob(jobId, tenantId) as JobRecord;
    }
    if (subjectId && !job.subjectId) {
      this.db.prepare("UPDATE jobs SET subject_type=?,subject_id=?,updated_at=? WHERE id=? AND tenant_id=? AND subject_id IS NULL")
        .run(type, subjectId, current, jobId, tenantId);
      job = this.getJob(jobId, tenantId) as JobRecord;
    }
    return job;
  }

  claimJob(tenantId?: string, leaseMs = DEFAULT_LEASE_MS, limits: { agentTurns?: number } = {}): JobRecord | undefined {
    return this.transaction(() => {
      const agentLimit = Math.max(1, Math.floor(limits.agentTurns ?? Number.MAX_SAFE_INTEGER));
      const row = tenantId
        ? this.db.prepare(`SELECT id FROM jobs WHERE tenant_id=? AND status='queued' AND run_after<=?
          AND (type!='agent.turn' OR (SELECT COUNT(*) FROM jobs active WHERE active.tenant_id=? AND active.type='agent.turn' AND active.status='running')<?)
          ORDER BY CASE WHEN type='perception.synthesize' THEN 1 ELSE 0 END,run_after,created_at LIMIT 1`).get(tenantId, nowIso(), tenantId, agentLimit) as Row | undefined
        : this.db.prepare(`SELECT id FROM jobs WHERE status='queued' AND run_after<=?
          AND (type!='agent.turn' OR (SELECT COUNT(*) FROM jobs active WHERE active.type='agent.turn' AND active.status='running')<?)
          ORDER BY CASE WHEN type='perception.synthesize' THEN 1 ELSE 0 END,run_after,created_at LIMIT 1`).get(nowIso(), agentLimit) as Row | undefined;
      if (!row) return undefined;
      const jobId = String(row.id);
      const lockedAt = nowIso();
      const leaseToken = id("lease");
      const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      const claimed = this.db.prepare(`UPDATE jobs SET status='running',attempts=attempts+1,locked_at=?,lease_token=?,lease_expires_at=?,updated_at=?
        WHERE id=? AND status='queued'`).run(lockedAt, leaseToken, leaseExpiresAt, lockedAt, jobId);
      return claimed.changes === 1 ? this.getJob(jobId, tenantId) : undefined;
    });
  }

  expireExhaustedStaleJobs(tenantId: string, staleBefore: string): JobRecord[] {
    return this.transaction(() => {
      const current = nowIso();
      const rows = this.db.prepare(`SELECT id FROM jobs WHERE tenant_id=? AND status='running' AND attempts>=max_attempts
        AND ((lease_expires_at IS NOT NULL AND lease_expires_at<=?) OR (lease_expires_at IS NULL AND locked_at<?))
        ORDER BY updated_at,id`).all(tenantId, current, staleBefore) as Row[];
      const reason = "worker lease expired on the final allowed attempt; not retried";
      for (const row of rows) {
        this.db.prepare(`UPDATE jobs SET status='failed',locked_at=NULL,lease_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=?
          WHERE id=? AND tenant_id=? AND status='running' AND attempts>=max_attempts`).run(reason, current, String(row.id), tenantId);
      }
      return rows.flatMap((row) => {
        const job = this.getJob(String(row.id), tenantId);
        return job ? [job] : [];
      });
    });
  }

  requeueStaleJobs(tenantId: string, staleBefore: string): number {
    const current = nowIso();
    const result = this.db.prepare(`UPDATE jobs SET status='queued',locked_at=NULL,lease_token=NULL,lease_expires_at=NULL,run_after=?,last_error='worker lease expired; retrying',updated_at=?
      WHERE tenant_id=? AND status='running' AND attempts<max_attempts
        AND ((lease_expires_at IS NOT NULL AND lease_expires_at<=?) OR (lease_expires_at IS NULL AND locked_at<?))`)
      .run(current, current, tenantId, current, staleBefore);
    return Number(result.changes);
  }

  findStaleRunId(tenantId: string, staleBefore: string): string | undefined {
    const current = nowIso();
    const row = this.db.prepare(`SELECT r.id FROM runs r WHERE r.tenant_id=? AND r.status='running'
      AND (r.resume_not_before IS NULL OR r.resume_not_before<=?)
      AND ((r.lease_expires_at IS NOT NULL AND r.lease_expires_at<=?) OR (r.lease_expires_at IS NULL AND r.updated_at<?))
      AND NOT EXISTS (
        SELECT 1 FROM jobs j WHERE j.tenant_id=r.tenant_id AND j.status IN ('queued','running') AND (
          (j.type='work.execute' AND EXISTS (
            SELECT 1 FROM work_orders w WHERE w.tenant_id=r.tenant_id AND w.run_id=r.id
              AND json_valid(j.payload_json) AND json_extract(j.payload_json,'$.workOrderId')=w.id
          ))
          OR (j.type IN ('channel.turn','agent.turn') AND EXISTS (
            SELECT 1 FROM inbound_receipts i WHERE i.tenant_id=r.tenant_id AND i.run_id=r.id
              AND json_valid(j.payload_json) AND json_extract(j.payload_json,'$.externalId')=i.external_id
          ))
          OR (j.type='agent.turn' AND EXISTS (
            SELECT 1 FROM inbound_receipts i WHERE i.tenant_id=r.tenant_id AND i.run_id=r.id
              AND json_valid(j.payload_json) AND json_extract(j.payload_json,'$.messageId')=i.external_id
          ))
          OR (j.type='approval.decide' AND EXISTS (
            SELECT 1 FROM approvals a WHERE a.tenant_id=r.tenant_id AND a.run_id=r.id
              AND json_valid(j.payload_json) AND json_extract(j.payload_json,'$.approvalId')=a.id
          ))
        )
      )
      ORDER BY r.updated_at LIMIT 1`).get(tenantId, current, current, staleBefore) as Row | undefined;
    return row ? String(row.id) : undefined;
  }

  findStaleRun(tenantId: string, staleBefore: string): RunRecord | undefined {
    const runId = this.findStaleRunId(tenantId, staleBefore);
    return runId ? this.getRun(runId, tenantId) : undefined;
  }

  quarantineCorruptRun(tenantId: string, runId: string, reason: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT state_json,status FROM runs WHERE tenant_id=? AND id=?").get(tenantId, runId) as Row | undefined;
      if (!row) throw new Error(`Unknown run ${runId}`);
      if (typeof row.state_json !== "string" || !row.state_json) throw new Error(`Run ${runId} has no state to quarantine`);
      const quarantinedAt = nowIso();
      this.db.prepare(`INSERT OR IGNORE INTO run_state_quarantine(id,tenant_id,run_id,state_json,reason,quarantined_at)
        VALUES(?,?,?,?,?,?)`).run(stableId("quarantine", `${tenantId}:${runId}`), tenantId, runId, row.state_json, reason, quarantinedAt);
      this.db.prepare(`UPDATE runs SET status='failed',output=?,state_json=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
        WHERE tenant_id=? AND id=?`).run(reason, quarantinedAt, tenantId, runId);
      this.appendEvent({
        id: stableId("evt", `run-state-quarantined:${tenantId}:${runId}`), tenantId, stream: `run:${runId}`,
        type: "run.recovery_blocked", correlationId: runId,
        payload: { runId, reason, quarantineId: stableId("quarantine", `${tenantId}:${runId}`) },
      });
    });
  }

  heartbeatJob(jobId: string, leaseToken: string, leaseMs = DEFAULT_LEASE_MS): boolean {
    const current = nowIso();
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const result = this.db.prepare(`UPDATE jobs SET lease_expires_at=?,updated_at=?
      WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?`)
      .run(expiresAt, current, jobId, leaseToken, current);
    return result.changes === 1;
  }

  hasActiveJobLease(jobId: string, leaseToken: string, at = nowIso()): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM jobs
      WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?`).get(jobId, leaseToken, at));
  }

  withActiveJobLease<T>(jobId: string, leaseToken: string, operation: () => T): T {
    return this.transaction(() => {
      const current = nowIso();
      const active = this.db.prepare(`SELECT 1 FROM jobs
        WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?`).get(jobId, leaseToken, current);
      if (!active) throw new Error(`Job lease lost for ${jobId}`);
      return operation();
    });
  }

  finishJob(jobId: string, leaseToken: string, error?: string, retryable = true, retryAfterMs?: number): boolean {
    return this.transaction(() => {
      const current = nowIso();
      const job = this.db.prepare(`SELECT attempts,max_attempts,run_after FROM jobs
        WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?`)
        .get(jobId, leaseToken, current) as Row | undefined;
      if (!job) {
        const exists = this.db.prepare("SELECT 1 FROM jobs WHERE id=?").get(jobId);
        if (!exists) throw new Error(`Unknown job ${jobId}`);
        return false;
      }
      const attempts = Number(job.attempts);
      const retry = Boolean(error) && retryable && attempts < Number(job.max_attempts);
      const exponentialDelay = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
      const requestedDelay = Number.isFinite(retryAfterMs) ? Math.max(0, Number(retryAfterMs)) : 0;
      const delayMs = Math.min(24 * 60 * 60_000, Math.max(exponentialDelay, requestedDelay));
      const next = new Date(Date.now() + delayMs).toISOString();
      const result = this.db.prepare(`UPDATE jobs SET status=?,run_after=?,locked_at=NULL,lease_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=?
        WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?`)
        .run(error ? (retry ? "queued" : "failed") : "completed", retry ? next : String(job.run_after), error ?? null, current, jobId, leaseToken, current);
      return result.changes === 1;
    });
  }

  getJob(jobId: string, tenantId?: string): JobRecord | undefined {
    const row = tenantId
      ? this.db.prepare("SELECT * FROM jobs WHERE id=? AND tenant_id=?").get(jobId, tenantId) as Row | undefined
      : this.db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId) as Row | undefined;
    if (!row) return undefined;
    const lockedAt = optional(row.locked_at);
    const leaseToken = optional(row.lease_token);
    const leaseExpiresAt = optional(row.lease_expires_at);
    const lastError = optional(row.last_error);
    const releaseId = optional(row.release_id);
    const subjectType = optional(row.subject_type);
    const subjectId = optional(row.subject_id);
    return {
      id: String(row.id), tenantId: String(row.tenant_id), type: String(row.type), status: String(row.status) as JobRecord["status"],
      ...(releaseId ? { releaseId } : {}),
      ...(subjectType ? { subjectType } : {}), ...(subjectId ? { subjectId } : {}),
      payload: parse<JsonObject>(row.payload_json, {}), attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts),
      runAfter: String(row.run_after), ...(lockedAt ? { lockedAt } : {}), ...(leaseToken ? { leaseToken } : {}),
      ...(leaseExpiresAt ? { leaseExpiresAt } : {}), ...(lastError ? { lastError } : {}),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  listJobs(tenantId: string, limit = 50): JobRecord[] {
    return (this.db.prepare("SELECT id FROM jobs WHERE tenant_id=? ORDER BY updated_at DESC LIMIT ?").all(tenantId, limit) as Row[])
      .flatMap((row) => {
        const job = this.getJob(String(row.id), tenantId);
        return job ? [job] : [];
      });
  }

  createSkillProposal(input: {
    tenantId: string;
    name: string;
    description: string;
    instructions: string;
    evidenceEventIds: string[];
    sourceRunId?: string;
    sourceEventId: string;
    supersedesId?: string;
  }): SkillProposalRecord {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM skill_proposals WHERE tenant_id=? AND name=?")
        .get(input.tenantId, input.name) as Row;
      const version = Number(row.version) + 1;
      const proposalId = id("skp");
      const current = nowIso();
      this.db.prepare(`INSERT INTO skill_proposals(
        id,tenant_id,name,version,description,instructions,evidence_event_ids_json,status,source_run_id,source_event_id,supersedes_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        proposalId, input.tenantId, input.name, version, input.description, input.instructions, json(input.evidenceEventIds), "proposed",
        input.sourceRunId ?? null, input.sourceEventId, input.supersedesId ?? null, current, current,
      );
      return this.getSkillProposal(proposalId, input.tenantId) as SkillProposalRecord;
    });
  }

  getSkillProposal(proposalId: string, tenantId?: string): SkillProposalRecord | undefined {
    const row = tenantId
      ? this.db.prepare("SELECT * FROM skill_proposals WHERE id=? AND tenant_id=?").get(proposalId, tenantId) as Row | undefined
      : this.db.prepare("SELECT * FROM skill_proposals WHERE id=?").get(proposalId) as Row | undefined;
    return row ? this.skillProposalFromRow(row) : undefined;
  }

  listSkillProposals(tenantId: string, status?: SkillProposalStatus, limit = 100): SkillProposalRecord[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM skill_proposals WHERE tenant_id=? AND status=? ORDER BY created_at DESC LIMIT ?").all(tenantId, status, limit) as Row[]
      : this.db.prepare("SELECT * FROM skill_proposals WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?").all(tenantId, limit) as Row[];
    return rows.map((row) => this.skillProposalFromRow(row));
  }

  transitionSkillProposal(proposalId: string, tenantId: string, from: SkillProposalStatus[], to: SkillProposalStatus, installedPath?: string): SkillProposalRecord {
    if (!from.length) throw new Error("Skill proposal transition requires at least one source state");
    const placeholders = from.map(() => "?").join(",");
    const current = nowIso();
    const result = this.db.prepare(`UPDATE skill_proposals SET status=?,installed_path=COALESCE(?,installed_path),updated_at=?,decided_at=?
      WHERE id=? AND tenant_id=? AND status IN (${placeholders})`).run(to, installedPath ?? null, current, current, proposalId, tenantId, ...from);
    if (result.changes !== 1) {
      const existing = this.getSkillProposal(proposalId, tenantId);
      if (!existing) throw new Error(`Unknown skill proposal ${proposalId}`);
      throw new Error(`Skill proposal ${proposalId} cannot transition from ${existing.status} to ${to}`);
    }
    return this.getSkillProposal(proposalId, tenantId) as SkillProposalRecord;
  }

  private skillProposalFromRow(row: Row): SkillProposalRecord {
    const sourceRunId = optional(row.source_run_id);
    const supersedesId = optional(row.supersedes_id);
    const installedPath = optional(row.installed_path);
    const decidedAt = optional(row.decided_at);
    return {
      id: String(row.id), tenantId: String(row.tenant_id), name: String(row.name), version: Number(row.version),
      description: String(row.description), instructions: String(row.instructions),
      evidenceEventIds: parse<string[]>(row.evidence_event_ids_json, []), status: String(row.status) as SkillProposalStatus,
      ...(sourceRunId ? { sourceRunId } : {}), sourceEventId: String(row.source_event_id),
      ...(supersedesId ? { supersedesId } : {}), ...(installedPath ? { installedPath } : {}),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), ...(decidedAt ? { decidedAt } : {}),
    };
  }
}
