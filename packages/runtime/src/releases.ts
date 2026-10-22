import { createHash, randomBytes } from "node:crypto";
import { id, nowIso, stableId } from "./id.ts";
import type { ModelRole, ModelRoute, ToolRisk } from "./types.ts";
import type { SqliteStore } from "./store.ts";
import type { LoadedSkill } from "./skills.ts";

const modelRoles: ModelRole[] = ["foreground", "deliberation", "background", "critic"];
const providers = new Set(["openai", "anthropic", "openai-compatible", "codex-cli", "claude-code-cli", "mock"]);
const efforts = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const risks: ToolRisk[] = ["read", "local-write", "external-write", "destructive"];

export interface ReleaseSkillVersion {
  name: string;
  version: number;
  /** Present on every newly persisted release. Missing fields identify a
   * legacy reference-only manifest, which remains readable but is not safe to
   * execute. */
  digest?: string;
  description?: string;
  keywords?: string[];
  instructions?: string;
}

export interface ReleaseSkillSnapshot extends ReleaseSkillVersion {
  digest: string;
  description: string;
  keywords: string[];
  instructions: string;
}

/** An immutable, complete behavior snapshot. Partial overlays are deliberately
 * rejected: a canary must say exactly which prompt, routes, skills, and policy
 * it is testing. */
export interface ReleaseManifest {
  version: 1;
  label: string;
  distributionId: string;
  systemPrompt: string;
  models: Record<ModelRole, ModelRoute>;
  skills: ReleaseSkillVersion[];
  autoApproveRisks: ToolRisk[];
}

export interface ReleaseRecord {
  id: string;
  distributionId: string;
  label: string;
  digest: string;
  manifest: ReleaseManifest;
  createdAt: string;
}

export interface ReleaseRollout {
  id: string;
  distributionId: string;
  stableReleaseId: string;
  candidateReleaseId?: string;
  candidateBasisPoints: number;
  rollbackReleaseId?: string;
  status: "active" | "superseded" | "rolled_back";
  createdAt: string;
  endedAt?: string;
}

export interface ReleaseAssignment {
  rolloutId: string;
  release: ReleaseRecord;
  cohort: "stable" | "canary";
  assignedAt: string;
}

type Row = Record<string, string | number | bigint | null | Uint8Array>;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(raw: Record<string, unknown>, allowed: string[], field: string): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${field} contains unknown fields: ${unknown.join(", ")}`);
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return normalized;
}

function skillSnapshotDigest(skill: Omit<ReleaseSkillSnapshot, "digest">): string {
  return createHash("sha256").update(canonical({
    name: skill.name, version: skill.version, description: skill.description,
    keywords: skill.keywords, instructions: skill.instructions,
  })).digest("hex");
}

export function snapshotReleaseSkill(skill: LoadedSkill): ReleaseSkillSnapshot {
  const snapshot = {
    name: skill.name, version: skill.version, description: skill.description,
    keywords: [...new Set(skill.keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))].sort(),
    instructions: skill.instructions,
  };
  return { ...snapshot, digest: skillSnapshotDigest(snapshot) };
}

export function isReleaseSkillSnapshot(skill: ReleaseSkillVersion): skill is ReleaseSkillSnapshot {
  return typeof skill.digest === "string" && typeof skill.description === "string"
    && Array.isArray(skill.keywords) && typeof skill.instructions === "string";
}

function parseRoute(value: unknown, field: string): ModelRoute {
  const raw = object(value, field);
  exactKeys(raw, ["provider", "model", "maxOutputTokens", "reasoningEffort", "baseUrl", "apiKeyEnv", "costCeiling"], field);
  if (typeof raw.provider !== "string" || !providers.has(raw.provider)) throw new Error(`${field}.provider is invalid`);
  const model = boundedString(raw.model, `${field}.model`, 512);
  if (!Number.isSafeInteger(raw.maxOutputTokens) || Number(raw.maxOutputTokens) < 128 || Number(raw.maxOutputTokens) > 1_000_000) {
    throw new Error(`${field}.maxOutputTokens must be an integer from 128 to 1000000`);
  }
  if (typeof raw.reasoningEffort !== "string" || !efforts.has(raw.reasoningEffort)) throw new Error(`${field}.reasoningEffort is invalid`);
  const baseUrl = raw.baseUrl === undefined ? undefined : boundedString(raw.baseUrl, `${field}.baseUrl`, 2_048);
  const apiKeyEnv = raw.apiKeyEnv === undefined ? undefined : boundedString(raw.apiKeyEnv, `${field}.apiKeyEnv`, 128);
  if (apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error(`${field}.apiKeyEnv must be an environment variable name`);
  let costCeiling: ModelRoute["costCeiling"];
  if (raw.costCeiling !== undefined) {
    const cost = object(raw.costCeiling, `${field}.costCeiling`);
    exactKeys(cost, ["inputUsdPerMillionTokens", "outputUsdPerMillionTokens", "maxRequestUsd"], `${field}.costCeiling`);
    const amount = (value_: unknown, name: string, minimum: number): number => {
      if (typeof value_ !== "number" || !Number.isFinite(value_) || value_ < minimum || value_ > 1_000_000) {
        throw new Error(`${field}.costCeiling.${name} must be a finite number from ${minimum} to 1000000`);
      }
      return value_;
    };
    const inputUsdPerMillionTokens = amount(cost.inputUsdPerMillionTokens, "inputUsdPerMillionTokens", 0);
    const outputUsdPerMillionTokens = amount(cost.outputUsdPerMillionTokens, "outputUsdPerMillionTokens", 0);
    const maxRequestUsd = amount(cost.maxRequestUsd, "maxRequestUsd", 0.000001);
    if (inputUsdPerMillionTokens === 0 && outputUsdPerMillionTokens === 0) {
      throw new Error(`${field}.costCeiling requires a non-zero input or output price`);
    }
    costCeiling = { inputUsdPerMillionTokens, outputUsdPerMillionTokens, maxRequestUsd };
  }
  return {
    provider: raw.provider as ModelRoute["provider"], model, maxOutputTokens: Number(raw.maxOutputTokens),
    reasoningEffort: raw.reasoningEffort as ModelRoute["reasoningEffort"],
    ...(baseUrl ? { baseUrl } : {}), ...(apiKeyEnv ? { apiKeyEnv } : {}), ...(costCeiling ? { costCeiling } : {}),
  };
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const raw = object(value, "Release manifest");
  exactKeys(raw, ["version", "label", "distributionId", "systemPrompt", "models", "skills", "autoApproveRisks"], "Release manifest");
  if (raw.version !== 1) throw new Error("Release manifest version must be 1");
  const label = boundedString(raw.label, "Release manifest label", 128);
  const distributionId = boundedString(raw.distributionId, "Release manifest distributionId", 64);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(distributionId)) throw new Error("Release manifest distributionId is invalid");
  const systemPrompt = boundedString(raw.systemPrompt, "Release manifest systemPrompt", 100_000);
  const rawModels = object(raw.models, "Release manifest models");
  exactKeys(rawModels, modelRoles, "Release manifest models");
  if (modelRoles.some((role) => rawModels[role] === undefined)) throw new Error("Release manifest must define all model roles");
  const models = Object.fromEntries(modelRoles.map((role) => [role, parseRoute(rawModels[role], `Release manifest models.${role}`)])) as Record<ModelRole, ModelRoute>;
  if (!Array.isArray(raw.skills) || raw.skills.length > 1_000) throw new Error("Release manifest skills must be an array with at most 1000 entries");
  const skillNames = new Set<string>();
  const skills = raw.skills.map((candidate, index) => {
    const skill = object(candidate, `Release manifest skills[${index}]`);
    exactKeys(skill, ["name", "version", "digest", "description", "keywords", "instructions"], `Release manifest skills[${index}]`);
    const name = boundedString(skill.name, `Release manifest skills[${index}].name`, 128);
    if (skillNames.has(name)) throw new Error(`Release manifest contains duplicate skill ${name}`);
    skillNames.add(name);
    if (!Number.isSafeInteger(skill.version) || Number(skill.version) < 1) throw new Error(`Release manifest skill ${name} has an invalid version`);
    const snapshotFields = [skill.digest, skill.description, skill.keywords, skill.instructions];
    const hasSnapshotField = snapshotFields.some((field) => field !== undefined);
    if (!hasSnapshotField) return { name, version: Number(skill.version) };
    if (typeof skill.digest !== "string" || !/^[a-f0-9]{64}$/.test(skill.digest)) {
      throw new Error(`Release manifest skill ${name} has an invalid digest`);
    }
    const description = boundedString(skill.description, `Release manifest skill ${name}.description`, 10_000);
    if (!Array.isArray(skill.keywords) || skill.keywords.length > 256 || skill.keywords.some((keyword) => typeof keyword !== "string" || !keyword.trim() || keyword.length > 128)) {
      throw new Error(`Release manifest skill ${name}.keywords is invalid`);
    }
    if (typeof skill.instructions !== "string" || !skill.instructions.trim() || skill.instructions.length > 30_000) {
      throw new Error(`Release manifest skill ${name}.instructions is invalid`);
    }
    const snapshot = {
      name, version: Number(skill.version), description,
      keywords: [...new Set((skill.keywords as string[]).map((keyword) => keyword.trim().toLowerCase()))].sort(),
      instructions: skill.instructions,
    };
    const expected = skillSnapshotDigest(snapshot);
    if (skill.digest !== expected) throw new Error(`Release manifest skill ${name} failed its content integrity check`);
    return { ...snapshot, digest: expected };
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (!Array.isArray(raw.autoApproveRisks) || raw.autoApproveRisks.some((risk) => typeof risk !== "string" || !risks.includes(risk as ToolRisk))) {
    throw new Error("Release manifest autoApproveRisks is invalid");
  }
  const autoApproveRisks = [...new Set(raw.autoApproveRisks as ToolRisk[])].sort((left, right) => risks.indexOf(left) - risks.indexOf(right));
  return { version: 1, label, distributionId, systemPrompt, models, skills, autoApproveRisks };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(manifest: ReleaseManifest): string {
  return createHash("sha256").update(canonical(manifest)).digest("hex");
}

function releaseFromRow(row: Row): ReleaseRecord {
  let parsed: unknown;
  try { parsed = JSON.parse(String(row.manifest_json)); } catch { throw new Error(`Release ${String(row.id)} has corrupt manifest JSON`); }
  const manifest = parseReleaseManifest(parsed);
  const expected = digest(manifest);
  if (expected !== String(row.manifest_digest)) throw new Error(`Release ${String(row.id)} failed its manifest integrity check`);
  if (manifest.distributionId !== String(row.distribution_id) || manifest.label !== String(row.label)) {
    throw new Error(`Release ${String(row.id)} metadata does not match its manifest`);
  }
  return {
    id: String(row.id), distributionId: String(row.distribution_id), label: String(row.label), digest: expected,
    manifest, createdAt: String(row.created_at),
  };
}

function rolloutFromRow(row: Row): ReleaseRollout {
  const candidate = typeof row.candidate_release_id === "string" && row.candidate_release_id ? row.candidate_release_id : undefined;
  const rollback = typeof row.rollback_release_id === "string" && row.rollback_release_id ? row.rollback_release_id : undefined;
  const endedAt = typeof row.ended_at === "string" && row.ended_at ? row.ended_at : undefined;
  const status = String(row.status);
  const basisPoints = Number(row.candidate_basis_points);
  if (status !== "active" && status !== "superseded" && status !== "rolled_back") throw new Error(`Release rollout ${String(row.id)} has an invalid status`);
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 9_999
    || (candidate ? basisPoints === 0 : basisPoints !== 0)) throw new Error(`Release rollout ${String(row.id)} has an invalid candidate allocation`);
  if (!/^[a-f0-9]{32}$/.test(String(row.cohort_salt))) throw new Error(`Release rollout ${String(row.id)} has an invalid cohort salt`);
  return {
    id: String(row.id), distributionId: String(row.distribution_id), stableReleaseId: String(row.stable_release_id),
    ...(candidate ? { candidateReleaseId: candidate } : {}), candidateBasisPoints: basisPoints,
    ...(rollback ? { rollbackReleaseId: rollback } : {}), status,
    createdAt: String(row.created_at), ...(endedAt ? { endedAt } : {}),
  };
}

export class ReleaseManager {
  readonly store: SqliteStore;
  readonly distributionId: string;
  readonly baseline: ReleaseRecord;
  private readonly validateRuntimeManifest: ((manifest: ReleaseManifest) => void) | undefined;
  private readonly resolveSkillSnapshot: ((name: string, version: number) => ReleaseSkillSnapshot | undefined) | undefined;
  private readonly migrationTenantId: string;

  constructor(store: SqliteStore, baselineManifest: ReleaseManifest, options: {
    validateRuntimeManifest?: (manifest: ReleaseManifest) => void;
    resolveSkillSnapshot?: (name: string, version: number) => ReleaseSkillSnapshot | undefined;
    migrationTenantId?: string;
  } = {}) {
    this.store = store;
    this.validateRuntimeManifest = options.validateRuntimeManifest;
    this.resolveSkillSnapshot = options.resolveSkillSnapshot;
    this.migrationTenantId = options.migrationTenantId ?? "system";
    const manifest = parseReleaseManifest(baselineManifest);
    this.distributionId = manifest.distributionId;
    this.baseline = this.store.transaction(() => {
      const release = this.insertManifest(manifest);
      const active = this.activeRolloutRow();
      if (!active) {
        const at = nowIso();
        this.store.db.prepare(`INSERT INTO release_rollouts(
          id,distribution_id,stable_release_id,candidate_release_id,candidate_basis_points,cohort_salt,rollback_release_id,status,created_at,ended_at
        ) VALUES(?,?,?,?,?,?,?,?,?,NULL)`).run(
          stableId("rollout", `${this.distributionId}:${release.digest}:baseline`), this.distributionId, release.id, null, 0,
          randomBytes(16).toString("hex"), null, "active", at,
        );
      } else {
        this.migrateLegacyActiveRollout(active);
      }
      return release;
    });
  }

  private snapshotManifest(manifest: ReleaseManifest): ReleaseManifest {
    const parsed = parseReleaseManifest(manifest);
    const skills = parsed.skills.map((skill) => {
      if (isReleaseSkillSnapshot(skill)) return skill;
      const snapshot = this.resolveSkillSnapshot?.(skill.name, skill.version);
      if (!snapshot) throw new Error(`Release requires unavailable immutable skill snapshot ${skill.name}@${skill.version}`);
      return snapshot;
    });
    return parseReleaseManifest({ ...parsed, skills });
  }

  private migrateLegacyActiveRollout(activeRow: Row): void {
    const active = rolloutFromRow(activeRow);
    const migrate = (releaseId: string | undefined): string | undefined => {
      if (!releaseId) return undefined;
      const prior = this.requireRelease(releaseId);
      if (prior.manifest.skills.every(isReleaseSkillSnapshot)) return releaseId;
      return this.insertManifest(this.snapshotManifest(prior.manifest)).id;
    };
    const stableReleaseId = migrate(active.stableReleaseId) as string;
    const candidateReleaseId = migrate(active.candidateReleaseId);
    const rollbackReleaseId = migrate(active.rollbackReleaseId);
    if (stableReleaseId === active.stableReleaseId && candidateReleaseId === active.candidateReleaseId
      && rollbackReleaseId === active.rollbackReleaseId) return;
    const at = nowIso();
    this.store.db.prepare("UPDATE release_rollouts SET status='superseded',ended_at=? WHERE id=? AND status='active'")
      .run(at, active.id);
    const rolloutId = stableId("rollout", `${active.id}:immutable-skills:${stableReleaseId}:${candidateReleaseId ?? ""}:${rollbackReleaseId ?? ""}`);
    this.store.db.prepare(`INSERT INTO release_rollouts(
      id,distribution_id,stable_release_id,candidate_release_id,candidate_basis_points,cohort_salt,rollback_release_id,status,created_at,ended_at
    ) VALUES(?,?,?,?,?,?,?,?,?,NULL)`).run(
      rolloutId, this.distributionId, stableReleaseId, candidateReleaseId ?? null,
      candidateReleaseId ? active.candidateBasisPoints : 0, String(activeRow.cohort_salt), rollbackReleaseId ?? null, "active", at,
    );
    this.store.appendEvent({
      tenantId: this.migrationTenantId, stream: "runtime:releases", type: "release.legacy_skill_references_migrated",
      payload: {
        priorRolloutId: active.id, rolloutId, priorStableReleaseId: active.stableReleaseId, stableReleaseId,
        priorCandidateReleaseId: active.candidateReleaseId ?? null, candidateReleaseId: candidateReleaseId ?? null,
        note: "New releases snapshot the skill contents available at migration; prior manifests and assignments remain unchanged as history.",
      },
    });
  }

  private insertManifest(manifest: ReleaseManifest): ReleaseRecord {
    const parsed = this.snapshotManifest(manifest);
    if (parsed.distributionId !== this.distributionId) throw new Error(`Release targets ${parsed.distributionId}, not ${this.distributionId}`);
    const manifestDigest = digest(parsed);
    const releaseId = stableId("release", `${parsed.distributionId}:${manifestDigest}`);
    const createdAt = nowIso();
    this.store.db.prepare(`INSERT OR IGNORE INTO release_manifests(
      id,distribution_id,label,manifest_json,manifest_digest,created_at
    ) VALUES(?,?,?,?,?,?)`).run(releaseId, parsed.distributionId, parsed.label, canonical(parsed), manifestDigest, createdAt);
    const row = this.store.db.prepare("SELECT * FROM release_manifests WHERE id=?").get(releaseId) as Row | undefined;
    if (!row) throw new Error("Release manifest could not be persisted");
    return releaseFromRow(row);
  }

  private activeRolloutRow(): Row | undefined {
    return this.store.db.prepare("SELECT * FROM release_rollouts WHERE distribution_id=? AND status='active'").get(this.distributionId) as Row | undefined;
  }

  private replaceRollout(input: { stableReleaseId: string; candidateReleaseId?: string; candidateBasisPoints: number; rollbackReleaseId?: string; rolledBack?: boolean }): ReleaseRollout {
    return this.store.transaction(() => {
      const active = this.activeRolloutRow();
      const at = nowIso();
      if (active) this.store.db.prepare("UPDATE release_rollouts SET status=?,ended_at=? WHERE id=? AND status='active'")
        .run(input.rolledBack ? "rolled_back" : "superseded", at, String(active.id));
      const rolloutId = id("rollout");
      this.store.db.prepare(`INSERT INTO release_rollouts(
        id,distribution_id,stable_release_id,candidate_release_id,candidate_basis_points,cohort_salt,rollback_release_id,status,created_at,ended_at
      ) VALUES(?,?,?,?,?,?,?,?,?,NULL)`).run(
        rolloutId, this.distributionId, input.stableReleaseId, input.candidateReleaseId ?? null, input.candidateBasisPoints,
        randomBytes(16).toString("hex"), input.rollbackReleaseId ?? null, "active", at,
      );
      const row = this.store.db.prepare("SELECT * FROM release_rollouts WHERE id=?").get(rolloutId) as Row;
      return rolloutFromRow(row);
    });
  }

  private requireRelease(releaseId: string): ReleaseRecord {
    const row = this.store.db.prepare("SELECT * FROM release_manifests WHERE id=? AND distribution_id=?")
      .get(releaseId, this.distributionId) as Row | undefined;
    if (!row) throw new Error(`Unknown release ${releaseId}`);
    return releaseFromRow(row);
  }

  private requireRunnableRelease(releaseId: string): ReleaseRecord {
    const release = this.requireRelease(releaseId);
    this.validateRuntimeManifest?.(release.manifest);
    return release;
  }

  stage(tenantId: string, manifest: ReleaseManifest): ReleaseRecord {
    return this.store.transaction(() => {
      const release = this.insertManifest(manifest);
      this.store.appendEvent({ tenantId, stream: "runtime:releases", type: "release.staged", payload: {
        releaseId: release.id, label: release.label, digest: release.digest, distributionId: release.distributionId,
      } });
      return release;
    });
  }

  canary(tenantId: string, candidateReleaseId: string, candidateBasisPoints: number): ReleaseRollout {
    if (!Number.isSafeInteger(candidateBasisPoints) || candidateBasisPoints < 1 || candidateBasisPoints > 9_999) {
      throw new Error("Canary basis points must be an integer from 1 to 9999");
    }
    return this.store.transaction(() => {
      this.requireRunnableRelease(candidateReleaseId);
      const active = this.active();
      this.requireRunnableRelease(active.stableReleaseId);
      if (candidateReleaseId === active.stableReleaseId) throw new Error("The stable release cannot also be its own canary");
      const rollout = this.replaceRollout({
        stableReleaseId: active.stableReleaseId, candidateReleaseId, candidateBasisPoints,
        ...(active.rollbackReleaseId ? { rollbackReleaseId: active.rollbackReleaseId } : {}),
      });
      this.store.appendEvent({ tenantId, stream: "runtime:releases", type: "release.canary_started", payload: {
        rolloutId: rollout.id, stableReleaseId: rollout.stableReleaseId, candidateReleaseId, candidateBasisPoints,
      } });
      return rollout;
    });
  }

  promote(tenantId: string, releaseId: string): ReleaseRollout {
    return this.store.transaction(() => {
      this.requireRunnableRelease(releaseId);
      const active = this.active();
      if (active.candidateReleaseId !== releaseId) throw new Error("Only the active canary release can be promoted");
      const rollout = this.replaceRollout({ stableReleaseId: releaseId, candidateBasisPoints: 0, rollbackReleaseId: active.stableReleaseId });
      this.store.appendEvent({ tenantId, stream: "runtime:releases", type: "release.promoted", payload: {
        rolloutId: rollout.id, releaseId, rollbackReleaseId: active.stableReleaseId,
      } });
      return rollout;
    });
  }

  rollback(tenantId: string, targetReleaseId?: string): ReleaseRollout {
    return this.store.transaction(() => {
      const active = this.active();
      const target = targetReleaseId ?? (active.candidateReleaseId ? active.stableReleaseId : active.rollbackReleaseId);
      if (!target) throw new Error("No rollback release is recorded; provide an explicit target release id");
      this.requireRunnableRelease(target);
      const rollbackReleaseId = target === active.stableReleaseId ? active.rollbackReleaseId : active.stableReleaseId;
      const rollout = this.replaceRollout({
        stableReleaseId: target, candidateBasisPoints: 0, ...(rollbackReleaseId ? { rollbackReleaseId } : {}), rolledBack: true,
      });
      this.store.appendEvent({ tenantId, stream: "runtime:releases", type: "release.rolled_back", payload: {
        rolloutId: rollout.id, releaseId: target, fromStableReleaseId: active.stableReleaseId,
        droppedCandidateReleaseId: active.candidateReleaseId ?? null,
      } });
      return rollout;
    });
  }

  active(): ReleaseRollout {
    const row = this.activeRolloutRow();
    if (!row) throw new Error(`Distribution ${this.distributionId} has no active release rollout`);
    const rollout = rolloutFromRow(row);
    this.requireRelease(rollout.stableReleaseId);
    if (rollout.candidateReleaseId) this.requireRelease(rollout.candidateReleaseId);
    return rollout;
  }

  list(): ReleaseRecord[] {
    const rows = this.store.db.prepare("SELECT * FROM release_manifests WHERE distribution_id=? ORDER BY created_at,id")
      .all(this.distributionId) as Row[];
    return rows.map(releaseFromRow);
  }

  assign(tenantId: string): ReleaseAssignment {
    return this.store.transaction(() => {
      const activeRow = this.activeRolloutRow();
      if (!activeRow) throw new Error(`Distribution ${this.distributionId} has no active release rollout`);
      const rollout = rolloutFromRow(activeRow);
      const existing = this.store.db.prepare("SELECT release_id,cohort,assigned_at FROM release_assignments WHERE tenant_id=? AND rollout_id=?")
        .get(tenantId, rollout.id) as Row | undefined;
      let releaseId: string;
      let cohort: ReleaseAssignment["cohort"];
      let assignedAt: string;
      if (existing) {
        releaseId = String(existing.release_id);
        if (existing.cohort !== "stable" && existing.cohort !== "canary") throw new Error(`Release assignment for ${tenantId} has an invalid cohort`);
        cohort = existing.cohort;
        assignedAt = String(existing.assigned_at);
        const expectedReleaseId = cohort === "canary" ? rollout.candidateReleaseId : rollout.stableReleaseId;
        if (!expectedReleaseId || releaseId !== expectedReleaseId) throw new Error(`Release assignment for ${tenantId} does not match its rollout`);
      } else {
        const salt = String(activeRow.cohort_salt);
        const bucket = createHash("sha256").update(`${salt}:${tenantId}`).digest().readUInt32BE(0) % 10_000;
        cohort = rollout.candidateReleaseId && bucket < rollout.candidateBasisPoints ? "canary" : "stable";
        releaseId = cohort === "canary" ? rollout.candidateReleaseId as string : rollout.stableReleaseId;
        assignedAt = nowIso();
        this.store.db.prepare(`INSERT INTO release_assignments(tenant_id,rollout_id,release_id,cohort,assigned_at)
          VALUES(?,?,?,?,?)`).run(tenantId, rollout.id, releaseId, cohort, assignedAt);
      }
      return { rolloutId: rollout.id, release: this.requireRunnableRelease(releaseId), cohort, assignedAt };
    });
  }

  assignmentForRelease(tenantId: string, releaseId: string): ReleaseAssignment {
    const row = this.store.db.prepare(`SELECT a.rollout_id,a.cohort,a.assigned_at,r.*
      FROM release_assignments a JOIN release_rollouts r ON r.id=a.rollout_id
      WHERE a.tenant_id=? AND a.release_id=? ORDER BY a.assigned_at DESC LIMIT 1`).get(tenantId, releaseId) as Row | undefined;
    if (row) {
      const rollout = rolloutFromRow(row);
      const cohort = row.cohort;
      if (cohort !== "stable" && cohort !== "canary") throw new Error(`Release assignment for ${tenantId} has an invalid cohort`);
      const expectedReleaseId = cohort === "canary" ? rollout.candidateReleaseId : rollout.stableReleaseId;
      if (expectedReleaseId !== releaseId) throw new Error(`Release assignment for ${tenantId} does not match its rollout`);
      return {
        rolloutId: String(row.rollout_id), release: this.requireRunnableRelease(releaseId), cohort,
        assignedAt: String(row.assigned_at),
      };
    }
    const current = this.assign(tenantId);
    if (current.release.id !== releaseId) throw new Error(`Release ${releaseId} was never assigned to tenant ${tenantId}`);
    return current;
  }

  status(tenantId: string): {
    rollout: ReleaseRollout;
    assignment: { rolloutId: string; releaseId: string; releaseDigest: string; releaseLabel: string; cohort: ReleaseAssignment["cohort"]; assignedAt: string };
    releases: Array<Omit<ReleaseRecord, "manifest"> & { promptDigest: string; models: ReleaseManifest["models"]; skills: Array<{ name: string; version: number; digest: string | null }>; autoApproveRisks: ToolRisk[] }>;
  } {
    const rollout = this.active();
    const assignment = this.assign(tenantId);
    return {
      rollout,
      assignment: {
        rolloutId: assignment.rolloutId, releaseId: assignment.release.id, releaseDigest: assignment.release.digest,
        releaseLabel: assignment.release.label, cohort: assignment.cohort, assignedAt: assignment.assignedAt,
      },
      releases: this.list().map((release) => ({
        id: release.id, distributionId: release.distributionId, label: release.label, digest: release.digest, createdAt: release.createdAt,
        promptDigest: createHash("sha256").update(release.manifest.systemPrompt).digest("hex"), models: release.manifest.models,
        skills: release.manifest.skills.map((skill) => ({ name: skill.name, version: skill.version, digest: skill.digest ?? null })),
        autoApproveRisks: release.manifest.autoApproveRisks,
      })),
    };
  }
}
