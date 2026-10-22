-- ADR 012: Gmail push notifications are wake-up hints. Durable history cursors,
-- a coalescing queue, and idempotent context events provide correctness.

alter table public.context_sources drop constraint if exists context_sources_source_kind_check;
alter table public.context_sources add constraint context_sources_source_kind_check
  check (source_kind in ('messaging','calendar','email'));
alter table public.context_sources drop constraint if exists context_sources_access_mode_check;
alter table public.context_sources add constraint context_sources_access_mode_check
  check (access_mode in ('availability_only','details','metadata_only','snippet'));

alter table public.context_events drop constraint if exists context_events_source_kind_check;
alter table public.context_events add constraint context_events_source_kind_check
  check (source_kind in ('messaging','calendar','email'));
alter table public.context_events drop constraint if exists context_events_event_kind_check;
alter table public.context_events add constraint context_events_event_kind_check
  check (event_kind in (
    'message_received','message_sent','calendar_changed','calendar_deleted',
    'calendar_window_opening','email_received','email_deleted'
  ));
alter table public.context_events drop constraint if exists context_events_resource_type_check;
alter table public.context_events add constraint context_events_resource_type_check
  check (resource_type in ('message','calendar_item','email_item'));

create table public.email_context_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source_id uuid not null references public.context_sources(id) on delete cascade,
  external_message_id text not null check (length(external_message_id) between 1 and 512),
  external_thread_id text not null check (length(external_thread_id) between 1 and 512),
  history_id numeric(40,0) not null check (history_id >= 0),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  internal_date timestamptz not null,
  sender text check (sender is null or length(sender) <= 1000),
  recipients text check (recipients is null or length(recipients) <= 2000),
  cc text check (cc is null or length(cc) <= 2000),
  subject text check (subject is null or length(subject) <= 1000),
  sent_date text check (sent_date is null or length(sent_date) <= 256),
  snippet text check (snippet is null or length(snippet) <= 1000),
  label_ids text[] not null default '{}',
  analysis_allowed boolean not null default true,
  sensitivity text not null default 'medium'
    check (sensitivity in ('unknown','low','medium','high')),
  tombstone boolean not null default false,
  last_seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id,external_message_id)
);
create index email_context_items_user_time_idx
  on public.email_context_items (user_id,internal_date desc)
  where tombstone=false;

create table private.gmail_watch_state (
  source_id uuid primary key references public.context_sources(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  email_address text not null check (
    email_address=lower(email_address) and length(email_address) between 3 and 320
  ),
  watch_expires_at timestamptz not null,
  last_watch_history_id numeric(40,0) not null check (last_watch_history_id >= 0),
  last_notification_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (email_address)
);

create table private.gmail_sync_queue (
  source_id uuid primary key references public.context_sources(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  target_history_id numeric(40,0) not null check (target_history_id >= 0),
  state text not null default 'queued'
    check (state in ('idle','queued','processing','failed')),
  attempts smallint not null default 0 check (attempts between 0 and 10),
  lease_token uuid,
  leased_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_pubsub_message_id text check (
    last_pubsub_message_id is null or length(last_pubsub_message_id) <= 512
  ),
  last_published_at timestamptz,
  last_error_code text check (last_error_code is null or length(last_error_code) <= 120),
  updated_at timestamptz not null default now()
);

revoke all on table private.gmail_watch_state from public,anon,authenticated;
revoke all on table private.gmail_sync_queue from public,anon,authenticated;

create trigger email_context_items_updated before update on public.email_context_items
for each row execute function private.set_updated_at();

create or replace function public.register_gmail_context_source(
  p_user_id uuid,
  p_email_address text,
  p_history_id text,
  p_watch_expires_at timestamptz,
  p_access_mode text default 'snippet'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text := lower(trim(p_email_address));
  source_row public.context_sources;
begin
  if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
     or length(normalized_email)>320
     or p_history_id !~ '^\d{1,40}$'
     or p_access_mode not in ('metadata_only','snippet')
     or p_watch_expires_at<=now() then
    raise exception 'invalid Gmail watch registration';
  end if;

  insert into public.context_sources (
    user_id,source_kind,external_source_id,source_label,access_mode,status,
    sync_cursor,last_synced_at
  ) values (
    p_user_id,'email',normalized_email,'Gmail',p_access_mode,'active',p_history_id,now()
  )
  on conflict (user_id,source_kind,external_source_id) do update set
    source_label='Gmail',access_mode=excluded.access_mode,status='active',
    sync_cursor=coalesce(public.context_sources.sync_cursor,excluded.sync_cursor),
    last_synced_at=coalesce(public.context_sources.last_synced_at,excluded.last_synced_at)
  returning * into source_row;

  insert into private.gmail_watch_state (
    source_id,user_id,email_address,watch_expires_at,last_watch_history_id
  ) values (
    source_row.id,p_user_id,normalized_email,p_watch_expires_at,p_history_id::numeric
  )
  on conflict (source_id) do update set
    email_address=excluded.email_address,
    watch_expires_at=excluded.watch_expires_at,
    last_watch_history_id=excluded.last_watch_history_id,
    updated_at=now();

  update private.gmail_sync_queue set
    state='queued',attempts=0,lease_token=null,leased_at=null,
    next_attempt_at=now(),last_error_code=null,updated_at=now()
  where source_id=source_row.id
    and target_history_id>source_row.sync_cursor::numeric;

  return jsonb_build_object(
    'source_id',source_row.id,
    'email_address',normalized_email,
    'history_id',source_row.sync_cursor,
    'expires_at',p_watch_expires_at
  );
end;
$$;
revoke all on function public.register_gmail_context_source(uuid,text,text,timestamptz,text)
  from public,anon,authenticated;
grant execute on function public.register_gmail_context_source(uuid,text,text,timestamptz,text)
  to service_role;

create or replace function public.renew_gmail_context_watch(
  p_user_id uuid,
  p_source_id uuid,
  p_watch_history_id text,
  p_watch_expires_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_watch_history_id !~ '^\d{1,40}$' or p_watch_expires_at<=now() then
    raise exception 'invalid Gmail watch renewal';
  end if;
  update private.gmail_watch_state set
    watch_expires_at=p_watch_expires_at,
    last_watch_history_id=p_watch_history_id::numeric,
    updated_at=now()
  where source_id=p_source_id and user_id=p_user_id;
  return found;
end;
$$;
revoke all on function public.renew_gmail_context_watch(uuid,uuid,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.renew_gmail_context_watch(uuid,uuid,text,timestamptz)
  to service_role;

create or replace function public.enqueue_gmail_sync(
  p_email_address text,
  p_history_id text,
  p_pubsub_message_id text,
  p_published_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  watch private.gmail_watch_state;
  target numeric(40,0);
begin
  if p_history_id !~ '^\d{1,40}$'
     or length(p_pubsub_message_id) not between 1 and 512 then
    raise exception 'invalid Gmail push notification';
  end if;
  target := p_history_id::numeric;
  select state.* into watch
  from private.gmail_watch_state state
  join public.context_sources source on source.id=state.source_id
  where state.email_address=lower(trim(p_email_address)) and source.status='active';
  if not found then return null; end if;

  update private.gmail_watch_state set last_notification_at=greatest(
    coalesce(last_notification_at,'epoch'::timestamptz),p_published_at
  ),updated_at=now() where source_id=watch.source_id;

  insert into private.gmail_sync_queue (
    source_id,user_id,target_history_id,state,last_pubsub_message_id,last_published_at
  ) values (
    watch.source_id,watch.user_id,target,'queued',p_pubsub_message_id,p_published_at
  )
  on conflict (source_id) do update set
    target_history_id=greatest(private.gmail_sync_queue.target_history_id,excluded.target_history_id),
    state=case when private.gmail_sync_queue.state='processing' then 'processing' else 'queued' end,
    next_attempt_at=case when private.gmail_sync_queue.state='processing'
      then private.gmail_sync_queue.next_attempt_at else now() end,
    last_pubsub_message_id=excluded.last_pubsub_message_id,
    last_published_at=greatest(
      coalesce(private.gmail_sync_queue.last_published_at,'epoch'::timestamptz),
      excluded.last_published_at
    ),
    updated_at=now();

  return jsonb_build_object(
    'accepted',true,'user_id',watch.user_id,'source_id',watch.source_id
  );
end;
$$;
revoke all on function public.enqueue_gmail_sync(text,text,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.enqueue_gmail_sync(text,text,text,timestamptz)
  to service_role;

create or replace function public.list_due_gmail_syncs(p_limit integer default 50)
returns table (user_id uuid,source_id uuid)
language sql
security definer
set search_path = ''
as $$
  select queue.user_id,queue.source_id
  from private.gmail_sync_queue queue
  join public.context_sources source on source.id=queue.source_id
  where source.status='active'
    and queue.attempts<10
    and queue.next_attempt_at<=now()
    and (
      queue.state in ('queued','failed')
      or (queue.state='processing' and queue.leased_at<now()-interval '15 minutes')
    )
  order by queue.next_attempt_at,queue.updated_at
  limit least(greatest(p_limit,1),100);
$$;
revoke all on function public.list_due_gmail_syncs(integer) from public,anon,authenticated;
grant execute on function public.list_due_gmail_syncs(integer) to service_role;

create or replace function public.claim_gmail_sync(
  p_user_id uuid,
  p_source_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue private.gmail_sync_queue;
  source public.context_sources;
  watch private.gmail_watch_state;
  token uuid := gen_random_uuid();
begin
  select * into queue from private.gmail_sync_queue
  where source_id=p_source_id and user_id=p_user_id
    and attempts<10 and next_attempt_at<=now()
    and (
      state in ('queued','failed')
      or (state='processing' and leased_at<now()-interval '15 minutes')
    )
  for update skip locked;
  if not found then return null; end if;
  select * into source from public.context_sources
  where id=p_source_id and user_id=p_user_id and source_kind='email' and status='active';
  if not found or source.sync_cursor is null then return null; end if;
  select * into watch from private.gmail_watch_state
  where source_id=p_source_id and user_id=p_user_id;
  if not found then return null; end if;

  update private.gmail_sync_queue set
    state='processing',attempts=attempts+1,lease_token=token,leased_at=now(),updated_at=now()
  where source_id=p_source_id;
  return jsonb_build_object(
    'user_id',p_user_id,
    'source_id',p_source_id,
    'email_address',watch.email_address,
    'start_history_id',source.sync_cursor,
    'target_history_id',queue.target_history_id::text,
    'lease_token',token
  );
end;
$$;
revoke all on function public.claim_gmail_sync(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_gmail_sync(uuid,uuid) to service_role;

create or replace function public.release_gmail_sync(
  p_user_id uuid,
  p_source_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_retry_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.gmail_sync_queue set
    state='failed',lease_token=null,leased_at=null,next_attempt_at=p_retry_at,
    last_error_code=left(p_error_code,120),updated_at=now()
  where source_id=p_source_id and user_id=p_user_id
    and state='processing' and lease_token=p_lease_token;
  return found;
end;
$$;
revoke all on function public.release_gmail_sync(uuid,uuid,uuid,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.release_gmail_sync(uuid,uuid,uuid,text,timestamptz)
  to service_role;

create or replace function public.pause_gmail_context_source(
  p_user_id uuid,
  p_source_id uuid,
  p_lease_token uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from private.gmail_sync_queue
  where source_id=p_source_id and user_id=p_user_id
    and state='processing' and lease_token=p_lease_token
  for update;
  if not found then return false; end if;
  update public.context_sources set status='paused'
  where id=p_source_id and user_id=p_user_id and source_kind='email';
  if not found then return false; end if;
  update private.gmail_sync_queue set
    state='idle',lease_token=null,leased_at=null,last_error_code='reauthorization_required',
    updated_at=now()
  where source_id=p_source_id and user_id=p_user_id;
  insert into public.audit_events (
    user_id,actor_type,action,resource_type,resource_id,purpose,metadata
  ) values (
    p_user_id,'system','context_source.reauthorization_required','context_source',
    p_source_id::text,'provider_credential_invalid','{}'::jsonb
  );
  return true;
end;
$$;
revoke all on function public.pause_gmail_context_source(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.pause_gmail_context_source(uuid,uuid,uuid)
  to service_role;

create or replace function public.apply_gmail_sync(
  p_user_id uuid,
  p_source_id uuid,
  p_lease_token uuid,
  p_expected_history_id text,
  p_next_history_id text,
  p_items jsonb,
  p_deleted_external_ids text[],
  p_reconciliation boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue private.gmail_sync_queue;
  source public.context_sources;
  item jsonb;
  item_row public.email_context_items;
  item_hash text;
  event_id uuid;
  event_ids uuid[] := '{}'::uuid[];
  deleted_id text;
  accepted_count integer := 0;
  deleted_count integer := 0;
begin
  if p_expected_history_id !~ '^\d{1,40}$'
     or p_next_history_id !~ '^\d{1,40}$'
     or jsonb_typeof(p_items)<>'array'
     or jsonb_array_length(p_items)>500
     or cardinality(coalesce(p_deleted_external_ids,'{}'::text[]))>500 then
    raise exception 'invalid Gmail sync result';
  end if;
  select * into queue from private.gmail_sync_queue
  where source_id=p_source_id and user_id=p_user_id
    and state='processing' and lease_token=p_lease_token
  for update;
  if not found then raise exception 'Gmail sync lease unavailable'; end if;
  select * into source from public.context_sources
  where id=p_source_id and user_id=p_user_id and source_kind='email' and status='active'
  for update;
  if not found then raise exception 'Gmail context source unavailable'; end if;

  if source.sync_cursor<>p_expected_history_id then
    update private.gmail_sync_queue set
      state='queued',lease_token=null,leased_at=null,next_attempt_at=now(),updated_at=now()
    where source_id=p_source_id;
    return jsonb_build_object('applied',false,'reason','cursor_advanced');
  end if;

  for item in select value from jsonb_array_elements(p_items)
  loop
    if item->>'external_id' is null or item->>'thread_id' is null
       or item->>'history_id' !~ '^\d{1,40}$'
       or item->>'change_kind' not in ('received','updated') then
      raise exception 'invalid Gmail context item';
    end if;
    item_hash := encode(extensions.digest(item::text,'sha256'),'hex');
    insert into public.email_context_items (
      user_id,source_id,external_message_id,external_thread_id,history_id,
      content_hash,internal_date,sender,recipients,cc,subject,sent_date,snippet,
      label_ids,analysis_allowed,sensitivity,tombstone,last_seen_at
    ) values (
      p_user_id,p_source_id,item->>'external_id',item->>'thread_id',
      (item->>'history_id')::numeric,item_hash,(item->>'internal_date')::timestamptz,
      nullif(item->>'from',''),nullif(item->>'to',''),nullif(item->>'cc',''),
      nullif(item->>'subject',''),nullif(item->>'sent_date',''),nullif(item->>'snippet',''),
      coalesce(array(select jsonb_array_elements_text(item->'label_ids')),'{}'::text[]),
      coalesce((item->>'analysis_allowed')::boolean,true),
      coalesce(item->>'sensitivity','medium'),false,now()
    )
    on conflict (source_id,external_message_id) do update set
      external_thread_id=excluded.external_thread_id,
      history_id=greatest(public.email_context_items.history_id,excluded.history_id),
      content_hash=excluded.content_hash,internal_date=excluded.internal_date,
      sender=excluded.sender,recipients=excluded.recipients,cc=excluded.cc,
      subject=excluded.subject,sent_date=excluded.sent_date,snippet=excluded.snippet,
      label_ids=excluded.label_ids,analysis_allowed=excluded.analysis_allowed,
      sensitivity=excluded.sensitivity,tombstone=false,last_seen_at=now()
    returning * into item_row;
    accepted_count := accepted_count+1;

    if item->>'change_kind'='received' and not p_reconciliation then
      insert into public.context_events (
        user_id,source_id,source_kind,event_kind,resource_type,resource_id,
        occurred_at,effective_from,effective_to,evaluate_after,content_hash,dedupe_key,metadata
      ) values (
        p_user_id,p_source_id,'email','email_received','email_item',item_row.id,
        item_row.internal_date,item_row.internal_date,item_row.internal_date,now(),
        item_hash,'email:'||p_source_id::text||':'||item_row.external_message_id||
          ':received:'||(item->>'history_id'),
        jsonb_build_object('thread_id',item_row.external_thread_id)
      )
      on conflict (user_id,dedupe_key) do update set dedupe_key=excluded.dedupe_key
      returning id into event_id;
      event_ids := array_append(event_ids,event_id);
    end if;
  end loop;

  foreach deleted_id in array coalesce(p_deleted_external_ids,'{}'::text[])
  loop
    update public.email_context_items set
      tombstone=true,sender=null,recipients=null,cc=null,subject=null,sent_date=null,
      snippet=null,label_ids='{}',analysis_allowed=false,last_seen_at=now()
    where user_id=p_user_id and source_id=p_source_id
      and external_message_id=deleted_id and tombstone=false
    returning * into item_row;
    if not found then continue; end if;
    update public.context_events set
      state='superseded',completed_at=coalesce(completed_at,now()),
      outcome_reason='evidence_invalidated'
    where resource_type='email_item' and resource_id=item_row.id
      and state in ('queued','deferred','failed_safe');
    insert into public.context_events (
      user_id,source_id,source_kind,event_kind,resource_type,resource_id,
      occurred_at,effective_from,effective_to,evaluate_after,content_hash,dedupe_key,metadata
    ) values (
      p_user_id,p_source_id,'email','email_deleted','email_item',item_row.id,
      now(),item_row.internal_date,item_row.internal_date,now(),
      encode(extensions.digest('deleted:'||item_row.id::text,'sha256'),'hex'),
      'email:'||p_source_id::text||':'||deleted_id||':deleted','{}'::jsonb
    )
    on conflict (user_id,dedupe_key) do update set dedupe_key=excluded.dedupe_key;
    deleted_count := deleted_count+1;
  end loop;

  update public.context_sources set
    sync_cursor=p_next_history_id,last_synced_at=now()
  where id=p_source_id and user_id=p_user_id;
  update private.gmail_sync_queue set
    state=case when target_history_id>p_next_history_id::numeric then 'queued' else 'idle' end,
    attempts=0,
    lease_token=null,leased_at=null,next_attempt_at=now(),last_error_code=null,updated_at=now()
  where source_id=p_source_id and user_id=p_user_id;

  return jsonb_build_object(
    'applied',true,'accepted',accepted_count,'deleted',deleted_count,
    'context_event_ids',to_jsonb(event_ids),'next_history_id',p_next_history_id
  );
end;
$$;
revoke all on function public.apply_gmail_sync(uuid,uuid,uuid,text,text,jsonb,text[],boolean)
  from public,anon,authenticated;
grant execute on function public.apply_gmail_sync(uuid,uuid,uuid,text,text,jsonb,text[],boolean)
  to service_role;

create or replace function public.list_gmail_watches_due(p_limit integer default 50)
returns table (user_id uuid,source_id uuid,email_address text)
language sql
security definer
set search_path = ''
as $$
  select watch.user_id,watch.source_id,watch.email_address
  from private.gmail_watch_state watch
  join public.context_sources source on source.id=watch.source_id
  where source.status='active' and watch.watch_expires_at<now()+interval '2 days'
  order by watch.watch_expires_at
  limit least(greatest(p_limit,1),100);
$$;
revoke all on function public.list_gmail_watches_due(integer) from public,anon,authenticated;
grant execute on function public.list_gmail_watches_due(integer) to service_role;

create or replace function public.delete_gmail_context_source(
  p_user_id uuid,
  p_source_id uuid,
  p_external_revocation text default 'unknown'
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_external_revocation not in ('completed','deferred','unknown') then
    raise exception 'invalid external revocation state';
  end if;
  delete from public.context_sources
  where id=p_source_id and user_id=p_user_id and source_kind='email';
  if not found then return false; end if;
  insert into public.audit_events (
    user_id,actor_type,action,resource_type,resource_id,purpose,metadata
  ) values (
    p_user_id,'user','context_source.deleted','context_source',p_source_id::text,
    'user_requested_deletion',jsonb_build_object(
      'source_kind','email','external_revocation',p_external_revocation
    )
  );
  return true;
end;
$$;
revoke all on function public.delete_gmail_context_source(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.delete_gmail_context_source(uuid,uuid,text) to service_role;

alter table public.email_context_items enable row level security;
create policy email_context_items_own_read on public.email_context_items
for select to authenticated using (user_id=(select auth.uid()));
revoke all on public.email_context_items from anon,authenticated;
grant select on public.email_context_items to authenticated;

insert into private.feature_flags (key,scope_type,scope_id,value,rollout_note,updated_by)
values (
  'gmail_awareness','global','*','false'::jsonb,
  'Near-real-time Gmail history ingestion; requires connector, Pub/Sub, and reviewed ambient awareness',
  'migration-032'
)
on conflict (key,scope_type,scope_id) do nothing;
