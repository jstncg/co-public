import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { nowIso } from "./id.ts";
import type { SqliteStore, SkillProposalRecord, SkillProposalStatus } from "./store.ts";
import type { RuntimeConfig } from "./types.ts";

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function bounded(value: string, field: string, maximum: number): string {
  const result = value.trim();
  if (!result) throw new Error(`${field} is required`);
  if (result.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  if (result.includes("\0")) throw new Error(`${field} contains a null byte`);
  return result;
}

function recordJson(record: SkillProposalRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    version: record.version,
    description: record.description,
    instructions: record.instructions,
    evidenceEventIds: record.evidenceEventIds,
    status: record.status,
    sourceRunId: record.sourceRunId ?? null,
    sourceEventId: record.sourceEventId,
    supersedesId: record.supersedesId ?? null,
    installedPath: record.installedPath ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export class SkillLearningManager {
  readonly config: RuntimeConfig;
  readonly store: SqliteStore;
  private readonly onInstalledSkillsChanged: (() => void) | undefined;

  constructor(config: RuntimeConfig, store: SqliteStore, onInstalledSkillsChanged?: () => void) {
    this.config = config;
    this.store = store;
    this.onInstalledSkillsChanged = onInstalledSkillsChanged;
  }

  private assertTenant(tenantId: string): void {
    if (tenantId !== this.config.tenantId) throw new Error(`Skill learner is scoped to tenant ${this.config.tenantId}`);
  }

  private markRetired(proposal: SkillProposalRecord, reason: string): void {
    if (!proposal.installedPath || !existsSync(proposal.installedPath)) throw new Error(`Installed skill file is missing for proposal ${proposal.id}`);
    mkdirSync(this.config.learnedSkillRoot, { recursive: true, mode: 0o700 });
    const canonicalRoot = realpathSync(this.config.learnedSkillRoot);
    const canonicalDirectory = realpathSync(dirname(proposal.installedPath));
    if (!within(canonicalRoot, canonicalDirectory)) throw new Error("Installed skill resolves outside the tenant skill root");
    const marker = resolve(canonicalDirectory, "RETIRED");
    const body = `Proposal: ${proposal.id}\nReason: ${reason}\nRetired: ${nowIso()}\n`;
    if (existsSync(marker)) {
      if (!readFileSync(marker, "utf8").includes(`Proposal: ${proposal.id}\n`)) throw new Error(`Retirement marker has different provenance: ${marker}`);
    } else writeFileSync(marker, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }

  propose(input: {
    tenantId: string;
    name: string;
    description: string;
    instructions: string;
    evidenceEventIds: string[];
    sourceEventId: string;
    sourceRunId?: string;
    supersedesId?: string;
  }): SkillProposalRecord {
    this.assertTenant(input.tenantId);
    const name = bounded(input.name, "Skill name", 64).toLowerCase();
    if (!SKILL_NAME.test(name)) throw new Error("Skill name must use lowercase letters, numbers, and hyphens");
    const description = bounded(input.description.replace(/\s+/g, " "), "Skill description", 1_000);
    const instructions = bounded(input.instructions, "Skill instructions", 30_000);
    if (!this.store.getEvent(input.tenantId, input.sourceEventId)) throw new Error(`Skill source event ${input.sourceEventId} does not belong to tenant ${input.tenantId}`);
    const evidenceEventIds = [...new Set([input.sourceEventId, ...input.evidenceEventIds])].slice(0, 32);
    for (const eventId of evidenceEventIds) {
      if (!this.store.getEvent(input.tenantId, eventId)) throw new Error(`Skill evidence event ${eventId} does not belong to tenant ${input.tenantId}`);
    }
    if (input.sourceRunId && !this.store.getRun(input.sourceRunId, input.tenantId)) throw new Error(`Skill source run ${input.sourceRunId} does not belong to tenant ${input.tenantId}`);
    if (input.supersedesId) {
      const prior = this.store.getSkillProposal(input.supersedesId, input.tenantId);
      if (!prior || prior.name !== name || prior.status !== "installed") throw new Error("A skill revision must supersede an installed proposal with the same name");
    }
    return this.store.transaction(() => {
      const proposal = this.store.createSkillProposal({
        tenantId: input.tenantId, name, description, instructions, evidenceEventIds,
        sourceEventId: input.sourceEventId,
        ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
        ...(input.supersedesId ? { supersedesId: input.supersedesId } : {}),
      });
      this.store.appendEvent({
        tenantId: input.tenantId, stream: `skill:${name}`, type: "skill.proposed", causationId: input.sourceEventId,
        payload: { proposalId: proposal.id, name, version: proposal.version, evidenceEventIds },
      });
      return proposal;
    });
  }

  approve(tenantId: string, proposalId: string): SkillProposalRecord {
    this.assertTenant(tenantId);
    return this.store.transaction(() => {
      const proposal = this.store.transitionSkillProposal(proposalId, tenantId, ["proposed"], "approved");
      this.store.appendEvent({ tenantId, stream: `skill:${proposal.name}`, type: "skill.approved", payload: { proposalId, name: proposal.name, version: proposal.version } });
      return proposal;
    });
  }

  reject(tenantId: string, proposalId: string): SkillProposalRecord {
    this.assertTenant(tenantId);
    return this.store.transaction(() => {
      const proposal = this.store.transitionSkillProposal(proposalId, tenantId, ["proposed", "approved"], "rejected");
      this.store.appendEvent({ tenantId, stream: `skill:${proposal.name}`, type: "skill.rejected", payload: { proposalId, name: proposal.name, version: proposal.version } });
      return proposal;
    });
  }

  retire(tenantId: string, proposalId: string): SkillProposalRecord {
    this.assertTenant(tenantId);
    const proposal = this.store.getSkillProposal(proposalId, tenantId);
    if (!proposal) throw new Error(`Unknown skill proposal ${proposalId}`);
    if (proposal.status === "retired") {
      this.onInstalledSkillsChanged?.();
      return proposal;
    }
    if (proposal.status !== "installed") throw new Error(`Skill proposal ${proposalId} cannot transition from ${proposal.status} to retired`);
    this.markRetired(proposal, "operator retirement");
    const retired = this.store.transaction(() => {
      const retiredCount = this.store.transitionSkillProposal(proposalId, tenantId, ["installed"], "retired");
      this.store.appendEvent({ tenantId, stream: `skill:${proposal.name}`, type: "skill.retired", payload: { proposalId, name: proposal.name, version: proposal.version, reason: "operator" } });
      return retiredCount;
    });
    this.onInstalledSkillsChanged?.();
    return retired;
  }

  install(tenantId: string, proposalId: string): SkillProposalRecord {
    this.assertTenant(tenantId);
    const proposal = this.store.getSkillProposal(proposalId, tenantId);
    if (!proposal) throw new Error(`Unknown skill proposal ${proposalId}`);
    const directory = resolve(this.config.learnedSkillRoot, proposal.name, `v${String(proposal.version).padStart(4, "0")}`);
    const path = resolve(directory, "SKILL.md");
    if (proposal.status === "installed" && proposal.installedPath === path && existsSync(path)) {
      this.onInstalledSkillsChanged?.();
      return proposal;
    }
    if (proposal.status !== "approved") throw new Error(`Skill proposal ${proposalId} must be approved before installation`);
    mkdirSync(this.config.learnedSkillRoot, { recursive: true, mode: 0o700 });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const canonicalRoot = realpathSync(this.config.learnedSkillRoot);
    const canonicalDirectory = realpathSync(directory);
    if (!within(canonicalRoot, canonicalDirectory)) throw new Error("Learned skill directory resolves outside the tenant skill root");
    const description = proposal.description.replace(/[\r\n]+/g, " ").replaceAll('"', "'");
    const body = `---\nname: ${proposal.name}\nversion: ${proposal.version}\ndescription: "${description}"\nkeywords: learned, reusable, procedure\n---\n\n${proposal.instructions}\n\n## Provenance\n\n- Proposal: ${proposal.id}\n- Source event: ${proposal.sourceEventId}\n- Evidence events: ${proposal.evidenceEventIds.join(", ")}\n- Installed: ${nowIso()}\n`;
    if (existsSync(path)) {
      if (!readFileSync(path, "utf8").includes(`- Proposal: ${proposal.id}\n`)) {
        throw new Error(`Learned skill path already contains different provenance: ${path}`);
      }
    } else writeFileSync(path, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const superseded = proposal.supersedesId ? this.store.getSkillProposal(proposal.supersedesId, tenantId) : undefined;
    if (superseded) this.markRetired(superseded, `superseded by ${proposal.id}`);
    const installed = this.store.transaction(() => {
      const installedCount = this.store.transitionSkillProposal(proposalId, tenantId, ["approved"], "installed", path);
      if (proposal.supersedesId) {
        const retired = this.store.transitionSkillProposal(proposal.supersedesId, tenantId, ["installed"], "retired");
        this.store.appendEvent({
          tenantId, stream: `skill:${proposal.name}`, type: "skill.retired",
          payload: { proposalId: retired.id, name: retired.name, version: retired.version, reason: "superseded", supersededById: proposal.id },
        });
      }
      this.store.appendEvent({
        tenantId, stream: `skill:${proposal.name}`, type: "skill.installed",
        payload: { proposalId, name: proposal.name, version: proposal.version, path, supersedesId: proposal.supersedesId ?? null },
      });
      return installedCount;
    });
    this.onInstalledSkillsChanged?.();
    return installed;
  }

  list(tenantId: string, status?: SkillProposalStatus): Array<Record<string, unknown>> {
    this.assertTenant(tenantId);
    return this.store.listSkillProposals(tenantId, status).map(recordJson);
  }
}
