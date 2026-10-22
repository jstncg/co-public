import { ZodError, z } from "zod";
import {
  activateGmailAwareness,
  beginGmailAuthorization,
  disconnectGmailAwareness,
} from "../../../../../lib/gmail-awareness-service";
import { enforceUserRateLimit } from "../../../../../lib/rate-limit";
import { requireUser } from "../../../../../lib/supabase-admin";
import { HttpStatusError } from "../../../../../lib/http-status-error";

const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("authorize"), callback_url: z.url() }).strict(),
  z.object({ action: z.literal("activate") }).strict(),
]);

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    await enforceUserRateLimit(admin, user.id, {
      bucket: "context.gmail.connect",
      limit: 10,
      windowSeconds: 3_600,
    });
    const command = commandSchema.parse(await request.json());
    if (command.action === "authorize") {
      return Response.json(await beginGmailAuthorization(user.id, command.callback_url));
    }
    return Response.json(await activateGmailAwareness(admin, user.id));
  } catch (error) {
    if (error instanceof HttpStatusError) {
      return Response.json({ error: "gmail_context_unavailable" }, { status: error.status });
    }
    if (error instanceof ZodError) {
      return Response.json({ error: "invalid_gmail_context_request" }, { status: 400 });
    }
    return Response.json({ error: "gmail_context_connect_failed" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    const input = z
      .object({ source_id: z.uuid() })
      .strict()
      .parse(await request.json());
    return Response.json(await disconnectGmailAwareness(admin, user.id, input.source_id));
  } catch (error) {
    if (error instanceof HttpStatusError) {
      return Response.json({ error: "gmail_context_unavailable" }, { status: error.status });
    }
    if (error instanceof ZodError) {
      return Response.json({ error: "invalid_gmail_context_source" }, { status: 400 });
    }
    return Response.json({ error: "gmail_context_delete_failed" }, { status: 500 });
  }
}
