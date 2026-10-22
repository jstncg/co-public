import { NextResponse } from "next/server";
import { requireFounder } from "../../../../lib/founder-auth";
import { createAdminClient } from "../../../../lib/supabase-admin";

export async function GET(request: Request) {
  try {
    requireFounder(request);
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("founder_weekly_metrics", { report_end: new Date().toISOString() });
    if (error) throw error;
    return NextResponse.json({ metrics: data });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "metrics unavailable" }, { status: 400 });
  }
}
