import { monitorCollaboration } from "../../../../../lib/collaboration-service";
import { HttpStatusError } from "../../../../../lib/http-status-error";
import { requireUser } from "../../../../../lib/supabase-admin";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { admin, user } = await requireUser(request);
    const { id } = await context.params;
    const after = Number(new URL(request.url).searchParams.get("after") ?? "-1");
    return Response.json(
      await monitorCollaboration(admin, user.id, id, Number.isInteger(after) ? after : -1),
    );
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof HttpStatusError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "collaboration_monitor_failed" }, { status: 500 });
  }
}
