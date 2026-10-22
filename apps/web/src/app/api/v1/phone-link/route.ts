import { getPhoneLinkStatus, unlinkPhone } from "../../../../lib/phone-link-service";
import { requireUser } from "../../../../lib/supabase-admin";

export async function GET(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json(await getPhoneLinkStatus(admin, user.id));
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "phone_link_status_failed" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    return Response.json(await unlinkPhone(admin, user.id));
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "phone_unlink_failed" }, { status: 500 });
  }
}

