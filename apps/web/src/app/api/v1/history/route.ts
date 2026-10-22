import { listRelationshipHistory } from "../../../../lib/history-service";
import { requireUser } from "../../../../lib/supabase-admin";

export async function GET(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    const query = new URL(request.url).searchParams.get("q");
    return Response.json(await listRelationshipHistory(admin, user.id, query));
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "history_failed" }, { status: 500 });
  }
}

