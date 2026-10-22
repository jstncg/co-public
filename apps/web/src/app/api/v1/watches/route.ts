import { ZodError } from "zod";
import { createWatch } from "../../../../lib/consumer-insights";
import { requireUser } from "../../../../lib/supabase-admin";

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json(await createWatch(admin, user.id, await request.json()), { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) return Response.json({ error: "invalid_watch" }, { status: 400 });
    return Response.json({ error: "watch_failed" }, { status: 500 });
  }
}
