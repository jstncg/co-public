import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.110.7"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const corsHeaders = {
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-origin": "*",
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}

function json(body: Json, status = 200) {
  return Response.json(body, { status, headers: corsHeaders })
}

function required(name: string) {
  const value = Deno.env.get(name)?.trim()
  if (!value) throw new HttpError(503, "service_not_configured")
  return value
}

function activeRail() {
  const provider = Deno.env.get("CO_RAIL")?.trim().toLowerCase() || "sendblue"
  if (provider !== "sendblue" && provider !== "linq") {
    throw new HttpError(503, "service_not_configured")
  }
  return provider
}

function railFromNumber() {
  return activeRail() === "linq" ? Deno.env.get("LINQ_FROM_NUMBER") : Deno.env.get("SENDBLUE_FROM_NUMBER")
}

async function hmac(secret: string, value: string) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function routePath(request: Request) {
  const pathname = new URL(request.url).pathname
  const marker = "/co-api"
  const index = pathname.indexOf(marker)
  return index >= 0 ? pathname.slice(index + marker.length) || "/" : pathname
}

async function currentUser(request: Request, admin: SupabaseClient) {
  const authorization = request.headers.get("authorization")
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "unauthorized")
  const { data, error } = await admin.auth.getUser(authorization.slice("Bearer ".length))
  if (error || !data.user) throw new HttpError(401, "unauthorized")
  return data.user
}

async function currentMemberId(admin: SupabaseClient, appUserId: string) {
  const result = await admin.rpc("resolve_transport_app_member", {
    p_app_user_id: appUserId,
  })
  if (result.error || typeof result.data !== "string") {
    throw new Error(`member resolution: ${result.error?.message ?? "invalid member"}`)
  }
  return result.data
}

async function currentMemberContext(admin: SupabaseClient, appUserId: string) {
  const result = await admin.rpc("transport_app_member_context", {
    p_app_user_id: appUserId,
  })
  if (result.error) throw new Error(`member context: ${result.error.message}`)
  const row = Array.isArray(result.data) ? result.data[0] : result.data
  if (!row?.member_user_id || !row?.transport_tenant) {
    throw new HttpError(409, "relationship_needs_reverification")
  }
  return { memberId: String(row.member_user_id), tenant: String(row.transport_tenant) }
}

async function phoneStatus(admin: SupabaseClient, appUserId: string) {
  const memberId = await currentMemberId(admin, appUserId)
  const [result, context] = await Promise.all([
    admin.rpc("transport_phone_link_status", { p_user_id: memberId }),
    admin.rpc("transport_app_member_context", { p_app_user_id: appUserId }),
  ])
  if (result.error) throw new Error(`phone status: ${result.error.message}`)
  if (context.error) throw new Error(`member context: ${context.error.message}`)
  const row = Array.isArray(result.data) ? result.data[0] : result.data
  const contextRow = Array.isArray(context.data) ? context.data[0] : context.data
  const handoffNumber = Deno.env.get("CO_MESSAGE_HANDOFF_NUMBER") ?? railFromNumber() ?? null

  // The member's RAIL world — where their actual relationship lives (conversations,
  // catches, rooms). Without this the phone-verified app read only the V2 store and a
  // member with months of history saw empty screens. Slug mirrors the rail's wrapped.py:
  // HMAC(secret, "wrapped:"+tenant), first 20 hex chars. The app probes the URL before
  // adopting it, so a secret mismatch degrades to the old behavior instead of breaking.
  let worldURL: string | null = null
  const tenant = contextRow?.transport_tenant ? String(contextRow.transport_tenant) : null
  const slugSecret = Deno.env.get("CO_RAIL_SLUG_SECRET")?.trim()
  const railBase = Deno.env.get("CO_RAIL_PUBLIC_URL")?.trim()
  if (tenant && slugSecret && railBase) {
    const slug = (await hmac(slugSecret, `wrapped:${tenant}`)).slice(0, 20)
    worldURL = `${railBase.replace(/\/hook(?:\/.*)?$/, "").replace(/\/$/, "")}/w/${slug}`
  }

  return {
    linked: Boolean(row) && Boolean(contextRow?.transport_tenant),
    phoneLast4: row?.phone_last4 ?? null,
    verifiedAt: row?.verified_at ?? null,
    handoffNumber,
    worldURL,
  }
}

async function requestPhoneLink(admin: SupabaseClient, userId: string, request: Request) {
  const body = await request.json().catch(() => ({})) as { phoneNumber?: unknown }
  const phoneNumber = typeof body.phoneNumber === "string" ? body.phoneNumber.trim() : ""
  if (!/^\+[1-9][0-9]{7,14}$/.test(phoneNumber)) {
    throw new HttpError(400, "invalid_phone_link_request")
  }

  const mappingPepper = required("CO_PHONE_MAPPING_PEPPER")
  const challengeSecret = required("CO_PHONE_LINK_CHALLENGE_SECRET")
  const provider = activeRail()
  const fromNumber = required(provider === "linq" ? "LINQ_FROM_NUMBER" : "SENDBLUE_FROM_NUMBER")
  const challengeId = crypto.randomUUID()
  const random = crypto.getRandomValues(new Uint32Array(1))[0]
  const code = (random % 1_000_000).toString().padStart(6, "0")
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
  const phoneHash = await hmac(mappingPepper, phoneNumber)
  const codeHash = await hmac(challengeSecret, `${challengeId}:${code}`)

  const begun = await admin.rpc("begin_transport_phone_link", {
    p_challenge_id: challengeId,
    p_user_id: userId,
    p_phone_hash: phoneHash,
    p_phone_last4: phoneNumber.slice(-4),
    p_code_hash: codeHash,
    p_expires_at: expiresAt,
  })
  if (begun.error) {
    if (begun.error.message.toLowerCase().includes("rate limit")) {
      throw new HttpError(429, "rate_limited")
    }
    throw new Error(`phone challenge: ${begun.error.message}`)
  }

  let delivered = false
  try {
    const content = `your co verification code is ${code}\nit expires in 5 minutes`
    const response = provider === "linq"
      ? await fetch("https://api.linqapp.com/api/partner/v3/chats", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${required("LINQ_API_KEY")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: fromNumber,
          to: [phoneNumber],
          message: {
            idempotency_key: `phone-link:${challengeId}`,
            parts: [{ type: "text", value: content }],
          },
        }),
        redirect: "error",
      })
      : await fetch("https://api.sendblue.com/api/send-message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sb-api-key-id": required("SENDBLUE_API_KEY_ID"),
          "sb-api-secret-key": required("SENDBLUE_API_SECRET_KEY"),
        },
        body: JSON.stringify({ number: phoneNumber, from_number: fromNumber, content }),
        redirect: "error",
      })
    delivered = response.ok
  } finally {
    if (!delivered) {
      await admin.rpc("cancel_transport_phone_link", {
        p_challenge_id: challengeId,
        p_user_id: userId,
      })
    }
  }
  if (!delivered) throw new HttpError(503, "phone_link_delivery_failed")

  return { challengeId, expiresAt, phoneLast4: phoneNumber.slice(-4) }
}

async function verifyPhoneLink(admin: SupabaseClient, userId: string, request: Request) {
  const body = await request.json().catch(() => ({})) as {
    challengeId?: unknown
    code?: unknown
    phoneNumber?: unknown
  }
  const challengeId = typeof body.challengeId === "string" ? body.challengeId : ""
  const code = typeof body.code === "string" ? body.code : ""
  const phoneNumber = typeof body.phoneNumber === "string" ? body.phoneNumber.trim() : ""
  if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !/^[0-9]{6}$/.test(code) ||
      !/^\+[1-9][0-9]{7,14}$/.test(phoneNumber)) {
    throw new HttpError(400, "invalid_phone_link_verification")
  }

  const phoneHash = await hmac(required("CO_PHONE_MAPPING_PEPPER"), phoneNumber)
  const founderHandle = Deno.env.get("CO_FOUNDER_HANDLE")?.replace(/[^0-9]/g, "")
  const tenant = founderHandle && phoneNumber.slice(1) === founderHandle
    ? Deno.env.get("CO_FOUNDER_TENANT")?.trim() || "dennis"
    : `p${phoneNumber.slice(1)}`

  const result = await admin.rpc("verify_transport_app_link", {
    p_challenge_id: challengeId,
    p_app_user_id: userId,
    p_code_hash: await hmac(required("CO_PHONE_LINK_CHALLENGE_SECRET"), `${challengeId}:${code}`),
    p_verified_at: new Date().toISOString(),
    p_phone_hash: phoneHash,
    p_transport_tenant: tenant,
  })
  if (result.error) {
    throw new Error(`phone verification: ${result.error.message}`)
  }
  if (typeof result.data !== "string") throw new HttpError(422, "invalid_or_expired_code")
  // Provision now — the app probes worldURL seconds after this response. Best-effort: a rail
  // hiccup must not fail the verify; the next launch re-probes.
  await postRailOnboarding(tenant, {}).catch(() => null)
  return { linked: true }
}

// One door to the rail's provision/seed endpoint — verify sends empty answers, the intake real ones.
async function postRailOnboarding(tenant: string, answers: Record<string, string>) {
  const railBase = required("CO_RAIL_PUBLIC_URL").replace(/\/hook(?:\/.*)?$/, "").replace(/\/$/, "")
  return await fetch(`${railBase}/api/app/onboarding`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${Deno.env.get("CO_APP_RAIL_TOKEN")?.trim() || required("CO_RAIL_SLUG_SECRET")}`,
    },
    body: JSON.stringify({ tenant, answers }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  })
}

// The intake's answers → the member's graph on the rail (the warm start). The tenant comes
// from the caller's verified binding — the client never names whose graph gets seeded. The
// pill answers are fixed vocabulary; only `name` is free text, and the rail cleans it again.
async function seedOnboarding(admin: SupabaseClient, appUserId: string, request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const field = (key: string, cap: number) => {
    const value = body[key]
    return typeof value === "string" && value.trim() ? value.trim().slice(0, cap) : undefined
  }
  const answers: Record<string, string> = {}
  const name = field("name", 60)
  if (name) answers.name = name
  const birthday = field("birthday", 10)
  if (birthday && /^\d{4}-\d{2}-\d{2}$/.test(birthday)) answers.birthday = birthday
  for (const key of ["goal", "stuck", "feeling", "commitment", "attribution"]) {
    const value = field(key, 120)
    if (value) answers[key] = value
  }
  if (Object.keys(answers).length === 0) return { seeded: false }

  const context = await currentMemberContext(admin, appUserId)
  const rail = await postRailOnboarding(context.tenant, answers).catch(() => null)
  if (!rail?.ok) throw new HttpError(503, "onboarding_unavailable")
  return { seeded: true }
}

async function chatHistory(admin: SupabaseClient, memberId: string) {
  const result = await admin.from("messages")
    .select("id,direction,text,sent_at,transport")
    .eq("user_id", memberId)
    .in("transport", ["sendblue", "linq", "sms", "app"])
    .not("text", "is", null)
    .order("sent_at", { ascending: false })
    .limit(250)
  if (result.error) throw new Error(`chat history: ${result.error.message}`)
  return {
    messages: (result.data ?? []).reverse().flatMap((message) => {
      const text = typeof message.text === "string" ? message.text.trim() : ""
      return text ? [{
        id: message.id,
        isKyo: message.direction === "outbound",
        text,
        sentAt: message.sent_at,
        transport: message.transport,
      }] : []
    }),
  }
}

async function claimChatRate(admin: SupabaseClient, memberId: string) {
  const policies = [
    { bucket: "native_chat.minute", limit: 20, seconds: 60 },
    { bucket: "native_chat.day", limit: 300, seconds: 86_400 },
  ]
  for (const policy of policies) {
    const result = await admin.rpc("claim_api_rate_limit", {
      p_scope_key: `member:${memberId}`,
      p_bucket: policy.bucket,
      p_limit: policy.limit,
      p_window_seconds: policy.seconds,
      p_now: new Date().toISOString(),
    })
    if (result.error) throw new Error(`chat rate limit: ${result.error.message}`)
    const row = Array.isArray(result.data) ? result.data[0] : result.data
    if (!row?.allowed) throw new HttpError(429, "rate_limited")
  }
}

async function nativeChat(admin: SupabaseClient, appUserId: string, request: Request) {
  const body = await request.json().catch(() => ({})) as { text?: unknown; turnId?: unknown }
  const text = typeof body.text === "string" ? body.text.trim() : ""
  const turnId = typeof body.turnId === "string" ? body.turnId : crypto.randomUUID()
  if (!text || text.length > 20_000 || !/^[0-9a-f-]{36}$/i.test(turnId)) {
    throw new HttpError(400, "invalid_chat_turn")
  }
  const context = await currentMemberContext(admin, appUserId)
  const sentAt = new Date().toISOString()
  const begun = await admin.rpc("begin_app_chat_turn", {
    p_user_id: context.memberId,
    p_turn_id: turnId,
    p_user_text: text,
    p_sent_at: sentAt,
  })
  if (begun.error) {
    if (begun.error.message.toLowerCase().includes("turn text conflict")) {
      throw new HttpError(409, "turn_conflict")
    }
    throw new Error(`begin app chat: ${begun.error.message}`)
  }
  if (typeof begun.data === "string" && begun.data.trim()) {
    return { reply: begun.data.trim(), turnId, sentAt, repliedAt: sentAt, cached: true }
  }
  const claimed = await admin.rpc("claim_app_chat_turn", {
    p_user_id: context.memberId,
    p_turn_id: turnId,
    p_user_text: text,
    p_now: sentAt,
  })
  if (claimed.error) {
    if (claimed.error.message.toLowerCase().includes("turn text conflict")) {
      throw new HttpError(409, "turn_conflict")
    }
    throw new Error(`claim app chat: ${claimed.error.message}`)
  }
  if (claimed.data === "busy") throw new HttpError(409, "turn_in_progress")
  if (claimed.data === "complete") {
    const completed = await admin.rpc("begin_app_chat_turn", {
      p_user_id: context.memberId,
      p_turn_id: turnId,
      p_user_text: text,
      p_sent_at: sentAt,
    })
    if (typeof completed.data === "string" && completed.data.trim()) {
      return { reply: completed.data.trim(), turnId, sentAt, repliedAt: sentAt, cached: true }
    }
    throw new Error("completed app chat has no reply")
  }

  let ownsClaim = true
  try {
    await claimChatRate(admin, context.memberId)
    const railBase = required("CO_RAIL_PUBLIC_URL").replace(/\/hook(?:\/.*)?$/, "").replace(/\/$/, "")
    const rail = await fetch(`${railBase}/api/app/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-co-timezone": request.headers.get("x-co-timezone") || "UTC",
        "authorization": `Bearer ${Deno.env.get("CO_APP_RAIL_TOKEN")?.trim() || required("CO_RAIL_SLUG_SECRET")}`,
      },
      body: JSON.stringify({ tenant: context.tenant, text, turnId }),
      redirect: "error",
      signal: AbortSignal.timeout(200_000),
    }).catch(() => null)
    if (!rail?.ok) throw new HttpError(503, "chat_unavailable")
    const response = await rail.json().catch(() => ({})) as { reply?: unknown }
    const reply = typeof response.reply === "string" ? response.reply.trim() : ""
    if (!reply) throw new HttpError(503, "chat_unavailable")
    const repliedAt = new Date().toISOString()
    const recorded = await admin.rpc("record_app_chat_turn", {
      p_user_id: context.memberId,
      p_turn_id: turnId,
      p_user_text: text,
      p_reply: reply,
      p_sent_at: sentAt,
      p_replied_at: repliedAt,
    })
    if (recorded.error) throw new Error(`record app chat: ${recorded.error.message}`)
    const completed = await admin.rpc("complete_app_chat_turn", {
      p_user_id: context.memberId,
      p_turn_id: turnId,
    })
    if (completed.error) throw new Error(`complete app chat: ${completed.error.message}`)
    ownsClaim = false
    return { reply, turnId, sentAt, repliedAt }
  } finally {
    if (ownsClaim) {
      await admin.rpc("release_app_chat_turn", {
        p_user_id: context.memberId,
        p_turn_id: turnId,
      })
    }
  }
}

async function history(admin: SupabaseClient, userId: string) {
  const result = await admin.from("artifacts")
    .select("id,client_artifact_id,source_type,canonical_url,title,publisher,captured_at,raw_text,transcript,user_note,source_coverage,processing_status")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("captured_at", { ascending: false })
    .limit(250)
  if (result.error) throw new Error(`history: ${result.error.message}`)
  return {
    catches: (result.data ?? []).map((artifact) => ({
      artifactId: artifact.id,
      clientArtifactId: artifact.client_artifact_id,
      sourceType: artifact.source_type,
      canonicalUrl: artifact.canonical_url,
      title: artifact.title,
      publisher: artifact.publisher,
      textPreview: artifact.raw_text ?? artifact.transcript ?? artifact.title ?? artifact.canonical_url,
      userNote: artifact.user_note,
      coverage: artifact.source_coverage,
      processingStatus: artifact.processing_status,
      capturedAt: artifact.captured_at,
    })),
  }
}

async function radar(admin: SupabaseClient, userId: string) {
  const candidates = await admin.from("radar_candidates")
    .select("id,watch_entity_id,world_event_id,why_user,status,total_score,created_at")
    .eq("user_id", userId)
    .in("status", ["inbox", "notified", "opened"])
    .order("created_at", { ascending: false })
    .limit(100)
  if (candidates.error) throw new Error(`radar candidates: ${candidates.error.message}`)
  const rows = candidates.data ?? []
  if (rows.length === 0) return { items: [] }

  const eventIds = [...new Set(rows.map((row) => row.world_event_id))]
  const watchIds = [...new Set(rows.map((row) => row.watch_entity_id))]
  const [events, watches] = await Promise.all([
    admin.from("world_events")
      .select("id,event_type,title,summary,canonical_url,published_at,source_trust")
      .in("id", eventIds),
    admin.from("watch_entities")
      .select("id,display_name,entity_type")
      .eq("user_id", userId)
      .in("id", watchIds),
  ])
  if (events.error) throw new Error(`radar events: ${events.error.message}`)
  if (watches.error) throw new Error(`radar watches: ${watches.error.message}`)
  const eventById = new Map((events.data ?? []).map((event) => [event.id, event]))
  const watchById = new Map((watches.data ?? []).map((watch) => [watch.id, watch]))
  return {
    items: rows.flatMap((candidate) => {
      const event = eventById.get(candidate.world_event_id)
      const watch = watchById.get(candidate.watch_entity_id)
      return event && watch ? [{
        id: candidate.id,
        title: event.title,
        summary: event.summary,
        url: event.canonical_url,
        publishedAt: event.published_at,
        eventType: event.event_type,
        sourceTrust: event.source_trust,
        whyYou: candidate.why_user,
        status: candidate.status,
        score: candidate.total_score,
        watchName: watch.display_name,
      }] : []
    }),
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
  try {
    const supabaseURL = required("SUPABASE_URL")
    const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY")
    const admin = createClient(supabaseURL, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const path = routePath(request)
    if (request.method === "GET" && path === "/health") return json({ ok: true })
    const user = await currentUser(request, admin)

    if (request.method === "GET" && path === "/api/v1/phone-link") {
      return json(await phoneStatus(admin, user.id))
    }
    if (request.method === "POST" && path === "/api/v1/phone-link/request") {
      return json(await requestPhoneLink(admin, user.id, request), 201)
    }
    if (request.method === "POST" && path === "/api/v1/phone-link/verify") {
      return json(await verifyPhoneLink(admin, user.id, request))
    }
    if (request.method === "POST" && path === "/api/v1/onboarding") {
      return json(await seedOnboarding(admin, user.id, request))
    }
    if (request.method === "GET" && path === "/api/v1/history") {
      return json(await history(admin, await currentMemberId(admin, user.id)))
    }
    if (request.method === "GET" && path === "/api/v1/chat/history") {
      return json(await chatHistory(admin, await currentMemberId(admin, user.id)))
    }
    if (request.method === "POST" && path === "/api/v1/chat") {
      return json(await nativeChat(admin, user.id, request))
    }
    if (request.method === "GET" && path === "/api/v1/radar") {
      return json(await radar(admin, await currentMemberId(admin, user.id)))
    }
    throw new HttpError(404, "not_found")
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code }, error.status)
    console.error(error instanceof Error ? error.message : "unknown co-api failure")
    return json({ error: "service_unavailable" }, 503)
  }
})
