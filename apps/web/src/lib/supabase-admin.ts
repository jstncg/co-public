import { createClient } from "@supabase/supabase-js";
import { serverEnvironment } from "./server-env";

export function createAdminClient() {
  const environment = serverEnvironment();
  return createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function requireUser(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new Response("unauthorized", { status: 401 });
  const token = authorization.slice("Bearer ".length);
  const admin = createAdminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new Response("unauthorized", { status: 401 });
  return { admin, user: data.user };
}

