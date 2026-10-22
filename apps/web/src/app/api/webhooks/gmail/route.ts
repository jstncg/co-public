import { tasks } from "@trigger.dev/sdk/v3";
import { ZodError } from "zod";
import type { GmailSyncTaskPayload } from "@co/contracts";
import { ingestGmailPush } from "../../../../lib/gmail-awareness-service";
import { HttpStatusError } from "../../../../lib/http-status-error";
import { createAdminClient } from "../../../../lib/supabase-admin";

export async function POST(request: Request) {
  try {
    const result = await ingestGmailPush(
      createAdminClient(),
      request.headers.get("authorization"),
      () => readBoundedJson(request),
      process.env,
      {
        dispatch: async (payload: GmailSyncTaskPayload, idempotencyKey: string) => {
          await tasks.trigger("gmail-sync-v1", payload, { idempotencyKey });
        },
        log: (event, properties) => console.warn(event, properties),
      },
    );
    return new Response(null, {
      status: result.accepted ? 204 : 202,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof HttpStatusError) {
      return Response.json({ error: "gmail_push_unauthorized" }, { status: error.status });
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return Response.json({ error: "invalid_gmail_push" }, { status: 400 });
    }
    return Response.json({ error: "gmail_push_failed" }, { status: 503 });
  }
}

async function readBoundedJson(request: Request) {
  const maximumBytes = 16_384;
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > maximumBytes) {
    throw new SyntaxError("invalid Gmail push body length");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maximumBytes) {
    throw new SyntaxError("Gmail push body is too large");
  }
  return JSON.parse(body) as unknown;
}
