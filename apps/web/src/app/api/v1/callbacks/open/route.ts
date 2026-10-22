import { ZodError } from "zod";
import { markCallbackOpened } from "../../../../../lib/callback-service";
import { requireUser } from "../../../../../lib/supabase-admin";

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json(await markCallbackOpened(admin, user.id, await request.json()));
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) return Response.json({ error: "invalid_callback" }, { status: 400 });
    return Response.json({ error: "callback_open_failed" }, { status: 500 });
  }
}

