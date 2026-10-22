import { createHash, randomUUID } from "node:crypto";

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
