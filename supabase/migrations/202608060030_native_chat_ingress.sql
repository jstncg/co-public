-- A native turn exists before inference and can never execute under two meanings

create or replace function public.begin_app_chat_turn(
  p_user_id uuid,
  p_turn_id uuid,
  p_user_text text,
  p_sent_at timestamptz
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_conversation_id uuid;
  existing_text text;
  cached_reply text;
begin
  if length(trim(p_user_text)) not between 1 and 20000
     or p_sent_at < now() - interval '10 minutes'
     or p_sent_at > now() + interval '2 minutes' then
    raise exception 'invalid app chat turn';
  end if;

  insert into public.conversations (user_id, transport, external_thread_id)
  values (p_user_id, 'app', 'native')
  on conflict (user_id, transport, external_thread_id)
  do update set external_thread_id = excluded.external_thread_id
  returning id into target_conversation_id;

  select message.text into existing_text
  from public.messages message
  where message.user_id = p_user_id
    and message.idempotency_key = 'app:' || p_turn_id || ':in';

  if found and trim(existing_text) <> trim(p_user_text) then
    raise exception 'turn text conflict';
  end if;

  insert into public.messages (
    conversation_id, user_id, transport, idempotency_key, external_message_id,
    direction, text, sent_at, transport_metadata
  ) values (
    target_conversation_id, p_user_id, 'app', 'app:' || p_turn_id || ':in',
    'app:' || p_turn_id || ':in', 'inbound', trim(p_user_text), p_sent_at,
    jsonb_build_object('surface', 'ios', 'state', 'received')
  ) on conflict (user_id, idempotency_key) do nothing;

  select message.text into cached_reply
  from public.messages message
  where message.user_id = p_user_id
    and message.idempotency_key = 'app:' || p_turn_id || ':out';

  return cached_reply;
end;
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
  if length(trim(p_reply)) not between 1 and 200000
     or p_replied_at < p_sent_at
     or p_replied_at > now() + interval '2 minutes' then
    raise exception 'invalid app chat reply';
  end if;

  perform public.begin_app_chat_turn(p_user_id, p_turn_id, p_user_text, p_sent_at);

  select message.conversation_id, message.id
    into target_conversation_id, inbound_id
  from public.messages message
  where message.user_id = p_user_id
    and message.idempotency_key = 'app:' || p_turn_id || ':in';

  insert into public.messages (
    conversation_id, user_id, transport, idempotency_key, external_message_id,
    direction, text, sent_at, reply_to_message_id, transport_metadata
  ) values (
    target_conversation_id, p_user_id, 'app', 'app:' || p_turn_id || ':out',
    'app:' || p_turn_id || ':out', 'outbound', trim(p_reply), p_replied_at,
    inbound_id, jsonb_build_object('surface', 'ios', 'state', 'complete')
  ) on conflict (user_id, idempotency_key) do nothing;
end;
$$;

revoke all on function public.begin_app_chat_turn(uuid,uuid,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.begin_app_chat_turn(uuid,uuid,text,timestamptz)
  to service_role;
