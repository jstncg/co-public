import { ZodError } from "zod";
import { listMoves, prepareMove, transitionMove } from "../../../../lib/move-service";
import { requireUser } from "../../../../lib/supabase-admin";

export async function GET(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json({ moves: await listMoves(admin, user.id) });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "moves_failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json(await prepareMove(admin, user.id, await request.json()), { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) return Response.json({ error: "invalid_move" }, { status: 400 });
    return Response.json({ error: "move_failed" }, { status: 409 });
  }
}

export async function PATCH(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json(await transitionMove(admin, user.id, await request.json()));
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) return Response.json({ error: "invalid_move_transition" }, { status: 400 });
    return Response.json({ error: "move_transition_failed" }, { status: 409 });
  }
}
