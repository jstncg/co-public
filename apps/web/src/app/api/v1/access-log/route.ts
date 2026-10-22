import { listAccessLog } from "../../../../lib/access-log";
import { requireUser } from "../../../../lib/supabase-admin";

export async function GET(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json({ events: await listAccessLog(admin, user.id) });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "access_log_failed" }, { status: 500 });
  }
}
