import { NextResponse } from "next/server";
import { deleteAccount, type AccountDeletionAdmin } from "../../../../lib/account-deletion";
import { requireUser } from "../../../../lib/supabase-admin";

export async function DELETE(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    const result = await deleteAccount(admin as unknown as AccountDeletionAdmin, user.id);
    return NextResponse.json({ deleted: true, ...result });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "account deletion failed" }, { status: 500 });
  }
}
