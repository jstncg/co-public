import { coEnv } from "./env.ts";
import type { RuntimeEnvironment } from "./types.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
type LogFields = Record<string, unknown>;

const levels: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const secretKey = /authorization|cookie|secret|token|password|credential|api[-_]?key/i;

function redactString(value: string): string {
  return value
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(?:sk|key|token)-[a-zA-Z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[redacted]")
    .replace(/([?&](?:access_token|api_key|token|key)=)[^&#\s]+/gi, "$1[redacted]");
}

export function redactForObservability(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (value instanceof Error) return {
    name: value.name,
    message: redactString(value.message).slice(0, 4_000),
    stack: value.stack ? redactString(value.stack).slice(0, 8_000) : undefined,
  };
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactForObservability(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, secretKey.test(key) ? "[redacted]" : redactForObservability(item, depth + 1)]));
  }
  if (typeof value === "string") {
    const bounded = value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
    return redactString(bounded);
  }
  return value;
}

function configuredLevel(environment: RuntimeEnvironment): LogLevel {
  const value = coEnv("CO_LOG_LEVEL");
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  return environment === "production" ? "info" : environment === "test" ? "error" : "warn";
}

export class RuntimeLogger {
  readonly environment: RuntimeEnvironment;
  readonly minimumLevel: LogLevel;

  constructor(environment: RuntimeEnvironment, minimumLevel = configuredLevel(environment)) {
    this.environment = environment;
    this.minimumLevel = minimumLevel;
  }

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (levels[level] < levels[this.minimumLevel]) return;
    const record = redactForObservability({ time: new Date().toISOString(), level, message, ...fields });
    process.stderr.write(`${JSON.stringify(record)}\n`);
  }

  debug(message: string, fields?: LogFields): void { this.log("debug", message, fields); }
  info(message: string, fields?: LogFields): void { this.log("info", message, fields); }
  warn(message: string, fields?: LogFields): void { this.log("warn", message, fields); }
  error(message: string, fields?: LogFields): void { this.log("error", message, fields); }
}
