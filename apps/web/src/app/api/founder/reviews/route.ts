import { NextResponse } from "next/server";
import { requireFounder } from "../../../../lib/founder-auth";
import { decideFounderReview, listFounderReviews, type FounderDatabase } from "../../../../lib/founder-review";
import { createAdminClient } from "../../../../lib/supabase-admin";

function responseError(error: unknown) {
  if (error instanceof Response) return error;
  const message = error instanceof Error ? error.message : "founder review failed";
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(request: Request) {
  try {
    const founder = requireFounder(request);
    const reviews = await listFounderReviews(createAdminClient() as unknown as FounderDatabase, founder.reviewerId);
    return NextResponse.json({ reviews });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    const founder = requireFounder(request);
    const result = await decideFounderReview(
      createAdminClient() as unknown as FounderDatabase,
      founder.reviewerId,
      await request.json(),
    );
    return NextResponse.json({ result });
  } catch (error) {
    return responseError(error);
  }
}
