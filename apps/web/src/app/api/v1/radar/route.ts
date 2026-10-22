import { ZodError } from "zod";
import { listRadar, recordRadarFeedback } from "../../../../lib/consumer-insights";
import { requireUser } from "../../../../lib/supabase-admin";

export async function GET(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json({ items: await listRadar(admin, user.id) });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "radar_failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json(await recordRadarFeedback(admin, user.id, await request.json()), { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) return Response.json({ error: "invalid_radar_feedback" }, { status: 400 });
    return Response.json({ error: "radar_feedback_failed" }, { status: 409 });
  }
}
