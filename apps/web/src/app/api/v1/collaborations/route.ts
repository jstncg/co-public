import { ZodError } from "zod";
import { startCollaboration } from "../../../../lib/collaboration-service";
import { HttpStatusError } from "../../../../lib/http-status-error";
import { enforceUserRateLimit } from "../../../../lib/rate-limit";
import { requireUser } from "../../../../lib/supabase-admin";

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    await enforceUserRateLimit(admin, user.id, {
      bucket: "collaborations.create",
      limit: 20,
      windowSeconds: 3_600,
    });
    return Response.json(await startCollaboration(admin, user.id, await request.json()), {
      status: 202,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof HttpStatusError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ZodError)
      return Response.json({ error: "invalid_collaboration_run" }, { status: 400 });
    return Response.json({ error: "collaboration_start_failed" }, { status: 500 });
  }
}
