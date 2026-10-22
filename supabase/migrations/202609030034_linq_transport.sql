-- Linq is a transport peer, not a second relationship store. Keep the original Sendblue rows and
-- functions intact while allowing new Linq conversations to use the same tenant, idempotency,
-- artifact, receipt, and delivery-state contracts.

alter table public.conversations drop constraint conversations_transport_check;
alter table public.conversations add constraint conversations_transport_check
  check (transport in ('sendblue','linq','sms','app'));

alter table public.messages drop constraint messages_transport_check;
alter table public.messages add constraint messages_transport_check
  check (transport in ('sendblue','linq','sms','app'));

create or replace function public.ingest_transport_message(
  p_phone_hash text,
  p_transport text,
  p_external_thread_id text,
  p_idempotency_key text,
  p_external_message_id text,
  p_dedup_sig text,
  p_direction text,
  p_text text,
  p_media_urls text[],
  p_sent_at timestamptz,
  p_reply_to_external_id text,
  p_transport_metadata jsonb,
  p_artifacts jsonb
) returns table (message_id uuid, deduped boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_user_id uuid;
  target_conversation_id uuid;
  target_message_id uuid;
  target_reply_id uuid;
  artifact_item jsonb;
  artifact_index integer;
  new_artifact_id uuid;
  linked_artifact_ids uuid[] := '{}';
begin
  if p_phone_hash !~ '^[a-f0-9]{64}$'
     or p_transport not in ('sendblue','linq','sms','app')
     or p_direction not in ('inbound','outbound')
     or length(p_external_thread_id) not between 1 and 512
     or length(p_idempotency_key) not between 1 and 240
     or cardinality(coalesce(p_media_urls, '{}')) > 8
     or jsonb_typeof(coalesce(p_transport_metadata, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_artifacts, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_artifacts, '[]'::jsonb)) > 8 then
    raise exception 'invalid transport envelope';
  end if;
  if p_external_message_id is null and p_dedup_sig is null then
    raise exception 'transport message requires an external id or dedup signature';
  end if;

  select mapping.user_id into target_user_id
  from private.phone_mappings mapping where mapping.phone_hash = p_phone_hash;
  if not found then raise exception 'unknown transport tenant'; end if;

  insert into public.conversations (user_id, transport, external_thread_id)
  values (target_user_id, p_transport, p_external_thread_id)
  on conflict (user_id, transport, external_thread_id)
  do update set external_thread_id = excluded.external_thread_id
  returning id into target_conversation_id;

  if p_reply_to_external_id is not null then
    select id into target_reply_id from public.messages
    where user_id = target_user_id and transport = p_transport
      and external_message_id = p_reply_to_external_id;
  end if;

  insert into public.messages (
    conversation_id, user_id, transport, idempotency_key, external_message_id, dedup_sig,
    direction, text, media_urls, sent_at, reply_to_message_id, transport_metadata
  ) values (
    target_conversation_id, target_user_id, p_transport, p_idempotency_key,
    p_external_message_id, p_dedup_sig, p_direction, p_text, coalesce(p_media_urls, '{}'),
    p_sent_at, target_reply_id, coalesce(p_transport_metadata, '{}'::jsonb)
  ) on conflict do nothing
  returning id into target_message_id;

  if target_message_id is null then
    select id into target_message_id from public.messages
    where user_id = target_user_id and idempotency_key = p_idempotency_key;
    if target_message_id is null and p_external_message_id is not null then
      select id into target_message_id from public.messages
      where user_id = target_user_id and transport = p_transport
        and external_message_id = p_external_message_id;
    end if;
    if target_message_id is null then raise exception 'transport deduplication conflict'; end if;
    return query select target_message_id, true;
    return;
  end if;

  for artifact_item, artifact_index in
    select value, ordinal::integer
    from jsonb_array_elements(coalesce(p_artifacts, '[]'::jsonb)) with ordinality as item(value, ordinal)
  loop
    if coalesce(artifact_item ->> 'canonical_url', '') = ''
       and coalesce(artifact_item ->> 'extraction', '') = '' then
      raise exception 'transport artifact requires a URL or extraction';
    end if;
    insert into public.artifacts (
      user_id, client_artifact_id, idempotency_key, source_type, source_app, canonical_url,
      captured_at, raw_text, timestamp_seconds, retention_mode, sensitivity,
      source_coverage, analysis_allowed, processing_status
    ) values (
      target_user_id, extensions.gen_random_uuid(),
      format('transport:%s:%s', target_message_id, artifact_index),
      artifact_item ->> 'source_type', p_transport, nullif(artifact_item ->> 'canonical_url', ''),
      p_sent_at, nullif(artifact_item ->> 'extraction', ''),
      nullif(artifact_item ->> 'timestamp_seconds', '')::numeric,
      'default', 'unknown', artifact_item ->> 'coverage', true, 'queued'
    ) returning id into new_artifact_id;
    linked_artifact_ids := array_append(linked_artifact_ids, new_artifact_id);
    insert into public.message_artifacts (message_id, artifact_id, user_id)
    values (target_message_id, new_artifact_id, target_user_id);
    if nullif(artifact_item ->> 'canonical_url', '') is not null then
      insert into public.source_receipts (
        user_id, artifact_id, canonical_url, coverage, provider_metadata
      ) values (
        target_user_id, new_artifact_id, artifact_item ->> 'canonical_url',
        artifact_item ->> 'coverage',
        jsonb_build_object('adapter', p_transport, 'adapter_version', 'transport-ingest.v1')
      );
    end if;
  end loop;

  if cardinality(linked_artifact_ids) > 0 then
    update public.messages set artifact_ids = linked_artifact_ids where id = target_message_id;
  end if;
  return query select target_message_id, false;
end;
$$;

create or replace function public.apply_transport_status(
  p_phone_hash text,
  p_transport text,
  p_external_message_id text,
  p_status text,
  p_at timestamptz,
  p_error_code text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare target_user_id uuid; target_message_id uuid;
begin
  if p_phone_hash !~ '^[a-f0-9]{64}$'
     or p_transport not in ('sendblue','linq','sms','app')
     or p_status not in ('SENT','DELIVERED','READ','ERROR')
     or length(p_external_message_id) not between 1 and 512
     or (p_error_code is not null and p_error_code !~ '^[A-Za-z0-9_.-]{1,80}$') then
    raise exception 'invalid transport status';
  end if;
  select mapping.user_id into target_user_id
  from private.phone_mappings mapping where mapping.phone_hash = p_phone_hash;
  if not found then raise exception 'unknown transport tenant'; end if;
  select id into target_message_id from public.messages
  where user_id = target_user_id and transport = p_transport
    and external_message_id = p_external_message_id for update;
  if not found then return null; end if;

  update public.messages set
    delivered_at = case when p_status in ('DELIVERED','READ') then coalesce(delivered_at, p_at) else delivered_at end,
    read_at = case when p_status = 'READ' then coalesce(read_at, p_at) else read_at end,
    transport_metadata = case when p_status = 'ERROR' then transport_metadata || jsonb_strip_nulls(
      jsonb_build_object('delivery_error_at', p_at, 'error_code', p_error_code)
    ) else transport_metadata end
  where id = target_message_id;
  return target_message_id;
end;
$$;
