-- One relationship, two surfaces
--
-- The verified app session retains the opaque rail tenant needed to reach the same
-- engine as iMessage, while canonical messages remain the source of truth rendered
-- by the native app chat

alter table private.app_member_links
  add column transport_tenant text
  check (transport_tenant is null or transport_tenant ~ '^[a-z][a-z0-9_-]{0,63}$');

create or replace function public.verify_transport_app_link(
  p_challenge_id uuid,
  p_app_user_id uuid,
  p_code_hash text,
  p_verified_at timestamptz,
  p_phone_hash text,
  p_transport_tenant text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  challenge private.transport_phone_link_challenges%rowtype;
  member_user_id uuid;
begin
  if p_code_hash !~ '^[a-f0-9]{64}$'
     or p_phone_hash !~ '^[a-f0-9]{64}$'
     or p_transport_tenant !~ '^[a-z][a-z0-9_-]{0,63}$'
     or p_verified_at < now() - interval '2 minutes'
     or p_verified_at > now() + interval '2 minutes' then
    raise exception 'invalid phone-link verification';
  end if;

  select * into challenge
  from private.transport_phone_link_challenges
  where id = p_challenge_id and user_id = p_app_user_id
  for update;
  if not found or challenge.consumed_at is not null
     or challenge.expires_at < p_verified_at or challenge.attempts >= 5 then
    return null;
  end if;

  update private.transport_phone_link_challenges
  set attempts = attempts + 1
  where id = p_challenge_id;
  if challenge.code_hash <> p_code_hash or challenge.phone_hash <> p_phone_hash then
    return null;
  end if;

  select mapping.user_id into member_user_id
  from private.phone_mappings mapping
  where mapping.phone_hash = challenge.phone_hash
  for update;

  if not found then
    member_user_id := p_app_user_id;
    delete from private.phone_mappings
    where user_id = member_user_id and phone_hash <> challenge.phone_hash;
    insert into private.phone_mappings (phone_hash, phone_last4, user_id, verified_at)
    values (challenge.phone_hash, challenge.phone_last4, member_user_id, p_verified_at);
  else
    update private.phone_mappings
    set phone_last4 = challenge.phone_last4,
        verified_at = greatest(verified_at, p_verified_at)
    where phone_hash = challenge.phone_hash;
  end if;

  insert into private.app_member_links (
    app_user_id, member_user_id, phone_hash, transport_tenant, verified_at
  ) values (
    p_app_user_id, member_user_id, challenge.phone_hash, p_transport_tenant, p_verified_at
  )
  on conflict (app_user_id) do update set
    member_user_id = excluded.member_user_id,
    phone_hash = excluded.phone_hash,
    transport_tenant = excluded.transport_tenant,
    verified_at = excluded.verified_at,
    updated_at = now();

  update private.transport_phone_link_challenges
  set consumed_at = p_verified_at
  where id = p_challenge_id;

  insert into public.audit_events (
    user_id, actor_type, actor_id, action, resource_type, resource_id, purpose, metadata
  ) values (
    member_user_id, 'user', p_app_user_id::text, 'transport.app_member_link',
    'profile', member_user_id::text, 'verified_relationship_handoff',
    jsonb_build_object('phone_last4', challenge.phone_last4, 'native_chat', true)
  );

  return member_user_id;
end;
$$;

create or replace function public.transport_app_member_context(p_app_user_id uuid)
returns table (member_user_id uuid, transport_tenant text)
language sql
security definer
stable
set search_path = ''
as $$
  select link.member_user_id, link.transport_tenant
  from private.app_member_links link
  where link.app_user_id = p_app_user_id;
$$;

create or replace function public.record_app_chat_turn(
  p_user_id uuid,
  p_turn_id uuid,
  p_user_text text,
  p_reply text,
  p_sent_at timestamptz,
  p_replied_at timestamptz
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_conversation_id uuid;
  inbound_id uuid;
begin
  if length(trim(p_user_text)) not between 1 and 20000
     or length(trim(p_reply)) not between 1 and 200000
     or p_replied_at < p_sent_at
     or p_sent_at < now() - interval '10 minutes'
     or p_replied_at > now() + interval '2 minutes' then
    raise exception 'invalid app chat turn';
  end if;

  insert into public.conversations (user_id, transport, external_thread_id)
  values (p_user_id, 'app', 'native')
  on conflict (user_id, transport, external_thread_id)
  do update set external_thread_id = excluded.external_thread_id
  returning id into target_conversation_id;

  insert into public.messages (
    conversation_id, user_id, transport, idempotency_key, external_message_id,
    direction, text, sent_at, transport_metadata
  ) values (
    target_conversation_id, p_user_id, 'app', 'app:' || p_turn_id || ':in',
    'app:' || p_turn_id || ':in', 'inbound', trim(p_user_text), p_sent_at,
    jsonb_build_object('surface', 'ios')
  )
  on conflict (user_id, idempotency_key) do update set
    text = excluded.text
  returning id into inbound_id;

  insert into public.messages (
    conversation_id, user_id, transport, idempotency_key, external_message_id,
    direction, text, sent_at, reply_to_message_id, transport_metadata
  ) values (
    target_conversation_id, p_user_id, 'app', 'app:' || p_turn_id || ':out',
    'app:' || p_turn_id || ':out', 'outbound', trim(p_reply), p_replied_at,
    inbound_id, jsonb_build_object('surface', 'ios')
  )
  on conflict (user_id, idempotency_key) do nothing;
end;
$$;

revoke all on function public.verify_transport_app_link(uuid,uuid,text,timestamptz,text,text)
  from public, anon, authenticated;
grant execute on function public.verify_transport_app_link(uuid,uuid,text,timestamptz,text,text)
  to service_role;
revoke all on function public.transport_app_member_context(uuid)
  from public, anon, authenticated;
grant execute on function public.transport_app_member_context(uuid) to service_role;
revoke all on function public.record_app_chat_turn(uuid,uuid,text,text,timestamptz,timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_app_chat_turn(uuid,uuid,text,text,timestamptz,timestamptz)
  to service_role;
