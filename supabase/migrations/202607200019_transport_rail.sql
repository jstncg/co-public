-- Rev 3 continuity seam. The receiver stores the live rail without sending, replying, or changing
-- user-visible behavior. Phone numbers are HMACed by the server before they reach Postgres.

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  transport text not null check (transport in ('sendblue','sms','app')),
  external_thread_id text not null check (length(external_thread_id) between 1 and 512),
  created_at timestamptz not null default now(),
  unique (user_id, transport, external_thread_id),
  unique (id, user_id, transport)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  transport text not null check (transport in ('sendblue','sms','app')),
  idempotency_key text not null check (length(idempotency_key) between 1 and 240),
  external_message_id text check (external_message_id is null or length(external_message_id) between 1 and 512),
  dedup_sig text check (dedup_sig is null or dedup_sig ~ '^[a-f0-9]{64}$'),
  direction text not null check (direction in ('inbound','outbound')),
  text text check (text is null or length(text) <= 200000),
  media_urls text[] not null default '{}',
  sent_at timestamptz not null,
  delivered_at timestamptz,
  read_at timestamptz,
  reply_to_message_id uuid,
  transport_metadata jsonb not null default '{}'::jsonb,
  artifact_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (conversation_id, user_id, transport)
    references public.conversations(id, user_id, transport) on delete cascade,
  foreign key (reply_to_message_id, user_id)
    references public.messages(id, user_id) on delete set null (reply_to_message_id),
  unique (id, user_id),
  unique (user_id, idempotency_key),
  check (external_message_id is not null or dedup_sig is not null),
  check (cardinality(media_urls) <= 8),
  check (jsonb_typeof(transport_metadata) = 'object')
);
create unique index messages_external_transport_unique
  on public.messages (user_id, transport, external_message_id)
  where external_message_id is not null;
create unique index messages_conversation_dedup_unique
  on public.messages (conversation_id, dedup_sig)
  where dedup_sig is not null;
create index messages_conversation_sent_idx on public.messages (conversation_id, sent_at desc);

alter table public.artifacts add constraint artifacts_id_user_unique unique (id, user_id);

create table public.message_artifacts (
  message_id uuid not null,
  artifact_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, artifact_id),
  foreign key (message_id, user_id) references public.messages(id, user_id) on delete cascade,
  foreign key (artifact_id, user_id) references public.artifacts(id, user_id) on delete cascade
);

create table public.interaction_policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  instruction text not null check (length(trim(instruction)) between 1 and 500),
  scope text not null default 'all' check (length(scope) between 1 and 80),
  exact_receipt uuid,
  status text not null default 'active' check (status in ('active','revoked')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (exact_receipt, user_id) references public.messages(id, user_id) on delete set null (exact_receipt)
);
create index interaction_policies_active_idx on public.interaction_policies (user_id, created_at desc)
  where status = 'active';

create table private.phone_mappings (
  phone_hash text primary key check (phone_hash ~ '^[a-f0-9]{64}$'),
  phone_last4 text not null check (phone_last4 ~ '^[0-9]{4}$'),
  user_id uuid not null references public.profiles(id) on delete cascade,
  verified_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index phone_mappings_user_idx on private.phone_mappings (user_id);
revoke all on table private.phone_mappings from public, anon, authenticated;

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.message_artifacts enable row level security;
alter table public.interaction_policies enable row level security;

create policy conversations_own_read on public.conversations for select to authenticated
  using (user_id = (select auth.uid()));
create policy messages_own_read on public.messages for select to authenticated
  using (user_id = (select auth.uid()));
create policy message_artifacts_own_read on public.message_artifacts for select to authenticated
  using (user_id = (select auth.uid()));
create policy interaction_policies_own on public.interaction_policies for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.conversations, public.messages, public.message_artifacts from anon, authenticated;
grant select on public.conversations, public.messages, public.message_artifacts to authenticated;
revoke all on public.interaction_policies from anon, authenticated;
grant select, insert, update, delete on public.interaction_policies to authenticated;

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
     or p_transport not in ('sendblue','sms','app')
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
     or p_transport not in ('sendblue','sms','app')
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

create or replace function public.link_verified_transport_phone(
  p_user_id uuid,
  p_phone_hash text,
  p_phone_last4 text,
  p_verified_at timestamptz
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_phone_hash !~ '^[a-f0-9]{64}$' or p_phone_last4 !~ '^[0-9]{4}$' then
    raise exception 'invalid verified phone mapping';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'profile unavailable';
  end if;
  insert into private.phone_mappings (phone_hash, phone_last4, user_id, verified_at)
  values (p_phone_hash, p_phone_last4, p_user_id, p_verified_at)
  on conflict (phone_hash) do update set
    phone_last4 = excluded.phone_last4,
    user_id = excluded.user_id,
    verified_at = excluded.verified_at;
end;
$$;

revoke all on function public.ingest_transport_message(text,text,text,text,text,text,text,text,text[],timestamptz,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.ingest_transport_message(text,text,text,text,text,text,text,text,text[],timestamptz,text,jsonb,jsonb) to service_role;
revoke all on function public.apply_transport_status(text,text,text,text,timestamptz,text) from public, anon, authenticated;
grant execute on function public.apply_transport_status(text,text,text,text,timestamptz,text) to service_role;
revoke all on function public.link_verified_transport_phone(uuid,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.link_verified_transport_phone(uuid,text,text,timestamptz) to service_role;

insert into private.feature_flags (key, scope_type, scope_id, value, rollout_note, updated_by)
values
  ('dual_write','global','*','false'::jsonb,'Rev 3 receiver and sender rollout','migration-019'),
  ('imessage_capture','global','*','false'::jsonb,'Rev 3 cohort-controlled messages intake','migration-019'),
  ('hw_arm_assignment','global','*','false'::jsonb,'Hw1/Hw2 entry-arm assignment','migration-019')
on conflict (key, scope_type, scope_id) do nothing;
