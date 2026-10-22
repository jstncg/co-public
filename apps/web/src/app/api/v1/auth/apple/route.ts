import { ZodError } from "zod";
import { saveAppleAuthorization } from "../../../../../lib/apple-authorization";
import { enforceUserRateLimit } from "../../../../../lib/rate-limit";
import { requireUser } from "../../../../../lib/supabase-admin";

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    await enforceUserRateLimit(admin, user.id, { bucket: "auth.apple.exchange", limit: 10, windowSeconds: 3_600 });
    return Response.json(await saveAppleAuthorization(admin, user.id, await request.json()), { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) return Response.json({ error: "invalid_apple_authorization" }, { status: 400 });
    return Response.json({ error: "apple_authorization_failed" }, { status: 503 });
  }
}
