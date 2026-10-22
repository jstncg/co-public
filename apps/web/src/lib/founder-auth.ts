import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const founderEnvironmentSchema = z.object({
  FEATURE_FOUNDER_REVIEW: z.enum(["true", "false"]).default("false"),
  FOUNDER_ACCESS_TOKEN: z.string().min(32),
  FOUNDER_REVIEWER_ID: z.string().min(1),
});

export type FounderIdentity = { reviewerId: string };

export function requireFounder(
  request: Request,
  environment: Record<string, string | undefined> = process.env,
): FounderIdentity {
  if (environment.FEATURE_FOUNDER_REVIEW !== "true") {
    throw new Response("founder review is disabled", { status: 404 });
  }

  const parsed = founderEnvironmentSchema.safeParse(environment);
  if (!parsed.success) throw new Response("founder review is not configured", { status: 503 });

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new Response("unauthorized", { status: 401 });

  const supplied = createHash("sha256").update(authorization.slice(7)).digest();
  const expected = createHash("sha256").update(parsed.data.FOUNDER_ACCESS_TOKEN).digest();
  if (!timingSafeEqual(supplied, expected)) throw new Response("unauthorized", { status: 401 });

  return { reviewerId: parsed.data.FOUNDER_REVIEWER_ID };
}
