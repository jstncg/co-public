import { ZodError } from "zod";
import { registerDevice } from "../../../../lib/device-registration";
import { requireUser } from "../../../../lib/supabase-admin";

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json(await registerDevice(admin, user.id, await request.json()), { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof ZodError) return Response.json({ error: "invalid_device" }, { status: 400 });
    return Response.json({ error: "device_registration_failed" }, { status: 409 });
  }
}
