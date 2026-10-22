import { listMemoryReturns } from "../../../../lib/memory-service";
import { requireUser } from "../../../../lib/supabase-admin";

export async function GET(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json({ returns: await listMemoryReturns(admin, user.id) });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "returns_failed" }, { status: 500 });
  }
}

