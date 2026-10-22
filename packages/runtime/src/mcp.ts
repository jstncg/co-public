import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig, JsonObject, JsonValue, ToolDefinition, ToolRisk } from "./types.ts";
import { DependencyError } from "./dependency-errors.ts";
import type { RuntimeTool, ToolOutcome } from "./tools.ts";

export interface McpConnectionStatus {
  name: string;
  transport: McpServerConfig["transport"];
  status: "connected" | "failed" | "closed";
  tools: string[];
  error?: string;
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "tool";
}

function asJsonObject(value: unknown): JsonObject {
  const serialized = JSON.stringify(value);
  if (!serialized) return {};
  const parsed = JSON.parse(serialized) as JsonValue;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function boundedJson(value: unknown, maximum = 200_000): JsonValue {
  const serialized = JSON.stringify(value);
  if (!serialized) return null;
  if (serialized.length > maximum) return { truncated: true, originalChars: serialized.length, preview: serialized.slice(0, maximum) };
  return JSON.parse(serialized) as JsonValue;
}

function findSemanticFailure(value: JsonValue, depth = 0): string | undefined {
  if (depth > 5 || value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const failure = findSemanticFailure(item, depth + 1);
      if (failure) return failure;
    }
    return undefined;
  }
  if (value.ok === false || value.success === false) {
    return typeof value.error === "string" ? value.error : "MCP tool reported an unsuccessful result";
  }
  if (typeof value.status === "string" && ["error", "failed", "failure"].includes(value.status.toLowerCase())) {
    return typeof value.error === "string" ? value.error : `MCP tool reported status ${value.status}`;
  }
  if (value.truncated === true) return "MCP result was truncated and cannot prove the complete outcome";
  for (const item of Object.values(value)) {
    const failure = findSemanticFailure(item, depth + 1);
    if (failure) return failure;
  }
  return undefined;
}

export function evaluateMcpResult(risk: ToolRisk, output: JsonValue): ToolOutcome {
  const failure = findSemanticFailure(output);
  if (failure) return { status: risk === "read" ? "failed" : "uncertain", error: failure };
  // A generic MCP response proves that a request was accepted, not that a
  // consequential side effect reached its intended outcome. Purpose-built
  // adapters may supply stronger, domain-specific evidence predicates.
  return { status: "succeeded", evidenceScope: risk === "read" ? "outcome" : "request" };
}

function errorText(result: { content?: unknown }): string {
  if (!Array.isArray(result.content)) return "MCP tool reported an error";
  const text = result.content.flatMap((item) => {
    if (!item || typeof item !== "object" || !("text" in item) || typeof item.text !== "string") return [];
    return [item.text];
  }).join("\n").trim();
  return text || "MCP tool reported an error";
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function riskForMcpTool(server: McpServerConfig, remoteName: string): ToolRisk {
  return server.toolRisks?.[remoteName] ?? server.defaultRisk ?? "external-write";
}

function toolDefinition(server: McpServerConfig, remote: {
  name: string;
  description?: string | undefined;
  inputSchema: { type: "object"; properties?: Record<string, object> | undefined; required?: string[] | undefined };
}): ToolDefinition {
  const name = `mcp_${safeName(server.name)}_${safeName(remote.name)}`.slice(0, 64);
  const properties = Object.fromEntries(Object.entries(remote.inputSchema.properties ?? {}).map(([key, value]) => [key, asJsonObject(value)]));
  return {
    name,
    description: `[MCP server: ${server.name}; remote tool: ${remote.name}] ${remote.description ?? "No server description provided."}`,
    inputSchema: {
      type: "object",
      properties,
      ...(remote.inputSchema.required ? { required: remote.inputSchema.required } : {}),
      additionalProperties: true,
    },
    risk: riskForMcpTool(server, remote.name),
    tags: ["mcp", server.name, remote.name, ...remote.name.split(/[^a-zA-Z0-9]+/)].filter(Boolean),
    // MCP annotations are explicitly hints and are not a trust boundary. Only local
    // configuration determines risk; remote idempotence claims are not relied on.
    idempotent: false,
    strict: false,
  };
}

export class McpManager {
  private readonly servers: McpServerConfig[];
  private readonly clients: Client[] = [];
  private reports: McpConnectionStatus[] = [];
  private initialized = false;

  constructor(servers: McpServerConfig[]) {
    this.servers = servers;
  }

  get status(): McpConnectionStatus[] {
    return this.reports.map((report) => ({ ...report, tools: [...report.tools] }));
  }

  async connectAll(): Promise<RuntimeTool[]> {
    if (this.initialized) return [];
    this.initialized = true;
    const tools: RuntimeTool[] = [];
    const reports: McpConnectionStatus[] = [];
    const usedNames = new Set<string>();

    for (const server of this.servers) {
      const client = new Client({ name: "co", version: "0.2.0" });
      try {
        const timeout = server.timeoutMs ?? 30_000;
        if (server.transport === "stdio") {
          const transport = new StdioClientTransport({
            command: server.command as string,
            ...(server.args ? { args: server.args } : {}),
            ...(server.cwd ? { cwd: server.cwd } : {}),
            ...(server.env ? { env: { ...getDefaultEnvironment(), ...server.env } } : {}),
            stderr: "inherit",
          });
          await withTimeout(client.connect(transport as unknown as Transport), timeout, `MCP connection ${server.name}`);
        } else {
          const transport = new StreamableHTTPClientTransport(new URL(server.url as string), server.headers ? { requestInit: { headers: server.headers } } : undefined);
          await withTimeout(client.connect(transport as unknown as Transport), timeout, `MCP connection ${server.name}`);
        }
        const listed = await client.listTools(undefined, { timeout });
        const allowed = server.allowedTools ? new Set(server.allowedTools) : undefined;
        const selected = listed.tools.filter((tool) => !allowed || allowed.has(tool.name));
        const names: string[] = [];
        const serverTools: RuntimeTool[] = [];
        const serverNames = new Set<string>();
        for (const remote of selected) {
          const definition = toolDefinition(server, remote);
          const risk = definition.risk;
          if (usedNames.has(definition.name) || serverNames.has(definition.name)) throw new Error(`MCP tool name collision after normalization: ${definition.name}`);
          serverNames.add(definition.name);
          names.push(definition.name);
          serverTools.push({
            definition,
            evaluateResult: (output) => evaluateMcpResult(risk, output),
            execute: async (_context, arguments_) => {
              let result: Awaited<ReturnType<typeof client.callTool>>;
              try {
                result = await client.callTool({ name: remote.name, arguments: arguments_ }, undefined, { timeout });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const timedOut = /timed?\s*out|timeout/i.test(message);
                throw new DependencyError({
                  service: `mcp:${server.name}`,
                  kind: timedOut ? "timeout" : "network",
                  message: `MCP tool ${server.name}.${remote.name} did not return a valid response: ${message}`,
                  retryable: risk === "read",
                  uncertain: risk !== "read",
                });
              }
              if (result.isError) {
                throw new DependencyError({
                  service: `mcp:${server.name}`,
                  kind: "unknown",
                  message: errorText(result as { content?: unknown }),
                  retryable: risk === "read",
                  uncertain: risk !== "read",
                });
              }
              return boundedJson(result);
            },
          });
        }
        for (const name of serverNames) usedNames.add(name);
        tools.push(...serverTools);
        this.clients.push(client);
        reports.push({ name: server.name, transport: server.transport, status: "connected", tools: names });
      } catch (error) {
        await client.close().catch(() => undefined);
        reports.push({
          name: server.name, transport: server.transport, status: "failed", tools: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.reports = reports;
    return tools;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((client) => client.close()));
    this.clients.length = 0;
    this.reports = this.reports.map((report) => report.status === "connected" ? { ...report, status: "closed" } : report);
  }
}
