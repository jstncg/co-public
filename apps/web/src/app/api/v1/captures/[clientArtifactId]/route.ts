import { ZodError } from "zod";
import { deleteArtifact } from "../../../../../lib/artifact-deletion";
import { requireUser } from "../../../../../lib/supabase-admin";

export async function DELETE(request: Request, context: { params: Promise<{ clientArtifactId: string }> }) {
  try {
    const { admin, user } = await requireUser(request);
    const { clientArtifactId } = await context.params;
    return Response.json(await deleteArtifact(admin, user.id, clientArtifactId));
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) return Response.json({ error: "invalid_artifact" }, { status: 400 });
    return Response.json({ error: "artifact_deletion_failed" }, { status: 500 });
  }
}
