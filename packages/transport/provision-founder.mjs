// idempotent founder provisioning for the local dual-write target (goal.md §10.4, docs/ingest-contract.md).
// re-run after ANY `supabase db reset` — the live mirror 404s (and spools, losing nothing) until this runs.
// usage: SRK=<service_role_key> node scripts/provision-founder.mjs <phone_e164> <pepper>
// run from a workspace dir that has @supabase/supabase-js (e.g. packages/transport).
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";

const [, , phone, pepper] = process.argv;
if (!phone || !pepper || pepper.length < 32) throw new Error("usage: SRK=... node provision-founder.mjs <phone> <pepper(>=32)>");
const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const sb = createClient(url, process.env.SRK, { auth: { persistSession: false } });

const email = "founder@co.local";
const { data: users, error: lu } = await sb.auth.admin.listUsers();
if (lu) throw lu;
let user = users.users.find((u) => u.email === email);
if (!user) {
  const r = await sb.auth.admin.createUser({ email, email_confirm: true });
  if (r.error) throw r.error;
  user = r.data.user;
}
const { error: pe } = await sb.from("profiles").upsert({ id: user.id, timezone: "America/Los_Angeles", city: "Los Angeles", register: "direct" });
if (pe) console.log("profile note:", pe.message);
const hash = createHmac("sha256", pepper).update(phone).digest("hex");
const { error: le } = await sb.rpc("link_verified_transport_phone", {
  p_user_id: user.id,
  p_phone_hash: hash,
  p_phone_last4: phone.slice(-4),
  p_verified_at: new Date().toISOString(),
});
if (le) throw le;
console.log("provisioned founder", user.id, "phone_last4", phone.slice(-4));
