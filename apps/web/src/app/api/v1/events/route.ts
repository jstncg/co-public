import { recordProductEvent, type AnalyticsDatabase } from "@co/analytics";
import { NextResponse } from "next/server";
import { requireUser } from "../../../../lib/supabase-admin";

export async function POST(request: Request) {
  try {
    const { admin, user } = await requireUser(request);
    const event = await recordProductEvent(admin as unknown as AnalyticsDatabase, user.id, await request.json());
    return NextResponse.json({ accepted: true, name: event.name }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "invalid product event" }, { status: 400 });
  }
}
