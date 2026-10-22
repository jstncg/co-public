import { ZodError } from "zod";
import { dismissMemoryReturn } from "../../../../../lib/memory-service";
import { requireUser } from "../../../../../lib/supabase-admin";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { admin, user } = await requireUser(request);
    const { id } = await context.params;
    return Response.json(await dismissMemoryReturn(admin, user.id, id));
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) return Response.json({ error: "invalid_return" }, { status: 400 });
    return Response.json({ error: "return_dismiss_failed" }, { status: 500 });
  }
}
