import { z } from "zod";

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  FOUNDER_ACCESS_TOKEN: z.string().min(32).optional(),
  FOUNDER_REVIEWER_ID: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(20).optional(),
  MODEL_FAST: z.string().optional(),
  MODEL_VISION: z.string().optional(),
  GOOGLE_CONNECTOR_UID: z.string().min(3).optional(),
  GMAIL_PUBSUB_TOPIC: z.string().min(3).optional(),
  GMAIL_PUSH_AUDIENCE: z.url().optional(),
  GMAIL_PUSH_SERVICE_ACCOUNT: z.email().optional(),
}).passthrough();

export function serverEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  return schema.parse(environment);
}
