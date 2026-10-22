import { ZodError } from "zod";
import { requireUser } from "../../../../../lib/supabase-admin";
import { saveWhyAnswer } from "../../../../../lib/why-answer";

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json(await saveWhyAnswer(admin, user.id, await request.json()), { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) {
      return Response.json({ error: "invalid_why_answer" }, { status: 400 });
    }
    return Response.json({ error: "why_answer_rejected" }, { status: 409 });
  }
}
