export type DependencyFailureKind =
  | "timeout"
  | "rate_limited"
  | "unavailable"
  | "network"
  | "malformed_response"
  | "authentication"
  | "invalid_request"
  | "unknown";

export class DependencyError extends Error {
  readonly service: string;
  readonly kind: DependencyFailureKind;
  readonly retryable: boolean;
  readonly uncertain: boolean;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;

  constructor(input: {
    service: string;
    kind: DependencyFailureKind;
    message: string;
    retryable: boolean;
    uncertain?: boolean;
    httpStatus?: number;
    retryAfterMs?: number;
  }) {
    super(input.message);
    this.name = "DependencyError";
    this.service = input.service;
    this.kind = input.kind;
    this.retryable = input.retryable;
    this.uncertain = input.uncertain ?? false;
    if (input.httpStatus !== undefined) this.httpStatus = input.httpStatus;
    if (input.retryAfterMs !== undefined) this.retryAfterMs = input.retryAfterMs;
  }
}

export function isRetryableDependencyError(error: unknown): error is DependencyError {
  return error instanceof DependencyError && error.retryable;
}

export function dependencyNetworkError(service: string, error: unknown): DependencyError {
  const message = error instanceof Error ? error.message : String(error);
  const timeout = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
  return new DependencyError({
    service,
    kind: timeout ? "timeout" : "network",
    message: `${service} request ${timeout ? "timed out" : "failed before a valid response"}: ${message}`,
    retryable: true,
  });
}

export function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(24 * 60 * 60_000, Math.round(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(24 * 60 * 60_000, date - Date.now())) : undefined;
}
