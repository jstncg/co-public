import { inspectAmbientContext } from "../../../../lib/ambient-context-service";
import { requireUser } from "../../../../lib/supabase-admin";

export async function GET(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json(await inspectAmbientContext(admin, user.id));
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "ambient_context_read_failed" }, { status: 500 });
  }
}
