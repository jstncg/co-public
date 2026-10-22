import { ZodError } from "zod";
import { requestPhoneLink } from "../../../../../lib/phone-link-service";
import { requireUser } from "../../../../../lib/supabase-admin";

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json(await requestPhoneLink(admin, user.id, await request.json()), { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) return Response.json({ error: "invalid_phone_link_request" }, { status: 400 });
    return Response.json({ error: "phone_link_request_failed" }, { status: 503 });
  }
}

