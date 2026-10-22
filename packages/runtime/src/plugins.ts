import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, parse as parsePath, relative, resolve } from "node:path";
import type { SensorConfig, SensorKind } from "./types.ts";

const MAX_MANIFEST_BYTES = 256 * 1024;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;

export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  displayName: string;
  description?: string;
  contributes: {
    skillRoots: string[];
    mcpServers: Record<string, unknown>[];
    sensors: PluginSensorManifest[];
  };
}

export interface PluginSensorManifest {
  id: string;
  displayName: string;
  kind: SensorKind;
  purpose: string;
  dataClasses: string[];
  retentionDays: number;
  server: string;
  tool: string;
}

export interface PluginDiagnostic {
  level: "warning" | "error";
  code: string;
  message: string;
  path?: string;
  pluginId?: string;
}

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  root: string;
  manifestPath: string;
}

export interface PluginActivation {
  plugins: DiscoveredPlugin[];
  skillRoots: string[];
  mcpServers: Record<string, unknown>[];
  sensors: SensorConfig[];
  diagnostics: PluginDiagnostic[];
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknown(raw: Record<string, unknown>, allowed: string[], field: string): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${field} contains unknown fields: ${unknown.join(", ")}`);
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${field} must be a portable identifier`);
  return value;
}

function text(value: unknown, field: string, maximum: number, required = false): string | undefined {
  if (value === undefined) {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  const result = value.trim();
  if (result.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return result;
}

function strings(value: unknown, field: string, maximum = 32): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${field} must be an array of at most ${maximum} non-empty strings`);
  }
  return value.map((entry) => (entry as string).trim());
}

function sensorKind(value: unknown, field: string): SensorKind {
  if (value === "calendar" || value === "email" || value === "call" || value === "file" || value === "browser" || value === "location") return value;
  throw new Error(`${field} must be calendar, email, call, file, browser, or location`);
}

function safeMcpName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "tool";
}

function sensors(value: unknown, mcpServers: Record<string, unknown>[]): PluginSensorManifest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("Plugin sensors must be an array of at most 32 entries");
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const raw = object(entry, `Plugin sensors[${index}]`);
    rejectUnknown(raw, ["id", "displayName", "kind", "purpose", "dataClasses", "retentionDays", "server", "tool"], `Plugin sensors[${index}]`);
    const id = identifier(raw.id, `Plugin sensors[${index}].id`);
    if (ids.has(id)) throw new Error(`Plugin sensor id ${id} is duplicated`);
    ids.add(id);
    const displayName = text(raw.displayName, `Plugin sensors[${index}].displayName`, 128, true) as string;
    const purpose = text(raw.purpose, `Plugin sensors[${index}].purpose`, 2_000, true) as string;
    const server = identifier(raw.server, `Plugin sensors[${index}].server`);
    const tool = text(raw.tool, `Plugin sensors[${index}].tool`, 256, true) as string;
    if (tool.includes("\0")) throw new Error(`Plugin sensors[${index}].tool contains a null byte`);
    const dataClasses = strings(raw.dataClasses, `Plugin sensors[${index}].dataClasses`, 16);
    if (!dataClasses.length || dataClasses.some((item) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(item))) {
      throw new Error(`Plugin sensors[${index}].dataClasses must contain 1-16 portable identifiers`);
    }
    if (typeof raw.retentionDays !== "number" || !Number.isInteger(raw.retentionDays) || raw.retentionDays < 1 || raw.retentionDays > 3_650) {
      throw new Error(`Plugin sensors[${index}].retentionDays must be an integer from 1 to 3650`);
    }
    const mcp = mcpServers.find((candidate) => candidate.name === server);
    if (!mcp) throw new Error(`Plugin sensor ${id} refers to missing MCP server ${server}`);
    if (!Array.isArray(mcp.allowedTools) || !mcp.allowedTools.includes(tool)) throw new Error(`Plugin sensor ${id} tool ${tool} must be explicitly allowlisted`);
    if (!mcp.toolRisks || typeof mcp.toolRisks !== "object" || Array.isArray(mcp.toolRisks)
      || (mcp.toolRisks as Record<string, unknown>)[tool] !== "read") {
      throw new Error(`Plugin sensor ${id} tool ${tool} must be explicitly classified read-only`);
    }
    return {
      id, displayName, kind: sensorKind(raw.kind, `Plugin sensors[${index}].kind`), purpose,
      dataClasses: [...new Set(dataClasses)].sort(), retentionDays: raw.retentionDays, server, tool,
    };
  });
}

export function parsePluginManifest(value: unknown): PluginManifest {
  const raw = object(value, "Plugin manifest");
  rejectUnknown(raw, ["schemaVersion", "id", "version", "displayName", "description", "contributes"], "Plugin manifest");
  if (raw.schemaVersion !== 1) throw new Error("Plugin schemaVersion must be 1");
  const id = identifier(raw.id, "Plugin id");
  const version = text(raw.version, "Plugin version", 64, true) as string;
  if (!VERSION.test(version)) throw new Error("Plugin version must be semantic version syntax");
  const displayName = text(raw.displayName, "Plugin displayName", 128) ?? id;
  const description = text(raw.description, "Plugin description", 2_000);
  const contributes = raw.contributes === undefined ? {} : object(raw.contributes, "Plugin contributes");
  rejectUnknown(contributes, ["skillRoots", "mcpServers", "sensors"], "Plugin contributes");
  const skillRoots = strings(contributes.skillRoots, "Plugin skillRoots");
  const rawMcp = contributes.mcpServers ?? [];
  if (!Array.isArray(rawMcp) || rawMcp.length > 32) throw new Error("Plugin mcpServers must be an array of at most 32 entries");
  const mcpServers = rawMcp.map((entry, index) => object(entry, `Plugin mcpServers[${index}]`));
  const sensorContributions = sensors(contributes.sensors, mcpServers);
  return {
    schemaVersion: 1,
    id,
    version,
    displayName,
    ...(description ? { description } : {}),
    contributes: { skillRoots, mcpServers, sensors: sensorContributions },
  };
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function resolveContributionRoot(pluginRoot: string, configured: string): string {
  if (isAbsolute(configured)) throw new Error(`Plugin contribution paths must be relative: ${configured}`);
  const candidate = resolve(pluginRoot, configured);
  if (!within(pluginRoot, candidate)) throw new Error(`Plugin contribution escapes its root: ${configured}`);
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) throw new Error(`Plugin skill root does not exist: ${configured}`);
  const realRoot = realpathSync(pluginRoot);
  const realCandidate = realpathSync(candidate);
  if (!within(realRoot, realCandidate)) throw new Error(`Plugin skill root resolves outside its package: ${configured}`);
  return realCandidate;
}

function manifestDirectories(root: string): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const direct = resolve(root, "plugin.json");
  const output = existsSync(direct) ? [root] : [];
  for (const entry of readdirSync(root, { withFileTypes: true }).slice(0, 1_000)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = resolve(root, entry.name);
    if (existsSync(resolve(directory, "plugin.json"))) output.push(directory);
  }
  return output;
}

export class PluginRegistry {
  readonly plugins: DiscoveredPlugin[];
  readonly diagnostics: PluginDiagnostic[];

  constructor(roots: string[]) {
    const discovered: DiscoveredPlugin[] = [];
    const diagnostics: PluginDiagnostic[] = [];
    const visited = new Set<string>();
    for (const configuredRoot of roots) {
      const root = resolve(configuredRoot);
      if (!existsSync(root)) continue;
      let canonical: string;
      try {
        canonical = realpathSync(root);
        if (canonical === parsePath(canonical).root) throw new Error("Plugin root may not resolve to a filesystem root");
      } catch (error) {
        diagnostics.push({ level: "error", code: "plugin.root", path: root, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (visited.has(canonical)) continue;
      visited.add(canonical);
      for (const directory of manifestDirectories(canonical)) {
        const manifestPath = resolve(directory, "plugin.json");
        try {
          if (lstatSync(manifestPath).isSymbolicLink()) throw new Error("Plugin manifest may not be a symbolic link");
          if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) throw new Error(`Plugin manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
          const manifest = parsePluginManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
          discovered.push({ manifest, root: directory, manifestPath });
        } catch (error) {
          diagnostics.push({
            level: "error", code: "plugin.invalid", path: manifestPath,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const byId = new Map<string, DiscoveredPlugin[]>();
    for (const plugin of discovered) byId.set(plugin.manifest.id, [...(byId.get(plugin.manifest.id) ?? []), plugin]);
    for (const [pluginId, records] of byId) {
      if (records.length > 1) diagnostics.push({
        level: "error", code: "plugin.duplicate", pluginId,
        message: `Plugin ${pluginId} is declared by multiple packages: ${records.map((record) => record.manifestPath).join(", ")}`,
      });
    }
    this.plugins = discovered.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id) || left.manifestPath.localeCompare(right.manifestPath));
    this.diagnostics = diagnostics;
  }

  activate(selectedIds: string[]): PluginActivation {
    const selected = [...new Set(selectedIds)].sort();
    const activated: DiscoveredPlugin[] = [];
    const activationDiagnostics: PluginDiagnostic[] = [];
    for (const pluginId of selected) {
      identifier(pluginId, "Selected plugin id");
      const matches = this.plugins.filter((plugin) => plugin.manifest.id === pluginId);
      if (matches.length === 0) {
        activationDiagnostics.push({ level: "error", code: "plugin.missing", pluginId, message: `Selected plugin ${pluginId} was not discovered` });
      } else if (matches.length > 1) {
        activationDiagnostics.push({ level: "error", code: "plugin.duplicate", pluginId, message: `Selected plugin ${pluginId} has multiple manifests` });
      } else {
        activated.push(matches[0] as DiscoveredPlugin);
      }
    }
    const selectedInvalid = this.diagnostics.filter((diagnostic) => diagnostic.pluginId && selected.includes(diagnostic.pluginId));
    const errors = [...activationDiagnostics, ...selectedInvalid].filter((diagnostic) => diagnostic.level === "error");
    if (errors.length) throw new Error(errors.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; "));
    const skillRoots: string[] = [];
    const mcpServers: Record<string, unknown>[] = [];
    const manifestSensors: SensorConfig[] = [];
    for (const plugin of activated) {
      for (const skillRoot of plugin.manifest.contributes.skillRoots) skillRoots.push(resolveContributionRoot(plugin.root, skillRoot));
      for (const rawServer of plugin.manifest.contributes.mcpServers) {
        const name = identifier(rawServer.name, `Plugin ${plugin.manifest.id} MCP server name`);
        const cwd = typeof rawServer.cwd === "string" ? resolveContributionRoot(plugin.root, rawServer.cwd) : undefined;
        mcpServers.push({ ...rawServer, name: `${plugin.manifest.id}.${name}`, ...(cwd ? { cwd } : {}) });
      }
      for (const sensor of plugin.manifest.contributes.sensors) {
        const mcpServerName = `${plugin.manifest.id}.${sensor.server}`;
        manifestSensors.push({
          id: `${plugin.manifest.id}.${sensor.id}`, pluginId: plugin.manifest.id, displayName: sensor.displayName,
          kind: sensor.kind, purpose: sensor.purpose, dataClasses: sensor.dataClasses, retentionDays: sensor.retentionDays,
          mcpServerName, remoteToolName: sensor.tool,
          runtimeToolName: `mcp_${safeMcpName(mcpServerName)}_${safeMcpName(sensor.tool)}`.slice(0, 64),
        });
      }
    }
    const sensorIds = new Set<string>();
    const sensorTools = new Set<string>();
    for (const sensor of manifestSensors) {
      if (sensorIds.has(sensor.id)) throw new Error(`Activated sensor id collision: ${sensor.id}`);
      if (sensorTools.has(sensor.runtimeToolName)) throw new Error(`Activated sensors collide on runtime tool ${sensor.runtimeToolName}`);
      sensorIds.add(sensor.id);
      sensorTools.add(sensor.runtimeToolName);
    }
    return {
      plugins: activated,
      skillRoots: [...new Set(skillRoots)],
      mcpServers,
      sensors: manifestSensors,
      diagnostics: [...this.diagnostics, ...activationDiagnostics],
    };
  }

  status(selectedIds: string[]): Array<Record<string, unknown>> {
    const selected = new Set(selectedIds);
    return this.plugins.map((plugin) => ({
      id: plugin.manifest.id,
      version: plugin.manifest.version,
      displayName: plugin.manifest.displayName,
      selected: selected.has(plugin.manifest.id),
      manifestPath: plugin.manifestPath,
      contributions: {
        skillRoots: plugin.manifest.contributes.skillRoots.length,
        mcpServers: plugin.manifest.contributes.mcpServers.length,
        sensors: plugin.manifest.contributes.sensors.length,
      },
      diagnostics: this.diagnostics.filter((diagnostic) => diagnostic.pluginId === plugin.manifest.id || diagnostic.path === plugin.manifestPath),
    }));
  }

  report(selectedIds: string[]): { plugins: Array<Record<string, unknown>>; diagnostics: PluginDiagnostic[] } {
    const discoveredIds = new Set(this.plugins.map((plugin) => plugin.manifest.id));
    const missing = [...new Set(selectedIds)].filter((pluginId) => !discoveredIds.has(pluginId)).map((pluginId) => ({
      level: "error" as const, code: "plugin.missing", pluginId, message: `Selected plugin ${pluginId} was not discovered`,
    }));
    return { plugins: this.status(selectedIds), diagnostics: [...this.diagnostics, ...missing] };
  }
}
