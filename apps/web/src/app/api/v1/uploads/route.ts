import { ZodError } from "zod";
import { enforceUserRateLimit } from "../../../../lib/rate-limit";
import { requireUser } from "../../../../lib/supabase-admin";
import { createUploadSlots } from "../../../../lib/upload-service";

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    await enforceUserRateLimit(admin, user.id, { bucket: "uploads.create", limit: 120, windowSeconds: 600 });
    return Response.json(await createUploadSlots(admin, user.id, await request.json()), { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) return Response.json({ error: "invalid_upload_request", issues: error.issues.map(({ path, message }) => ({ path, message })) }, { status: 400 });
    if (error instanceof Error && error.message === "unsupported_mime_type") return Response.json({ error: error.message }, { status: 415 });
    return Response.json({ error: "upload_slot_failed" }, { status: 500 });
  }
}
