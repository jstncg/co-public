import { NextResponse } from "next/server";
import { createAccountExport } from "../../../../lib/account-export";
import { enforceUserRateLimit } from "../../../../lib/rate-limit";
import { requireUser } from "../../../../lib/supabase-admin";

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    await enforceUserRateLimit(admin, user.id, { bucket: "account.export", limit: 3, windowSeconds: 86_400 });
    return NextResponse.json(await createAccountExport(admin, user.id));
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "export failed" }, { status: 500 });
  }
}
