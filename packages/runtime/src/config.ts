import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coEnv, legacyCoEnvName } from "./env.ts";
import { canonicalMemberPeerId } from "./identity.ts";
import { PluginRegistry } from "./plugins.ts";
import { readSecret } from "./secrets.ts";
import type { EmailProviderName, ExecutionBackendName, ExecutionConfig, McpServerConfig, MediaAnalyzerName, ModelCostCeiling, ModelRole, ModelRoute, ProviderName, ReasoningEffort, RuntimeConfig, RuntimeEnvironment, ToolRisk } from "./types.ts";

export interface CoProfile {
  version: 1;
  id: string;
  tenantId: string;
  memberPeerIds?: string[];
  distribution?: string;
  distributionConfig?: string;
  timezone?: string;
  location?: string;
  workspaceRoots?: string[];
  skillRoots?: string[];
  pluginRoots?: string[];
  plugins?: string[];
  models?: Partial<Record<ModelRole, ModelRoute>>;
  execution?: ExecutionConfig;
}

interface ConfigOverrides extends Partial<Pick<RuntimeConfig, "tenantId" | "dbPath">> {
  profilePath?: string;
}

function coSecret(name: `CO_${string}`): string | undefined {
  if (process.env[name] !== undefined || process.env[`${name}_FILE`] !== undefined
    || process.env[`${name}_DOTENV_FILE`] !== undefined) return readSecret(name);
  return readSecret(legacyCoEnvName(name));
}

function serverCredential(): string | undefined {
  const source = coEnv("CO_SERVER_TOKEN_ENV");
  if (!source) return coSecret("CO_SERVER_TOKEN");
  if (!/^[A-Z_][A-Z0-9_]*$/.test(source)) throw new Error("CO_SERVER_TOKEN_ENV must name an environment variable");
  if (process.env.CO_SERVER_TOKEN !== undefined || process.env.CO_SERVER_TOKEN_FILE !== undefined
    || process.env.CO_SERVER_TOKEN_DOTENV_FILE !== undefined) {
    throw new Error("Set CO_SERVER_TOKEN_ENV or a direct CO_SERVER_TOKEN source, not both");
  }
  const credential = readSecret(source);
  if (!credential) throw new Error(`CO_SERVER_TOKEN_ENV references missing secret ${source}`);
  return credential;
}

function defaultRuntimeHome(): string {
  const configured = coEnv("CO_HOME");
  if (configured) return resolve(configured);
  const primary = resolve(homedir(), ".co");
  const legacy = resolve(homedir(), ".companion");
  if (!existsSync(resolve(primary, "runtime.sqlite")) && existsSync(resolve(legacy, "runtime.sqlite"))) return legacy;
  return existsSync(primary) || !existsSync(legacy) ? primary : legacy;
}

function canonicalDistribution(value: string | undefined): string {
  return value === "companion" ? "co" : value ?? "co";
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`${field} must contain only letters, numbers, underscores, or hyphens`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalStrings(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${field} must be a non-empty string array`);
  return value.map((item) => (item as string).trim());
}

function rejectUnknown(raw: Record<string, unknown>, allowed: string[], field: string): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${field} contains unknown fields: ${unknown.join(", ")}`);
}

function modelCostCeiling(value: unknown, field: string): ModelCostCeiling | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const raw = value as Record<string, unknown>;
  rejectUnknown(raw, ["inputUsdPerMillionTokens", "outputUsdPerMillionTokens", "maxRequestUsd"], field);
  const finite = (candidate: unknown, name: string, minimum: number): number => {
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < minimum || candidate > 1_000_000) {
      throw new Error(`${field}.${name} must be a finite number from ${minimum} to 1000000`);
    }
    return candidate;
  };
  const inputUsdPerMillionTokens = finite(raw.inputUsdPerMillionTokens, "inputUsdPerMillionTokens", 0);
  const outputUsdPerMillionTokens = finite(raw.outputUsdPerMillionTokens, "outputUsdPerMillionTokens", 0);
  const maxRequestUsd = finite(raw.maxRequestUsd, "maxRequestUsd", 0.000001);
  if (inputUsdPerMillionTokens === 0 && outputUsdPerMillionTokens === 0) {
    throw new Error(`${field} requires a non-zero input or output price`);
  }
  return { inputUsdPerMillionTokens, outputUsdPerMillionTokens, maxRequestUsd };
}

const modelRoles: ModelRole[] = ["foreground", "deliberation", "background", "critic"];

function profileRoute(value: unknown, field: string): ModelRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const raw = value as Record<string, unknown>;
  rejectUnknown(raw, ["provider", "model", "maxOutputTokens", "reasoningEffort", "baseUrl", "apiKeyEnv", "costCeiling"], field);
  const parsedProvider = provider(raw.provider as string | undefined);
  if (parsedProvider === "auto" || raw.provider !== parsedProvider) throw new Error(`${field}.provider must be an explicit supported provider`);
  const model = optionalString(raw.model, `${field}.model`);
  if (!model) throw new Error(`${field}.model is required`);
  if (!Number.isInteger(raw.maxOutputTokens) || (raw.maxOutputTokens as number) < 128 || (raw.maxOutputTokens as number) > 1_000_000) {
    throw new Error(`${field}.maxOutputTokens must be an integer from 128 to 1000000`);
  }
  const reasoningEffort = effort(raw.reasoningEffort as string | undefined, "none");
  if (raw.reasoningEffort !== reasoningEffort) throw new Error(`${field}.reasoningEffort is invalid`);
  const baseUrl = optionalString(raw.baseUrl, `${field}.baseUrl`);
  const apiKeyEnv = optionalString(raw.apiKeyEnv, `${field}.apiKeyEnv`);
  if (apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error(`${field}.apiKeyEnv must be an environment variable name`);
  const costCeiling = modelCostCeiling(raw.costCeiling, `${field}.costCeiling`);
  return {
    provider: parsedProvider,
    model,
    maxOutputTokens: raw.maxOutputTokens as number,
    reasoningEffort,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(costCeiling ? { costCeiling } : {}),
  };
}

function profileModels(value: unknown): Partial<Record<ModelRole, ModelRoute>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Profile models must be an object");
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !modelRoles.includes(key as ModelRole));
  if (unknown.length) throw new Error(`Profile models contains unknown roles: ${unknown.join(", ")}`);
  return Object.fromEntries(modelRoles.filter((role) => raw[role] !== undefined).map((role) => [role, profileRoute(raw[role], `Profile models.${role}`)])) as Partial<Record<ModelRole, ModelRoute>>;
}

function profileExecution(value: unknown): ExecutionConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Profile execution must be an object");
  const raw = value as Record<string, unknown>;
  rejectUnknown(raw, ["backend", "allowedCommands", "timeoutMs", "maxOutputBytes", "workspaceMode", "dockerImage"], "Profile execution");
  const backend = raw.backend === "local" || raw.backend === "docker" || raw.backend === "none" ? raw.backend : undefined;
  if (!backend) throw new Error("Profile execution.backend must be none, local, or docker");
  const allowedCommands = optionalStrings(raw.allowedCommands, "Profile execution.allowedCommands") ?? [];
  if (allowedCommands.length > 128 || allowedCommands.some((item) => item.length > 512 || item.includes("\0"))) {
    throw new Error("Profile execution.allowedCommands exceeds its bounds");
  }
  const boundedInteger = (candidate: unknown, field: string, minimum: number, maximum: number): number => {
    if (!Number.isInteger(candidate) || (candidate as number) < minimum || (candidate as number) > maximum) {
      throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
    }
    return candidate as number;
  };
  const timeoutMs = boundedInteger(raw.timeoutMs, "Profile execution.timeoutMs", 1_000, 3_600_000);
  const maxOutputBytes = boundedInteger(raw.maxOutputBytes, "Profile execution.maxOutputBytes", 1_024, 20_000_000);
  if (raw.workspaceMode !== "read-only" && raw.workspaceMode !== "read-write") {
    throw new Error("Profile execution.workspaceMode must be read-only or read-write");
  }
  const dockerImage = optionalString(raw.dockerImage, "Profile execution.dockerImage");
  return { backend, allowedCommands, timeoutMs, maxOutputBytes, workspaceMode: raw.workspaceMode, ...(dockerImage ? { dockerImage } : {}) };
}

export function parseProfile(value: unknown): CoProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Profile must be a JSON object");
  const raw = value as Record<string, unknown>;
  rejectUnknown(raw, ["version", "id", "tenantId", "memberPeerIds", "distribution", "distributionConfig", "timezone", "location", "workspaceRoots", "skillRoots", "pluginRoots", "plugins", "models", "execution"], "Profile");
  if (raw.version !== 1) throw new Error("Profile version must be 1");
  const distribution = optionalString(raw.distribution, "Profile distribution");
  const distributionConfig = optionalString(raw.distributionConfig, "Profile distributionConfig");
  const timezone = optionalString(raw.timezone, "Profile timezone");
  const location = optionalString(raw.location, "Profile location");
  const workspaceRoots = optionalStrings(raw.workspaceRoots, "Profile workspaceRoots");
  const skillRoots = optionalStrings(raw.skillRoots, "Profile skillRoots");
  const pluginRoots = optionalStrings(raw.pluginRoots, "Profile pluginRoots");
  const plugins = optionalStrings(raw.plugins, "Profile plugins")?.map((plugin) => identifier(plugin, "Profile plugin id"));
  const models = profileModels(raw.models);
  const execution = profileExecution(raw.execution);
  const memberPeerIds = optionalStrings(raw.memberPeerIds, "Profile memberPeerIds")?.map(canonicalMemberPeerId);
  if (memberPeerIds && new Set(memberPeerIds).size !== memberPeerIds.length) throw new Error("Profile memberPeerIds contains duplicate canonical identities");
  return {
    version: 1,
    id: identifier(raw.id, "Profile id"),
    tenantId: identifier(raw.tenantId, "Profile tenantId"),
    ...(memberPeerIds ? { memberPeerIds } : {}),
    ...(distribution ? { distribution } : {}),
    ...(distributionConfig ? { distributionConfig } : {}),
    ...(timezone ? { timezone } : {}),
    ...(location ? { location } : {}),
    ...(workspaceRoots ? { workspaceRoots } : {}),
    ...(skillRoots ? { skillRoots } : {}),
    ...(pluginRoots ? { pluginRoots } : {}),
    ...(plugins ? { plugins } : {}),
    ...(models ? { models } : {}),
    ...(execution ? { execution } : {}),
  };
}

export interface ProfileCreationOptions {
  id: string;
  tenantId?: string;
  memberPeerIds?: string[];
  distribution?: string;
  distributionConfig?: string;
  timezone?: string;
  location?: string;
  workspaceRoots?: string[];
  skillRoots?: string[];
  pluginRoots?: string[];
  plugins?: string[];
  models?: Partial<Record<ModelRole, ModelRoute>>;
  execution?: ExecutionConfig;
  home?: string;
}

function canonicalPotentialPath(value: string): string {
  const candidate = resolve(value);
  if (existsSync(candidate)) return realpathSync(candidate);
  const parent = dirname(candidate);
  if (parent === candidate) return candidate;
  return resolve(canonicalPotentialPath(parent), basename(candidate));
}

export function previewProfile(options: ProfileCreationOptions): { path: string; profile: CoProfile } {
  const home = canonicalPotentialPath(options.home ?? defaultRuntimeHome());
  const profileDirectory = resolve(home, "profiles");
  const defaultWorkspace = resolve(profileDirectory, options.id, "workspace");
  const profile: CoProfile = parseProfile({
    version: 1,
    id: options.id,
    tenantId: options.tenantId ?? options.id,
    ...(options.memberPeerIds ? { memberPeerIds: options.memberPeerIds } : {}),
    distribution: canonicalDistribution(options.distribution),
    ...(options.distributionConfig ? { distributionConfig: resolve(options.distributionConfig) } : {}),
    timezone: options.timezone ?? "UTC",
    ...(options.location ? { location: options.location } : {}),
    workspaceRoots: options.workspaceRoots?.map(canonicalPotentialPath) ?? [canonicalPotentialPath(defaultWorkspace)],
    ...(options.skillRoots ? { skillRoots: options.skillRoots.map(canonicalPotentialPath) } : {}),
    ...(options.pluginRoots ? { pluginRoots: options.pluginRoots.map(canonicalPotentialPath) } : {}),
    ...(options.plugins ? { plugins: options.plugins } : {}),
    ...(options.models ? { models: options.models } : {}),
    ...(options.execution ? { execution: options.execution } : {}),
  });
  const path = resolve(profileDirectory, `${profile.id}.json`);
  return { path, profile };
}

export function createProfile(options: ProfileCreationOptions): { path: string; profile: CoProfile } {
  const { path, profile } = previewProfile(options);
  if (existsSync(path)) throw new Error(`Profile already exists: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  for (const workspace of profile.workspaceRoots ?? []) mkdirSync(workspace, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { path, profile };
}

function integer(name: string, fallback: number, minimum = 0): number {
  const raw = name.startsWith("CO_") ? coEnv(name as `CO_${string}`) : process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

function optionalDecimal(name: `CO_${string}`): number | undefined {
  const raw = coEnv(name);
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) throw new Error(`${name} must be a finite number from 0 to 1000000`);
  return value;
}

function environment(value: string | undefined): RuntimeEnvironment {
  if (value === "production" || value === "test") return value;
  return "development";
}

function provider(value: string | undefined): ProviderName {
  if (value === "openai" || value === "anthropic" || value === "openai-compatible" || value === "codex-cli" || value === "claude-code-cli" || value === "mock") return value;
  return "auto";
}

function mediaAnalyzer(value: string | undefined): MediaAnalyzerName {
  if (value === "gemini" || value === "none") return value;
  return "auto";
}

function foregroundMedia(value: string | undefined): "gemini" | "native" {
  if (value === undefined || value === "gemini") return "gemini";
  if (value === "native") return "native";
  throw new Error("CO_FOREGROUND_MEDIA must be gemini or native");
}

function emailProvider(value: string | undefined, configured: boolean): EmailProviderName {
  if (value === "resend") return "resend";
  if (value === "none") return "none";
  if (value) throw new Error("CO_EMAIL_PROVIDER must be resend or none");
  return configured ? "resend" : "none";
}

function executionBackend(value: string | undefined): ExecutionBackendName {
  if (value === "local" || value === "docker") return value;
  return "none";
}

function effort(value: string | undefined, fallback: ReasoningEffort): ReasoningEffort {
  if (value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") return value;
  return fallback;
}

export function defaultModel(p: ProviderName, role: ModelRole): string {
  if (p === "auto") {
    const inferred: ProviderName = !readSecret("OPENAI_API_KEY") && readSecret("ANTHROPIC_API_KEY") ? "anthropic" : "openai";
    return defaultModel(inferred, role);
  }
  if (p === "anthropic") {
    if (role === "deliberation" || role === "critic") return "claude-opus-5";
    if (role === "background") return "claude-haiku-4-5";
    return "claude-sonnet-5";
  }
  if (p === "codex-cli" || p === "claude-code-cli") return "default";
  if (p === "mock") return "mock-1";
  if (role === "deliberation" || role === "critic") return "gpt-5.6-sol";
  if (role === "background") return "gpt-5.6-luna";
  return "gpt-5.6-terra";
}

function route(role: ModelRole, commonProvider: ProviderName): ModelRoute {
  const upper = role.toUpperCase();
  const roleProvider = provider(coEnv(`CO_${upper}_PROVIDER`) ?? commonProvider);
  const maxOutput = role === "background" ? 1600 : role === "foreground" ? 2400 : 4000;
  const defaultEffort: ReasoningEffort = role === "deliberation" || role === "critic" ? "high" : role === "background" ? "low" : "medium";
  const baseUrl = coEnv(`CO_${upper}_BASE_URL`) ?? coEnv("CO_BASE_URL");
  const apiKeyEnv = coEnv(`CO_${upper}_API_KEY_ENV`) ?? coEnv("CO_API_KEY_ENV");
  const inputPrice = optionalDecimal(`CO_${upper}_INPUT_USD_PER_MILLION_TOKENS`);
  const outputPrice = optionalDecimal(`CO_${upper}_OUTPUT_USD_PER_MILLION_TOKENS`);
  const maxRequestUsd = optionalDecimal(`CO_${upper}_MAX_REQUEST_USD`);
  const costParts = [inputPrice, outputPrice, maxRequestUsd].filter((value) => value !== undefined).length;
  if (costParts !== 0 && costParts !== 3) {
    throw new Error(`CO_${upper}_INPUT_USD_PER_MILLION_TOKENS, CO_${upper}_OUTPUT_USD_PER_MILLION_TOKENS, and CO_${upper}_MAX_REQUEST_USD must be configured together`);
  }
  const costCeiling = costParts === 3 ? modelCostCeiling({
    inputUsdPerMillionTokens: inputPrice,
    outputUsdPerMillionTokens: outputPrice,
    maxRequestUsd,
  }, `CO_${upper} cost ceiling`) : undefined;
  return {
    provider: roleProvider,
    model: coEnv(`CO_${upper}_MODEL`) ?? (role === "foreground" ? coEnv("CO_MODEL") : undefined) ?? defaultModel(roleProvider, role),
    maxOutputTokens: integer(`CO_${upper}_MAX_OUTPUT_TOKENS`, maxOutput, 128),
    reasoningEffort: effort(coEnv(`CO_${upper}_REASONING`), defaultEffort),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(costCeiling ? { costCeiling } : {}),
  };
}

function autoApproveRisks(): ToolRisk[] {
  const raw = coEnv("CO_AUTO_APPROVE") ?? "read,local-write";
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is ToolRisk => item === "read" || item === "local-write" || item === "external-write" || item === "destructive");
}

function isRisk(value: unknown): value is ToolRisk {
  return value === "read" || value === "local-write" || value === "external-write" || value === "destructive";
}

function expandEnvironment(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = readSecret(name);
    if (resolved === undefined) throw new Error(`MCP configuration references missing environment variable ${name}`);
    return resolved;
  });
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (typeof item !== "string") throw new Error(`MCP value ${key} must be a string`);
    return [key, expandEnvironment(item)];
  }));
}

export function parseMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) throw new Error("MCP configuration must be a JSON array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`MCP server ${index} must be an object`);
    const raw = item as Record<string, unknown>;
    rejectUnknown(raw, ["name", "transport", "command", "args", "cwd", "env", "url", "headers", "allowedTools", "defaultRisk", "toolRisks", "timeoutMs"], `MCP server ${index}`);
    if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error(`MCP server ${index} needs a name`);
    if (raw.transport !== "stdio" && raw.transport !== "http") throw new Error(`MCP server ${raw.name} transport must be stdio or http`);
    if (raw.transport === "stdio" && (typeof raw.command !== "string" || !raw.command.trim())) throw new Error(`MCP stdio server ${raw.name} needs command`);
    if (raw.transport === "http" && (typeof raw.url !== "string" || !raw.url.trim())) throw new Error(`MCP HTTP server ${raw.name} needs url`);
    const riskEntries = raw.toolRisks && typeof raw.toolRisks === "object" && !Array.isArray(raw.toolRisks)
      ? Object.entries(raw.toolRisks).map(([name, risk]) => {
        if (!isRisk(risk)) throw new Error(`Invalid MCP risk for ${raw.name}.${name}`);
        return [name, risk] as const;
      })
      : [];
    if (raw.defaultRisk !== undefined && !isRisk(raw.defaultRisk)) throw new Error(`Invalid default MCP risk for ${raw.name}`);
    const strings = (input: unknown, field: string): string[] | undefined => {
      if (input === undefined) return undefined;
      if (!Array.isArray(input) || input.some((entry) => typeof entry !== "string")) throw new Error(`MCP ${raw.name} ${field} must be a string array`);
      return input.map((entry) => expandEnvironment(entry as string));
    };
    const args = strings(raw.args, "args");
    const allowedTools = strings(raw.allowedTools, "allowedTools");
    const env = stringRecord(raw.env);
    const headers = stringRecord(raw.headers);
    return {
      name: raw.name.trim(), transport: raw.transport,
      ...(typeof raw.command === "string" ? { command: expandEnvironment(raw.command) } : {}),
      ...(args ? { args } : {}),
      ...(typeof raw.cwd === "string" ? { cwd: resolve(expandEnvironment(raw.cwd)) } : {}),
      ...(env ? { env } : {}),
      ...(typeof raw.url === "string" ? { url: expandEnvironment(raw.url) } : {}),
      ...(headers ? { headers } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(isRisk(raw.defaultRisk) ? { defaultRisk: raw.defaultRisk } : {}),
      ...(riskEntries.length ? { toolRisks: Object.fromEntries(riskEntries) } : {}),
      ...(typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) ? { timeoutMs: Math.max(1_000, Math.floor(raw.timeoutMs)) } : {}),
    };
  });
}

function mcpServers(): McpServerConfig[] {
  const inline = coEnv("CO_MCP_SERVERS");
  const path = coEnv("CO_MCP_CONFIG");
  if (inline && path) throw new Error("Set only one of CO_MCP_SERVERS or CO_MCP_CONFIG");
  if (!inline && !path) return [];
  const raw = inline ?? readFileSync(resolve(path as string), "utf8");
  return parseMcpServers(JSON.parse(raw) as unknown);
}

export function defaultSkillRoots(runtimeHome: string, distribution: string, cwd = process.cwd()): string[] {
  const bundledSkills = resolve(fileURLToPath(new URL("../skills", import.meta.url)));
  return [
    resolve(runtimeHome, "skills", distribution),
    resolve(runtimeHome, "skills", "common"),
    resolve(cwd, "skills", distribution),
    resolve(cwd, "skills", "common"),
    resolve(bundledSkills, distribution),
    resolve(bundledSkills, "common"),
  ];
}

export function defaultPluginRoots(runtimeHome: string, cwd = process.cwd()): string[] {
  const bundledPlugins = resolve(fileURLToPath(new URL("../plugins", import.meta.url)));
  return [...new Set([resolve(runtimeHome, "plugins"), resolve(cwd, "plugins"), bundledPlugins])];
}

export function loadConfig(overrides: ConfigOverrides = {}): RuntimeConfig {
  const runtimeHome = defaultRuntimeHome();
  const profilePath = overrides.profilePath ?? coEnv("CO_PROFILE");
  const resolvedProfilePath = profilePath ? resolve(profilePath) : undefined;
  const profile = resolvedProfilePath ? parseProfile(JSON.parse(readFileSync(resolvedProfilePath, "utf8")) as unknown) : undefined;
  const profileBase = resolvedProfilePath ? dirname(resolvedProfilePath) : process.cwd();
  const tenantId = overrides.tenantId ?? profile?.tenantId ?? coEnv("CO_TENANT") ?? "default";
  const environmentMemberPeers = (coEnv("CO_MEMBER_PEERS") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const memberPeerIds = [...new Set((profile ? profile.memberPeerIds ?? [] : environmentMemberPeers).map(canonicalMemberPeerId))];
  const distribution = canonicalDistribution(profile?.distribution ?? coEnv("CO_DISTRIBUTION"));
  const commonProvider = provider(coEnv("CO_PROVIDER"));
  const workspaceSource = profile
    ? profile.workspaceRoots ?? [resolve(runtimeHome, "profiles", profile.id, "workspace")]
    : coEnv("CO_WORKSPACE_ROOTS")?.split(":") ?? [process.cwd()];
  const workspaceRoots = workspaceSource
    .map((item) => resolve(profile?.workspaceRoots ? profileBase : process.cwd(), item))
    .filter(Boolean);
  const location = profile ? profile.location : coEnv("CO_LOCATION");
  const pluginRoots = profile
    ? profile.pluginRoots?.map((item) => resolve(profileBase, item)) ?? defaultPluginRoots(runtimeHome)
    : coEnv("CO_PLUGIN_ROOTS")
      ? (coEnv("CO_PLUGIN_ROOTS") as string).split(":").map((item) => resolve(item)).filter(Boolean)
      : defaultPluginRoots(runtimeHome);
  const enabledPlugins = profile
    ? profile.plugins ?? []
    : (coEnv("CO_PLUGINS") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const pluginRegistry = new PluginRegistry(pluginRoots);
  const pluginActivation = pluginRegistry.activate(enabledPlugins);
  const profileSkillRoots = profile?.skillRoots?.map((item) => resolve(profileBase, item)) ?? [];
  const learnedSkillRoot = profile
    ? resolve(runtimeHome, "profiles", profile.id, "learned-skills")
    : resolve(runtimeHome, "tenants", tenantId, "learned-skills");
  const skillRoots = profile
    ? [learnedSkillRoot, ...profileSkillRoots, ...pluginActivation.skillRoots, ...defaultSkillRoots(runtimeHome, distribution)]
    : coEnv("CO_SKILL_ROOTS")
      ? [learnedSkillRoot, ...(coEnv("CO_SKILL_ROOTS") as string).split(":").map((item) => resolve(item)).filter(Boolean)]
      : [learnedSkillRoot, ...pluginActivation.skillRoots, ...defaultSkillRoots(runtimeHome, distribution)];
  const distributionConfig = profile ? profile.distributionConfig : coEnv("CO_DISTRIBUTION_CONFIG");
  const distributionConfigPath = distributionConfig ? resolve(profile?.distributionConfig ? profileBase : process.cwd(), distributionConfig) : undefined;
  const serverToken = serverCredential();
  const sendblueApiKeyId = readSecret("SENDBLUE_API_KEY_ID") ?? readSecret("SENDBLUE_API_KEY");
  const sendblueApiSecretKey = readSecret("SENDBLUE_API_SECRET_KEY") ?? readSecret("SENDBLUE_SECRET_KEY");
  const sendblueWebhookSecret = readSecret("SENDBLUE_WEBHOOK_SECRET");
  const linqApiKey = readSecret("LINQ_API_KEY");
  const linqWebhookSecret = readSecret("LINQ_WEBHOOK_SECRET");
  const emailApiKey = readSecret("RESEND_API_KEY");
  const emailFrom = coEnv("CO_EMAIL_FROM");
  const emailOtpSecret = coSecret("CO_EMAIL_OTP_SECRET");
  const environmentExecution: ExecutionConfig = {
    backend: executionBackend(coEnv("CO_EXECUTION_BACKEND")),
    allowedCommands: (coEnv("CO_EXECUTION_ALLOWED_COMMANDS") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    timeoutMs: integer("CO_EXECUTION_TIMEOUT_MS", 120_000, 1_000),
    maxOutputBytes: integer("CO_EXECUTION_MAX_OUTPUT_BYTES", 1_000_000, 1_024),
    workspaceMode: coEnv("CO_EXECUTION_WORKSPACE_MODE") === "read-write" ? "read-write" : "read-only",
    ...(coEnv("CO_EXECUTION_DOCKER_IMAGE") ? { dockerImage: coEnv("CO_EXECUTION_DOCKER_IMAGE") as string } : {}),
  };
  const runtimeMode = coEnv("CO_RUNTIME_MODE") ?? "live";
  if (runtimeMode !== "live" && runtimeMode !== "shadow") throw new Error("CO_RUNTIME_MODE must be live or shadow");
  const embeddingModel = coEnv("CO_EMBEDDING_MODEL");
  return {
    environment: environment(coEnv("CO_ENV") ?? process.env.NODE_ENV),
    mode: runtimeMode,
    ...(embeddingModel ? { embeddings: {
      model: embeddingModel, apiKeyEnv: coEnv("CO_EMBEDDING_API_KEY_ENV") ?? "VOYAGE_API_KEY",
      dimensions: integer("CO_EMBEDDING_DIMENSIONS", 1024, 1), maxCallsPerDay: integer("CO_EMBEDDING_MAX_CALLS_PER_DAY", 500, 1),
    } } : {}),
    home: runtimeHome,
    dbPath: overrides.dbPath ?? resolve(coEnv("CO_DB") ?? `${runtimeHome}/runtime.sqlite`),
    tenantId,
    memberPeerIds,
    ...(profile ? { profileId: profile.id } : {}),
    distribution,
    ...(distributionConfigPath ? { distributionConfigPath } : {}),
    timezone: profile?.timezone ?? process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    ...(location ? { location } : {}),
    models: Object.fromEntries(modelRoles.map((role) => [role, profile?.models?.[role] ?? route(role, commonProvider)])) as Record<ModelRole, ModelRoute>,
    autonomy: {
      maxIterations: integer("CO_MAX_ITERATIONS", 12, 1),
      maxChildDepth: integer("CO_MAX_CHILD_DEPTH", 2, 0),
      maxConcurrentChildren: integer("CO_MAX_CONCURRENT_CHILDREN", 3, 1),
      maxChildrenPerRun: integer("CO_MAX_CHILDREN_PER_RUN", 12, 1),
      maxQueuedChildren: integer("CO_MAX_QUEUED_CHILDREN", 24, 1),
      maxDailyInterventions: integer("CO_MAX_DAILY_INTERVENTIONS", 3, 0),
      interventionCooldownMinutes: integer("CO_INTERVENTION_COOLDOWN_MINUTES", 180, 0),
      quietHoursStart: integer("CO_QUIET_HOURS_START", 22, 0) % 24,
      quietHoursEnd: integer("CO_QUIET_HOURS_END", 8, 0) % 24,
      autoApproveRisks: autoApproveRisks(),
    },
    workspaceRoots,
    skillRoots,
    learnedSkillRoot,
    plugins: { roots: pluginRoots, enabled: enabledPlugins },
    execution: profile ? profile.execution ?? { backend: "none", allowedCommands: [], timeoutMs: 120_000, maxOutputBytes: 1_000_000, workspaceMode: "read-only" } : environmentExecution,
    mcpServers: [...mcpServers(), ...parseMcpServers(pluginActivation.mcpServers)],
    sensors: pluginActivation.sensors,
    media: {
      analyzer: mediaAnalyzer(coEnv("CO_MEDIA_ANALYZER")),
      foreground: foregroundMedia(coEnv("CO_FOREGROUND_MEDIA")),
      geminiApiKeyEnv: coEnv("CO_GEMINI_API_KEY_ENV") ?? "GEMINI_API_KEY",
      geminiModel: coEnv("CO_GEMINI_MODEL") ?? "gemini-3.5-flash-lite",
      youtubeDeferSeconds: integer("CO_YOUTUBE_DEFER_SECONDS", 720, 0),
      youtubeMaxWindows: integer("CO_YOUTUBE_MAX_WINDOWS", 8, 1),
      maxResourceBytes: integer("CO_MEDIA_MAX_RESOURCE_BYTES", 15_000_000, 1_024),
    },
    browser: {
      workspaceId: coEnv("CO_BROWSER_WORKSPACE_ID") ?? profile?.id ?? tenantId,
      credentialKeyEnv: coEnv("CO_BROWSER_CREDENTIAL_KEY_ENV") ?? "CO_BROWSER_CREDENTIAL_KEY",
      ...(coEnv("CO_BROWSER_CDP_URL") ? { cdpBaseUrl: coEnv("CO_BROWSER_CDP_URL") as string } : {}),
    },
    ...(serverToken ? { serverToken } : {}),
    http: {
      bodyLimitBytes: integer("CO_HTTP_BODY_LIMIT_BYTES", 2_000_000, 1_024),
      requestTimeoutMs: integer("CO_HTTP_REQUEST_TIMEOUT_MS", 300_000, 1_000),
      headersTimeoutMs: integer("CO_HTTP_HEADERS_TIMEOUT_MS", 15_000, 1_000),
      keepAliveTimeoutMs: integer("CO_HTTP_KEEP_ALIVE_TIMEOUT_MS", 5_000, 1_000),
      shutdownGraceMs: integer("CO_SHUTDOWN_GRACE_MS", 30_000, 1_000),
      rateLimitWindowMs: integer("CO_RATE_LIMIT_WINDOW_MS", 60_000, 1_000),
      rateLimitMaxRequests: integer("CO_RATE_LIMIT_MAX_REQUESTS", 120, 1),
      maxConnections: integer("CO_HTTP_MAX_CONNECTIONS", 1_000, 1),
    },
    sendblue: {
      ...(sendblueApiKeyId ? { apiKeyId: sendblueApiKeyId } : {}),
      ...(sendblueApiSecretKey ? { apiSecretKey: sendblueApiSecretKey } : {}),
      ...(process.env.SENDBLUE_FROM_NUMBER ? { fromNumber: process.env.SENDBLUE_FROM_NUMBER } : {}),
      ...(sendblueWebhookSecret ? { webhookSecret: sendblueWebhookSecret } : {}),
      baseUrl: process.env.SENDBLUE_BASE_URL ?? "https://api.sendblue.co",
    },
    linq: {
      ...(linqApiKey ? { apiKey: linqApiKey } : {}),
      ...(process.env.LINQ_FROM_NUMBER ? { fromNumber: process.env.LINQ_FROM_NUMBER } : {}),
      ...(linqWebhookSecret ? { webhookSecret: linqWebhookSecret } : {}),
      baseUrl: process.env.LINQ_BASE_URL ?? "https://api.linqapp.com/api/partner/v3",
    },
    // The loopback bridge to the Python router's Google integration (9/6). Absent by default:
    // with no URL or token the tools are never registered, so the model cannot promise a
    // calendar read it has no way to perform.
    googleBridge: {
      baseUrl: coEnv("CO_GOOGLE_BRIDGE_URL") ?? "",
      token: coEnv("CO_GOOGLE_BRIDGE_TOKEN") ?? "",
    },
    email: {
      provider: emailProvider(coEnv("CO_EMAIL_PROVIDER"), Boolean(emailApiKey || emailFrom)),
      ...(emailApiKey ? { apiKey: emailApiKey } : {}),
      ...(emailFrom ? { from: emailFrom } : {}),
      baseUrl: coEnv("CO_EMAIL_BASE_URL") ?? "https://api.resend.com",
      ...(emailOtpSecret ? { otpSecret: emailOtpSecret } : {}),
      verificationTtlMinutes: Math.min(30, integer("CO_EMAIL_VERIFICATION_TTL_MINUTES", 10, 2)),
      resendCooldownSeconds: Math.min(3_600, integer("CO_EMAIL_RESEND_COOLDOWN_SECONDS", 60, 10)),
      maxVerificationAttempts: Math.min(20, integer("CO_EMAIL_MAX_VERIFICATION_ATTEMPTS", 5, 1)),
      maxRequestsPerHour: Math.min(100, integer("CO_EMAIL_MAX_REQUESTS_PER_HOUR", 5, 1)),
      maxRequestsPerDay: Math.min(1_000, integer("CO_EMAIL_MAX_REQUESTS_PER_DAY", 10, 1)),
    },
  };
}
