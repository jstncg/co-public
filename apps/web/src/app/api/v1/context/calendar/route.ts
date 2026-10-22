import { ZodError } from "zod";
import {
  deleteCalendarContext,
  syncCalendarContext,
} from "../../../../../lib/ambient-context-service";
import { enforceUserRateLimit } from "../../../../../lib/rate-limit";
import { requireUser } from "../../../../../lib/supabase-admin";

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    await enforceUserRateLimit(admin, user.id, {
      bucket: "context.calendar.sync",
      limit: 120,
      windowSeconds: 3_600,
    });
    return Response.json(await syncCalendarContext(admin, user.id, await request.json()));
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) return Response.json({ error: "invalid_calendar_context" }, { status: 400 });
    return Response.json({ error: "calendar_context_sync_failed" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json(await deleteCalendarContext(admin, user.id, await request.json()));
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) return Response.json({ error: "invalid_calendar_context_source" }, { status: 400 });
    return Response.json({ error: "calendar_context_delete_failed" }, { status: 500 });
  }
}
