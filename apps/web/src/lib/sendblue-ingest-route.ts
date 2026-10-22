import { createHash, timingSafeEqual } from "node:crypto";
import {
  handleIngest,
  IngestError,
  SupabaseTransportStore,
  type IngestLog,
  type TransportStore,
} from "@co/transport";
import { featureFlagsFromEnvironment } from "@co/contracts";
import { tasks } from "@trigger.dev/sdk";

type Environment = Record<string, string | undefined>;
type StoreFactory = (environment: Environment) => TransportStore;

export type SendblueRouteDependencies = {
  environment?: Environment;
  createStore?: StoreFactory;
  log?: IngestLog;
  dispatchArtifact?: (input: { artifactId: string; userId: string; idempotencyKey: string }) => Promise<void>;
};

export type TransportRouteDependencies = SendblueRouteDependencies;

async function dispatchArtifact(input: { artifactId: string; userId: string; idempotencyKey: string }) {
  await tasks.trigger("process-artifact-v1", {
    artifactId: input.artifactId,
    userId: input.userId,
    resourceVersion: "artifact-processing.v1",
  }, { idempotencyKey: input.idempotencyKey });
}

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status });
}

function configuredEnvironment(environment: Environment) {
  if (environment.FEATURE_DUAL_WRITE !== "true") return null;
  const token = environment.CO_INGEST_TOKEN;
  const pepper = environment.CO_PHONE_MAPPING_PEPPER;
  const supabaseUrl = environment.NEXT_PUBLIC_SUPABASE_URL ?? environment.SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!token || token.length < 32 || !pepper || pepper.length < 32 || !supabaseUrl || !serviceRoleKey) return null;
  return { token };
}

function validBearer(request: Request, expectedToken: string) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = createHash("sha256").update(authorization.slice(7)).digest();
  const expected = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(supplied, expected);
}

function defaultLog(event: string, fields: Record<string, string | number | boolean | null>) {
  console.info(event, fields);
}

export async function handleTransportIngestRequest(
  request: Request,
  dependencies: TransportRouteDependencies = {},
) {
  const environment = dependencies.environment ?? process.env;
  const configuration = configuredEnvironment(environment);
  if (!configuration) return errorResponse("transport_ingest_unavailable", 503);
  if (!validBearer(request, configuration.token)) return errorResponse("unauthorized", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid_json", 422);
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("transport" in body) ||
    !["sendblue", "linq"].includes(String(body.transport))
  ) {
    return errorResponse("invalid_envelope", 422);
  }

  try {
    const store = (dependencies.createStore ?? ((env) => new SupabaseTransportStore(env)))(environment);
    const dispatchStoredArtifacts = featureFlagsFromEnvironment(environment).async_processing
      ? async (stored: { userId: string; artifactIds: string[] }) => {
          for (const artifactId of stored.artifactIds) {
            await (dependencies.dispatchArtifact ?? dispatchArtifact)({
              artifactId,
              userId: stored.userId,
              idempotencyKey: `transport-artifact:${artifactId}`,
            });
          }
        }
      : undefined;
    const result = await handleIngest(body, store, dependencies.log ?? defaultLog, dispatchStoredArtifacts);
    return Response.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof IngestError) {
      const code = error.status === 404
        ? "unknown_tenant"
        : error.status === 422
          ? "invalid_envelope"
          : "retry_later";
      return errorResponse(code, error.status);
    }
    (dependencies.log ?? defaultLog)("transport.ingest_failed", { retryable: true });
    return errorResponse("ingest_failed", 500);
  }
}

// Compatibility export for the original route and downstream imports. The HTTP boundary is now
// transport-neutral; /api/ingest/sendblue remains an additive alias so existing senders never lose
// an envelope during a provider cutover.
export const handleSendblueIngestRequest = handleTransportIngestRequest;
