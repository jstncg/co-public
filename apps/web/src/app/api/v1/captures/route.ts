import { ZodError } from "zod";
import { captureArtifact } from "../../../../lib/capture-service";
import { enforceUserRateLimit } from "../../../../lib/rate-limit";
import { requireUser } from "../../../../lib/supabase-admin";

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    await enforceUserRateLimit(admin, user.id, { bucket: "captures.write", limit: 120, windowSeconds: 600 });
    const result = await captureArtifact(admin, user.id, await request.json());
    return Response.json(result, { status: result.receipt.status === "ready" ? 201 : 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) return Response.json({ error: "invalid_capture", issues: error.issues.map(({ path, message }) => ({ path, message })) }, { status: 400 });
    return Response.json({ error: "capture_failed" }, { status: 500 });
  }
}
