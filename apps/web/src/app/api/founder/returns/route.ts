import { NextResponse } from "next/server";
import { requireFounder } from "../../../../lib/founder-auth";
import { decideReturnReview, listReturnReviews } from "../../../../lib/return-review";
import { createAdminClient } from "../../../../lib/supabase-admin";

export async function GET(request: Request) {
  try {
    const founder = requireFounder(request);
    return NextResponse.json({ returns: await listReturnReviews(createAdminClient(), founder.reviewerId) });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "return review failed" }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const founder = requireFounder(request);
    return NextResponse.json(await decideReturnReview(createAdminClient(), founder.reviewerId, await request.json()));
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: error instanceof Error ? error.message : "return review failed" }, { status: 400 });
  }
}
