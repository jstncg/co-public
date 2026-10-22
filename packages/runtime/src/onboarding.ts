import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, parse as parsePath, resolve } from "node:path";
import { createProfile, defaultModel, defaultPluginRoots, loadConfig, parseProfile, previewProfile, type CoProfile, type ProfileCreationOptions } from "./config.ts";
import { getDistribution } from "./distributions.ts";
import { stableId } from "./id.ts";
import { PluginRegistry, type PluginDiagnostic } from "./plugins.ts";
import { validateProductionConfig, type ConfigurationIssue } from "./production.ts";
import { readSecret } from "./secrets.ts";
import type { ExecutionConfig, ModelRole, ModelRoute, ProviderName, ReasoningEffort } from "./types.ts";

const roles: ModelRole[] = ["foreground", "deliberation", "background", "critic"];
type ExplicitProvider = Exclude<ProviderName, "auto">;

export interface OnboardingRequest {
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
  provider?: ExplicitProvider;
  model?: string;
  execution?: ExecutionConfig;
  home?: string;
}

export interface OnboardingCheck {
  code: string;
  status: "pass" | "warning" | "blocked";
  message: string;
}

export interface OnboardingPlan {
  schemaVersion: 1;
  planId: string;
  resolutionDigest: string;
  generatedAt: string;
  profilePath: string;
  profile: CoProfile;
  changes: string[];
  checks: OnboardingCheck[];
}

export interface OnboardingVerification {
  ok: boolean;
  profilePath: string;
  profileId: string;
  tenantId: string;
  memberPeerIds: string[];
  distribution: string;
  plugins: Array<Record<string, unknown>>;
  pluginDiagnostics: PluginDiagnostic[];
  routes: Array<Record<string, unknown>>;
  execution: ExecutionConfig;
  productionIssues: ConfigurationIssue[];
  checks: OnboardingCheck[];
}

function routeDefaults(provider: ExplicitProvider, role: ModelRole, requestedModel?: string): ModelRoute {
  const maxOutputTokens = role === "background" ? 1_600 : role === "foreground" ? 2_400 : 4_000;
  const reasoningEffort: ReasoningEffort = role === "background" ? "low" : role === "foreground" ? "medium" : "high";
  return { provider, model: requestedModel ?? defaultModel(provider, role), maxOutputTokens, reasoningEffort };
}

function creationOptions(request: OnboardingRequest): ProfileCreationOptions {
  const models = request.provider
    ? Object.fromEntries(roles.map((role) => [role, routeDefaults(request.provider as ExplicitProvider, role, request.model)])) as Record<ModelRole, ModelRoute>
    : undefined;
  return {
    id: request.id,
    ...(request.tenantId ? { tenantId: request.tenantId } : {}),
    ...(request.memberPeerIds ? { memberPeerIds: request.memberPeerIds } : {}),
    distribution: request.distribution ?? "co",
    ...(request.distributionConfig ? { distributionConfig: request.distributionConfig } : {}),
    timezone: request.timezone ?? "UTC",
    ...(request.location ? { location: request.location } : {}),
    ...(request.workspaceRoots ? { workspaceRoots: request.workspaceRoots } : {}),
    ...(request.skillRoots ? { skillRoots: request.skillRoots } : {}),
    ...(request.pluginRoots ? { pluginRoots: request.pluginRoots } : {}),
    ...(request.plugins ? { plugins: request.plugins } : {}),
    ...(models ? { models } : {}),
    ...(request.execution ? { execution: request.execution } : {}),
    ...(request.home ? { home: request.home } : {}),
  };
}

function planIdentity(profilePath: string, profile: CoProfile, resolutionDigest: string): string {
  return stableId("onboard", JSON.stringify({ schemaVersion: 1, profilePath, profile, resolutionDigest }));
}

function capabilityIdentity(distribution: ReturnType<typeof getDistribution>, activation: ReturnType<PluginRegistry["activate"]>): string {
  return stableId("resolution", JSON.stringify({
    distribution,
    plugins: activation.plugins.map((plugin) => ({ root: plugin.root, manifest: plugin.manifest })),
  }));
}

function scopeChecks(profile: CoProfile, pluginRoots: string[]): OnboardingCheck[] {
  const check = (root: string, code: string, label: string): OnboardingCheck => {
    const parsed = parsePath(root);
    if (!isAbsolute(root) || root === parsed.root) return { code: `${code}.scope`, status: "blocked", message: `${label} must be an absolute, bounded directory: ${root}` };
    if (existsSync(root) && !statSync(root).isDirectory()) return { code: `${code}.type`, status: "blocked", message: `${label} path exists and is not a directory: ${root}` };
    if (existsSync(root)) {
      const canonical = realpathSync(root);
      if (canonical === parsePath(canonical).root) return { code: `${code}.scope`, status: "blocked", message: `${label} resolves to an unbounded filesystem root: ${root}` };
    }
    return { code: `${code}.bounded`, status: "pass", message: `${label} is bounded: ${root}` };
  };
  const workspaceChecks: OnboardingCheck[] = (profile.workspaceRoots ?? []).map((root, index) => {
    return check(root, `workspace.${index}`, "Workspace");
  });
  const skillRootChecks = (profile.skillRoots ?? []).map((root, index) => check(root, `skill-root.${index}`, "Skill root"));
  const pluginRootChecks = pluginRoots.map((root, index) => check(root, `plugin-root.${index}`, "Plugin root"));
  return [...workspaceChecks, ...skillRootChecks, ...pluginRootChecks];
}

function credentialName(route: ModelRoute): string | undefined {
  if (route.apiKeyEnv) return route.apiKeyEnv;
  if (route.provider === "openai" || route.provider === "openai-compatible") return "OPENAI_API_KEY";
  if (route.provider === "anthropic") return "ANTHROPIC_API_KEY";
  return undefined;
}

export function planOnboarding(request: OnboardingRequest): OnboardingPlan {
  const preview = previewProfile(creationOptions(request));
  const distribution = getDistribution(preview.profile.distribution ?? "co", preview.profile.distributionConfig);
  const profileHome = resolve(preview.path, "..", "..");
  const roots = preview.profile.pluginRoots ?? defaultPluginRoots(profileHome);
  const plugins = preview.profile.plugins ?? [];
  const earlyScopeChecks = scopeChecks(preview.profile, roots);
  const unsafePluginRoot = earlyScopeChecks.find((check) => check.status === "blocked" && check.code.startsWith("plugin-root."));
  if (unsafePluginRoot) throw new Error(`${unsafePluginRoot.code}: ${unsafePluginRoot.message}`);
  const registry = new PluginRegistry(roots);
  const activation = registry.activate(plugins);
  const resolutionDigest = capabilityIdentity(distribution, activation);
  const checks: OnboardingCheck[] = [
    existsSync(preview.path)
      ? { code: "profile.collision", status: "blocked", message: `Profile already exists: ${preview.path}` }
      : { code: "profile.available", status: "pass", message: "Profile path is available and apply will use exclusive creation." },
    { code: "identity.neutral", status: "pass", message: "The profile contains operational scope only; no inferred traits or credentials are stored." },
    plugins.length
      ? { code: "plugins.selected", status: "pass", message: `${plugins.length} explicitly selected plugin(s) resolved without activation-time code execution.` }
      : { code: "plugins.none", status: "pass", message: "No plugins selected; the neutral kernel remains available." },
    preview.profile.execution?.backend && preview.profile.execution.backend !== "none"
      ? { code: "execution.selected", status: "warning", message: `${preview.profile.execution.backend} execution is selected with ${preview.profile.execution.allowedCommands.length} allowlisted command(s); every process call still requires action-policy approval.` }
      : { code: "execution.disabled", status: "pass", message: "Process execution is disabled." },
    ...earlyScopeChecks,
    ...registry.diagnostics.map((diagnostic) => ({ code: diagnostic.code, status: "warning" as const, message: diagnostic.message })),
  ];
  if (!preview.profile.models) checks.push({ code: "provider.deployment", status: "warning", message: "No portable model route selected; deployment environment configuration will choose providers." });
  else {
    for (const role of roles) {
      const route = preview.profile.models[role];
      if (!route) continue;
      const secret = credentialName(route);
      checks.push(secret && !readSecret(secret)
        ? { code: `provider.${role}.credential`, status: "warning", message: `${role} selects ${route.provider}; supply ${secret} or ${secret}_FILE at deployment without putting it in the profile.` }
        : { code: `provider.${role}.configured`, status: "pass", message: `${role} route is explicit${secret ? " and its credential is currently available" : ""}.` });
    }
  }
  const profilePath = preview.path;
  return {
    schemaVersion: 1,
    planId: planIdentity(profilePath, preview.profile, resolutionDigest),
    resolutionDigest,
    generatedAt: new Date().toISOString(),
    profilePath,
    profile: preview.profile,
    changes: [
      `Create profile ${profilePath} with mode 0600`,
      ...(preview.profile.workspaceRoots ?? []).map((root) => `Ensure isolated workspace directory ${root} with mode 0700`),
      "Do not write credentials, memories, or inferred personal traits",
    ],
    checks,
  };
}

export function parseOnboardingPlan(value: unknown): OnboardingPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Onboarding plan must be an object");
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !["schemaVersion", "planId", "resolutionDigest", "generatedAt", "profilePath", "profile", "changes", "checks"].includes(key));
  if (unknown.length) throw new Error(`Onboarding plan contains unknown fields: ${unknown.join(", ")}`);
  if (raw.schemaVersion !== 1 || typeof raw.profilePath !== "string" || typeof raw.planId !== "string" || typeof raw.resolutionDigest !== "string" || typeof raw.generatedAt !== "string") {
    throw new Error("Onboarding plan header is invalid");
  }
  const profile = parseProfile(raw.profile);
  const profilePath = resolve(raw.profilePath);
  if (raw.planId !== planIdentity(profilePath, profile, raw.resolutionDigest)) throw new Error("Onboarding plan identity does not match its contents");
  const changes = Array.isArray(raw.changes) && raw.changes.every((item) => typeof item === "string") ? raw.changes as string[] : [];
  const checks = Array.isArray(raw.checks) ? raw.checks.filter((item): item is OnboardingCheck => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const check = item as Record<string, unknown>;
    return typeof check.code === "string" && typeof check.message === "string" && (check.status === "pass" || check.status === "warning" || check.status === "blocked");
  }) : [];
  return { schemaVersion: 1, planId: raw.planId, resolutionDigest: raw.resolutionDigest, generatedAt: raw.generatedAt, profilePath, profile, changes, checks };
}

export function writeOnboardingPlan(plan: OnboardingPlan, path: string): string {
  const destination = resolve(path);
  writeFileSync(destination, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return destination;
}

export function readOnboardingPlan(path: string): OnboardingPlan {
  return parseOnboardingPlan(JSON.parse(readFileSync(resolve(path), "utf8")) as unknown);
}

export function applyOnboardingPlan(plan: OnboardingPlan): { path: string; profile: CoProfile; planId: string } {
  const checked = parseOnboardingPlan(plan);
  const blocked = checked.checks.filter((check) => check.status === "blocked");
  if (blocked.length) throw new Error(blocked.map((check) => `${check.code}: ${check.message}`).join("; "));
  const profileHome = resolve(checked.profilePath, "..", "..");
  const pluginRoots = checked.profile.pluginRoots ?? defaultPluginRoots(profileHome);
  const currentScopeBlocks = scopeChecks(checked.profile, pluginRoots).filter((check) => check.status === "blocked");
  if (currentScopeBlocks.length) throw new Error(currentScopeBlocks.map((check) => `${check.code}: ${check.message}`).join("; "));
  const distribution = getDistribution(checked.profile.distribution ?? "co", checked.profile.distributionConfig);
  const activation = new PluginRegistry(pluginRoots).activate(checked.profile.plugins ?? []);
  if (capabilityIdentity(distribution, activation) !== checked.resolutionDigest) throw new Error("Onboarding capabilities changed after review; create a new plan before applying");
  const created = createProfile({
    id: checked.profile.id,
    tenantId: checked.profile.tenantId,
    ...(checked.profile.memberPeerIds ? { memberPeerIds: checked.profile.memberPeerIds } : {}),
    distribution: checked.profile.distribution ?? "co",
    ...(checked.profile.distributionConfig ? { distributionConfig: checked.profile.distributionConfig } : {}),
    timezone: checked.profile.timezone ?? "UTC",
    ...(checked.profile.location ? { location: checked.profile.location } : {}),
    ...(checked.profile.workspaceRoots ? { workspaceRoots: checked.profile.workspaceRoots } : {}),
    ...(checked.profile.skillRoots ? { skillRoots: checked.profile.skillRoots } : {}),
    ...(checked.profile.pluginRoots ? { pluginRoots: checked.profile.pluginRoots } : {}),
    ...(checked.profile.plugins ? { plugins: checked.profile.plugins } : {}),
    ...(checked.profile.models ? { models: checked.profile.models } : {}),
    ...(checked.profile.execution ? { execution: checked.profile.execution } : {}),
    home: profileHome,
  });
  if (created.path !== checked.profilePath) throw new Error("Onboarding apply resolved a different profile path than the reviewed plan");
  return { ...created, planId: checked.planId };
}

export function verifyOnboarding(profilePath: string): OnboardingVerification {
  const resolved = resolve(profilePath);
  const config = loadConfig({ profilePath: resolved });
  getDistribution(config.distribution, config.distributionConfigPath);
  const registry = new PluginRegistry(config.plugins.roots);
  const activation = registry.activate(config.plugins.enabled);
  const routes = roles.map((role) => {
    const route = config.models[role];
    const secret = credentialName(route);
    return {
      role,
      provider: route.provider,
      model: route.model,
      maxOutputTokens: route.maxOutputTokens,
      reasoningEffort: route.reasoningEffort,
      costCeiling: route.costCeiling ?? null,
      credentialRequired: secret ?? null,
      credentialAvailable: secret ? Boolean(readSecret(secret)) : route.provider !== "auto",
    };
  });
  const checks: OnboardingCheck[] = [
    { code: "profile.loaded", status: "pass", message: `Profile ${config.profileId ?? "unknown"} loaded with tenant scope ${config.tenantId}.` },
    { code: "distribution.loaded", status: "pass", message: `Distribution ${config.distribution} resolved explicitly.` },
    { code: "workspace.bounded", status: config.workspaceRoots.length ? "pass" : "blocked", message: `${config.workspaceRoots.length} workspace root(s) selected.` },
    ...routes.filter((route) => route.credentialRequired && !route.credentialAvailable).map((route) => ({
      code: `provider.${route.role}.credential`, status: "warning" as const, message: `${route.role} is missing ${route.credentialRequired} or ${route.credentialRequired}_FILE.`,
    })),
    config.email.provider === "none"
      ? { code: "email.disabled", status: "warning" as const, message: "Email verification is disabled; configure a transactional email provider to collect verified contact addresses." }
      : config.email.apiKey && config.email.from && config.email.otpSecret
        ? { code: "email.configured", status: "pass" as const, message: `${config.email.provider} email verification is configured without storing its credentials in the profile.` }
        : { code: "email.incomplete", status: "warning" as const, message: "Email verification is selected but its provider, sender, or OTP secret is missing." },
  ];
  const productionIssues = config.environment === "production" ? validateProductionConfig(config) : [];
  return {
    ok: !checks.some((check) => check.status === "blocked") && productionIssues.length === 0,
    profilePath: resolved,
    profileId: config.profileId as string,
    tenantId: config.tenantId,
    memberPeerIds: config.memberPeerIds,
    distribution: config.distribution,
    plugins: registry.status(config.plugins.enabled),
    pluginDiagnostics: activation.diagnostics,
    routes,
    execution: config.execution,
    productionIssues,
    checks,
  };
}
