import { ZodError } from "zod";
import { correctArtifact } from "../../../../lib/history-service";
import { requireUser } from "../../../../lib/supabase-admin";

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json(await correctArtifact(admin, user.id, await request.json()), { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) return Response.json({ error: "invalid_correction" }, { status: 400 });
    return Response.json({ error: "correction_failed" }, { status: 500 });
  }
}

