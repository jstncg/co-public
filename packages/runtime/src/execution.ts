import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, parse as parsePath, relative, resolve } from "node:path";
import { id } from "./id.ts";
import { DependencyError } from "./dependency-errors.ts";
import type { ExecutionBackendName, ExecutionConfig, JsonObject, RuntimeConfig } from "./types.ts";

export interface ExecutionRequest {
  command: string;
  args?: string[];
  cwd?: string;
  stdin?: string;
}

export interface ExecutionResult extends JsonObject {
  backend: ExecutionBackendName;
  command: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  terminationCleanup: "not-needed" | "process-killed" | "confirmed" | "uncertain";
  durationMs: number;
}

export interface ExecutionBackend {
  readonly name: ExecutionBackendName;
  run(request: ExecutionRequest): Promise<ExecutionResult>;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function workspaceContext(config: RuntimeConfig, requested?: string): { cwd: string; root: string; rootIndex: number } {
  if (!config.workspaceRoots.length) throw new Error("Execution requires at least one workspace root");
  const raw = resolve(requested ?? config.workspaceRoots[0] as string);
  if (!existsSync(raw) || !statSync(raw).isDirectory()) throw new Error(`Execution working directory does not exist: ${raw}`);
  const cwd = realpathSync(raw);
  for (let index = 0; index < config.workspaceRoots.length; index += 1) {
    const configured = config.workspaceRoots[index] as string;
    if (!existsSync(configured)) continue;
    const root = realpathSync(configured);
    if (root === parsePath(root).root) continue;
    if (within(root, cwd)) return { cwd, root, rootIndex: index };
  }
  throw new Error(`Execution working directory is outside configured workspace roots: ${cwd}`);
}

function command(config: ExecutionConfig, requested: string): string {
  const value = requested.trim();
  if (!value || value.length > 512 || value.includes("\0")) throw new Error("Execution command is invalid");
  const allowed = config.allowedCommands.some((entry) => entry === value && (value.includes("/") === entry.includes("/")));
  if (!allowed) throw new Error(`Execution command is not allowlisted: ${value}`);
  return value;
}

function commandArguments(value: string[] | undefined): string[] {
  if (!value) return [];
  if (value.length > 128 || value.some((item) => typeof item !== "string" || item.length > 8_192 || item.includes("\0"))) {
    throw new Error("Execution arguments exceed their bounds");
  }
  return value;
}

function runProcess(input: {
  backend: ExecutionBackendName;
  executable: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
  cleanup?: () => Promise<boolean>;
}): Promise<ExecutionResult> {
  return new Promise((resolve_, reject) => {
    const started = performance.now();
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: input.env,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let truncated = false;
    let settled = false;
    let cleanupPromise: Promise<boolean> | undefined;
    const terminate = () => {
      child.kill("SIGKILL");
      if (input.cleanup && !cleanupPromise) cleanupPromise = input.cleanup().catch(() => false);
    };
    const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
      const current = target === "stdout" ? stdout : stderr;
      const remaining = Math.max(0, input.maxOutputBytes - stdout.length - stderr.length);
      const next = Buffer.concat([current, chunk.subarray(0, remaining)]);
      if (target === "stdout") stdout = next;
      else stderr = next;
      if (chunk.length > remaining) {
        truncated = true;
        terminate();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", async (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const forced = timedOut || truncated;
      const cleanupConfirmed = cleanupPromise ? await cleanupPromise : undefined;
      resolve_({
        backend: input.backend,
        command: input.executable,
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        truncated,
        terminationCleanup: !forced ? "not-needed" : input.cleanup ? cleanupConfirmed ? "confirmed" : "uncertain" : "process-killed",
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      });
    });
    if (input.stdin !== undefined) child.stdin.end(input.stdin.slice(0, 100_000));
    else child.stdin.end();
  });
}

class DisabledExecutionBackend implements ExecutionBackend {
  readonly name = "none" as const;
  async run(): Promise<ExecutionResult> {
    throw new Error("Process execution is disabled");
  }
}

class LocalExecutionBackend implements ExecutionBackend {
  readonly name = "local" as const;
  readonly config: RuntimeConfig;

  constructor(config: RuntimeConfig) { this.config = config; }

  run(request: ExecutionRequest): Promise<ExecutionResult> {
    const workspace = workspaceContext(this.config, request.cwd);
    const executable = command(this.config.execution, request.command);
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "LANG", "LC_ALL", "TMPDIR", "TZ"]) if (process.env[name]) env[name] = process.env[name];
    return runProcess({
      backend: this.name, executable, args: commandArguments(request.args), cwd: workspace.cwd,
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      timeoutMs: this.config.execution.timeoutMs, maxOutputBytes: this.config.execution.maxOutputBytes, env,
    });
  }
}

class DockerExecutionBackend implements ExecutionBackend {
  readonly name = "docker" as const;
  readonly config: RuntimeConfig;

  constructor(config: RuntimeConfig) { this.config = config; }

  run(request: ExecutionRequest): Promise<ExecutionResult> {
    const invocation = buildDockerInvocation(this.config, request);
    return runProcess({
      backend: this.name, executable: "docker", args: invocation.args, cwd: invocation.cwd,
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      timeoutMs: this.config.execution.timeoutMs, maxOutputBytes: this.config.execution.maxOutputBytes,
      env: { PATH: process.env.PATH },
      cleanup: () => cleanupDockerContainer(invocation.containerName),
    }).then((result) => {
      if (result.terminationCleanup === "uncertain") {
        throw new DependencyError({
          service: "docker",
          kind: "unavailable",
          message: `Docker execution ${invocation.containerName} was terminated but container cleanup could not be confirmed; inspect the Docker daemon before retrying`,
          retryable: false,
          uncertain: true,
        });
      }
      return { ...result, command: invocation.command };
    });
  }
}

function dockerCommand(args: string[], timeoutMs = 5_000): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve_) => {
    const child = spawn("docker", args, { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH } });
    let stderr = "";
    let settled = false;
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, 4_000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref();
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve_({ exitCode: null, stderr });
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve_({ exitCode, stderr });
    });
  });
}

async function cleanupDockerContainer(containerName: string): Promise<boolean> {
  const removed = await dockerCommand(["rm", "--force", containerName]);
  if (removed.exitCode === 0 || /No such (object|container)/i.test(removed.stderr)) return true;
  const inspected = await dockerCommand(["inspect", containerName]);
  return /No such (object|container)/i.test(inspected.stderr);
}

export function buildDockerInvocation(config: RuntimeConfig, request: ExecutionRequest): { args: string[]; cwd: string; command: string; containerName: string } {
  const image = config.execution.dockerImage;
  if (!image) throw new Error("Docker execution requires CO_EXECUTION_DOCKER_IMAGE");
  if (image.length > 512 || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image)) throw new Error("Docker execution image reference is invalid");
  const workspace = workspaceContext(config, request.cwd);
  const executable = command(config.execution, request.command);
  const target = `/workspace/${workspace.rootIndex}`;
  const relativeCwd = relative(workspace.root, workspace.cwd);
  const containerCwd = relativeCwd ? `${target}/${relativeCwd}` : target;
  const containerName = `co-${id("exec").replaceAll("_", "-")}`;
  const dockerArguments = [
    "run", "--rm", "--name", containerName, "--label", "co.runtime.execution=true", "--log-driver", "none",
    "--pull", "never", "--network", "none", "--read-only", "--init", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "512m", "--cpus", "1",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777",
    "--workdir", containerCwd,
  ];
  if (request.stdin !== undefined) dockerArguments.push("--interactive");
  if (typeof process.getuid === "function" && typeof process.getgid === "function") dockerArguments.push("--user", `${process.getuid()}:${process.getgid()}`);
  if (workspace.root.includes(",") || workspace.root.includes("\n") || workspace.root.includes("\r")) throw new Error(`Docker workspace path cannot contain commas or newlines: ${workspace.root}`);
  dockerArguments.push("--mount", `type=bind,src=${workspace.root},dst=/workspace/${workspace.rootIndex},${config.execution.workspaceMode === "read-write" ? "rw" : "readonly"}`);
  dockerArguments.push(image, executable, ...commandArguments(request.args));
  return { args: dockerArguments, cwd: workspace.cwd, command: executable, containerName };
}

export class ExecutionManager {
  readonly backend: ExecutionBackend;
  readonly config: ExecutionConfig;

  constructor(config: RuntimeConfig) {
    this.config = config.execution;
    this.backend = config.execution.backend === "local" ? new LocalExecutionBackend(config)
      : config.execution.backend === "docker" ? new DockerExecutionBackend(config)
        : new DisabledExecutionBackend();
  }

  run(request: ExecutionRequest): Promise<ExecutionResult> {
    return this.backend.run(request);
  }

  get status(): Record<string, unknown> {
    return {
      backend: this.backend.name,
      enabled: this.backend.name !== "none",
      allowedCommands: this.config.allowedCommands,
      timeoutMs: this.config.timeoutMs,
      maxOutputBytes: this.config.maxOutputBytes,
      workspaceMode: this.config.workspaceMode,
      image: this.config.dockerImage ?? null,
    };
  }
}
