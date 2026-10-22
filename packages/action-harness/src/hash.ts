import { createHash } from "node:crypto";
import type { ActionRunRequest } from "@co/contracts";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function hashActionRequest(request: ActionRunRequest) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(request)))
    .digest("hex");
}
