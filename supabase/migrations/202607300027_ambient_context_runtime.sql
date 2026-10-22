-- ADR 009: opt-in ambient context is an append-only event ledger plus bounded,
-- task-specific snapshots. It does not rewrite messages, artifacts, or local logs.

create table public.context_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source_kind text not null check (source_kind in ('messaging','calendar')),
  external_source_id text not null check (length(external_source_id) between 1 and 512),
  source_label text check (source_label is null or length(source_label) between 1 and 160),
  access_mode text not null check (access_mode in ('availability_only','details')),
  status text not null default 'active' check (status in ('active','paused','revoked')),
  sync_cursor text check (sync_cursor is null or length(sync_cursor) <= 2000),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source_kind, external_source_id)
);

create table public.calendar_context_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source_id uuid not null references public.context_sources(id) on delete cascade,
  external_item_id text not null check (length(external_item_id) between 1 and 512),
  revision text not null check (length(revision) between 1 and 256),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  timezone text not null check (length(timezone) between 1 and 120),
  is_all_day boolean not null default false,
  status text not null check (status in ('confirmed','tentative','cancelled')),
  availability text not null check (availability in ('busy','free','tentative','out_of_office')),
  title text check (title is null or length(title) <= 1000),
  location text check (location is null or length(location) <= 2000),
  notes text check (notes is null or length(notes) <= 20000),
  url text check (url is null or length(url) <= 4096),
  analysis_allowed boolean not null default true,
  sensitivity text not null default 'unknown' check (sensitivity in ('unknown','low','medium','high')),
  sync_marker uuid not null,
  last_seen_at timestamptz not null,
  superseded_at timestamptz,
  tombstone boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index calendar_context_items_current_unique
  on public.calendar_context_items (source_id, external_item_id)
  where superseded_at is null;
create index calendar_context_items_window_idx
  on public.calendar_context_items (user_id, starts_at, ends_at)
  where superseded_at is null and tombstone = false;

create table public.context_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source_id uuid references public.context_sources(id) on delete cascade,
  source_kind text not null check (source_kind in ('messaging','calendar')),
  event_kind text not null check (event_kind in (
    'message_received','message_sent','calendar_changed','calendar_deleted','calendar_window_opening'
  )),
  resource_type text not null check (resource_type in ('message','calendar_item')),
  resource_id uuid not null,
  occurred_at timestamptz not null,
  effective_from timestamptz,
  effective_to timestamptz,
  evaluate_after timestamptz not null default now(),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  dedupe_key text not null check (length(dedupe_key) between 1 and 600),
  state text not null default 'queued' check (state in (
    'queued','processing','evaluated','deferred','ignored','failed_safe','superseded'
  )),
  attempts smallint not null default 0 check (attempts between 0 and 10),
  leased_at timestamptz,
  completed_at timestamptz,
  outcome_reason text check (outcome_reason is null or outcome_reason in (
    'analysis_not_allowed','high_sensitivity','non_user_or_deletion_event',
    'calendar_window_not_open','no_cross_source_relevance','collaboration_cooldown',
    'cross_source_relevance','model_not_configured','no_supported_finding',
    'candidate_created','evidence_invalidated','empty_message','historical_backfill',
    'retry_exhausted'
  )),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index context_events_due_idx
  on public.context_events (evaluate_after, created_at)
  where state in ('queued','deferred','failed_safe');
create index context_events_user_time_idx
  on public.context_events (user_id, effective_from, occurred_at desc);

create table public.temporal_context_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  trigger_event_id uuid not null references public.context_events(id) on delete cascade,
  window_start timestamptz not null,
  window_end timestamptz not null check (window_end > window_start),
  evidence_packet jsonb not null check (jsonb_typeof(evidence_packet) = 'object'),
  source_kinds text[] not null default '{}',
  reason_codes text[] not null default '{}',
  context_count smallint not null check (context_count between 1 and 500),
  assembler_version text not null,
  created_at timestamptz not null default now(),
  unique (trigger_event_id, assembler_version)
);

create table public.awareness_evaluations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  trigger_event_id uuid not null unique references public.context_events(id) on delete cascade,
  snapshot_id uuid not null references public.temporal_context_snapshots(id) on delete cascade,
  decision text not null check (decision in ('record_only','defer','collaborate','hold')),
  reason_code text not null,
  collaboration_run_id uuid references public.collaboration_runs(id) on delete set null,
  next_evaluation_at timestamptz,
  policy_version text not null,
  created_at timestamptz not null default now()
);
create index awareness_evaluations_user_created_idx
  on public.awareness_evaluations (user_id, created_at desc);

create table public.awareness_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  evaluation_id uuid not null unique references public.awareness_evaluations(id) on delete cascade,
  snapshot_id uuid not null references public.temporal_context_snapshots(id) on delete cascade,
  collaboration_run_id uuid not null references public.collaboration_runs(id) on delete cascade,
  proposed_copy text not null check (length(trim(proposed_copy)) between 1 and 2000),
  confidence numeric not null check (confidence between 0 and 1),
  citation_ids uuid[] not null check (cardinality(citation_ids) between 1 and 100),
  sensitivity text not null check (sensitivity in ('low','medium','high')),
  status text not null default 'review' check (status in (
    'proposed','review','approved','dismissed','rejected','expired'
  )),
  requires_review boolean not null default true check (requires_review),
  not_before timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index awareness_candidates_user_status_idx
  on public.awareness_candidates (user_id, status, created_at desc);

-- Retrieval spans the whole durable signal history. There is deliberately no
-- created_at term in the index or ranking.
alter table public.signal_candidates
  add column awareness_search tsvector generated always as (
    to_tsvector('simple',coalesce(statement,''))
  ) stored;
create index signal_candidates_awareness_search_idx
  on public.signal_candidates using gin (awareness_search);

create or replace function public.search_awareness_signals(
  p_user_id uuid,
  p_query text,
  p_limit integer default 100
) returns table (
  id uuid,
  statement text,
  subject_relation text,
  confidence numeric,
  sensitivity text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select signal.id,signal.statement,signal.subject_relation,signal.confidence,
    signal.sensitivity,signal.created_at
  from public.signal_candidates signal
  where signal.user_id=p_user_id
    and signal.status in ('proposed','accepted')
    and signal.sensitivity<>'high'
    and signal.awareness_search @@ websearch_to_tsquery('simple',p_query)
  order by
    ts_rank_cd(signal.awareness_search,websearch_to_tsquery('simple',p_query)) desc,
    case when signal.subject_relation='user' then 1 else 0 end desc,
    signal.confidence desc,
    signal.id
  limit least(greatest(p_limit,1),250);
$$;
revoke all on function public.search_awareness_signals(uuid,text,integer)
  from public, anon, authenticated;
grant execute on function public.search_awareness_signals(uuid,text,integer)
  to service_role;

create or replace function private.guard_awareness_candidate_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.collaboration_runs collaboration
  where collaboration.id=new.collaboration_run_id
    and collaboration.user_id=new.user_id
    and collaboration.state='succeeded'
  for update;
  if not found then raise exception 'awareness candidate evidence is unavailable'; end if;
  return new;
end;
$$;
create trigger awareness_candidate_evidence_guard
before insert or update on public.awareness_candidates
for each row execute function private.guard_awareness_candidate_write();

create trigger context_sources_updated before update on public.context_sources
for each row execute function private.set_updated_at();

create or replace function public.record_message_context_event(
  p_user_id uuid,
  p_message_id uuid,
  p_direction text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare target public.messages;
event_id uuid;
event_kind text;
begin
  if p_direction not in ('inbound','outbound') then raise exception 'invalid message direction'; end if;
  select * into target from public.messages
  where id = p_message_id and user_id = p_user_id and direction = p_direction;
  if not found then raise exception 'message context target unavailable'; end if;
  event_kind := case when p_direction = 'inbound' then 'message_received' else 'message_sent' end;
  insert into public.context_events (
    user_id,source_kind,event_kind,resource_type,resource_id,occurred_at,
    effective_from,effective_to,evaluate_after,content_hash,dedupe_key,metadata
  ) values (
    p_user_id,'messaging',event_kind,'message',target.id,target.sent_at,
    target.sent_at,target.sent_at,now(),
    encode(extensions.digest(coalesce(target.text,''),'sha256'),'hex'),
    'message:'||target.id::text||':'||event_kind,
    jsonb_build_object('conversation_id',target.conversation_id,'transport',target.transport)
  )
  on conflict (user_id,dedupe_key) do update set dedupe_key=excluded.dedupe_key
  returning id into event_id;
  return event_id;
end;
$$;
revoke all on function public.record_message_context_event(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.record_message_context_event(uuid,uuid,text) to service_role;

create or replace function private.capture_message_context_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A short inbound burst is one conversational turn. Keep every message and
  -- event, but only let the newest event request background model work.
  if new.direction='inbound' then
    update public.context_events
    set state='superseded',completed_at=now(),outcome_reason='evidence_invalidated'
    where user_id=new.user_id and event_kind='message_received'
      and state in ('queued','deferred','failed_safe')
      and occurred_at between new.sent_at-interval '30 seconds' and new.sent_at;
  end if;
  perform public.record_message_context_event(new.user_id,new.id,new.direction);
  return new;
end;
$$;

-- Existing canonical messages remain first-class context without replaying
-- months of model work. This is an additive index over the untouched records.
insert into public.context_events (
  user_id,source_kind,event_kind,resource_type,resource_id,occurred_at,
  effective_from,effective_to,evaluate_after,content_hash,dedupe_key,state,
  completed_at,outcome_reason,metadata
)
select
  message.user_id,'messaging',
  case when message.direction='inbound' then 'message_received' else 'message_sent' end,
  'message',message.id,message.sent_at,message.sent_at,message.sent_at,message.sent_at,
  encode(extensions.digest(coalesce(message.text,''),'sha256'),'hex'),
  'message:'||message.id::text||':'||
    case when message.direction='inbound' then 'message_received' else 'message_sent' end,
  'evaluated',now(),'historical_backfill',
  jsonb_build_object('conversation_id',message.conversation_id,'transport',message.transport)
from public.messages message
on conflict (user_id,dedupe_key) do nothing;

create trigger messages_capture_context_event
after insert on public.messages
for each row execute function private.capture_message_context_event();
revoke all on function private.capture_message_context_event() from public, anon, authenticated;

create or replace function public.sync_calendar_context(
  p_user_id uuid,
  p_external_source_id uuid,
  p_source_label text,
  p_access_mode text,
  p_sync_cursor text,
  p_full_sync boolean,
  p_synced_at timestamptz,
  p_events jsonb,
  p_deleted_external_ids text[]
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_row public.context_sources;
  previous_access_mode text;
  sync_id uuid := gen_random_uuid();
  item jsonb;
  item_hash text;
  item_row public.calendar_context_items;
  prior_item public.calendar_context_items;
  context_event_id uuid;
  immediate_event_ids uuid[] := '{}'::uuid[];
  accepted_count integer := 0;
  unchanged_count integer := 0;
  deleted_count integer := 0;
  next_due timestamptz;
  deleted_external_id text;
  affected_run_ids uuid[] := '{}'::uuid[];
begin
  if p_access_mode not in ('availability_only','details')
     or jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) > 500
     or cardinality(coalesce(p_deleted_external_ids,'{}'::text[])) > 500 then
    raise exception 'invalid calendar context sync';
  end if;

  select access_mode into previous_access_mode
  from public.context_sources
  where user_id=p_user_id and source_kind='calendar' and external_source_id=p_external_source_id::text;

  insert into public.context_sources (
    user_id,source_kind,external_source_id,source_label,access_mode,status,sync_cursor,last_synced_at
  ) values (
    p_user_id,'calendar',p_external_source_id::text,nullif(trim(p_source_label),''),
    p_access_mode,'active',p_sync_cursor,p_synced_at
  )
  on conflict (user_id,source_kind,external_source_id) do update set
    source_label=excluded.source_label,
    access_mode=excluded.access_mode,
    status='active',
    sync_cursor=excluded.sync_cursor,
    last_synced_at=excluded.last_synced_at
  returning * into source_row;

  if previous_access_mode = 'details' and p_access_mode = 'availability_only' then
    update public.calendar_context_items
    set title=null,location=null,notes=null,url=null
    where source_id=source_row.id;
    select coalesce(array_agg(collaboration.id),'{}'::uuid[])
    into affected_run_ids
    from public.collaboration_runs collaboration
    where collaboration.user_id=p_user_id
      and exists (
        select 1 from public.context_events event
        where event.source_id=source_row.id
          and coalesce(collaboration.evidence_packet->'context_event_ids','[]'::jsonb) ? event.id::text
      );
    update public.collaboration_runs collaboration
    set state='cancelled',cancel_requested_at=coalesce(cancel_requested_at,now()),
        completed_at=coalesce(completed_at,now())
    where collaboration.id=any(affected_run_ids);
    update public.collaboration_tasks
    set state='cancelled',completed_at=coalesce(completed_at,now()),
        error_class='evidence_access_downgraded'
    where run_id=any(affected_run_ids);
    delete from public.awareness_candidates
    where collaboration_run_id=any(affected_run_ids);
    delete from public.collaboration_results
    where run_id=any(affected_run_ids);
  end if;

  for item in select value from jsonb_array_elements(p_events)
  loop
    if p_access_mode='availability_only' and (
      item->>'title' is not null or item->>'location' is not null
      or item->>'notes' is not null or item->>'url' is not null
    ) then raise exception 'availability-only sync contains details'; end if;
    item_hash := encode(extensions.digest(item::text,'sha256'),'hex');
    select * into prior_item
    from public.calendar_context_items
    where source_id=source_row.id and external_item_id=item->>'external_id'
      and superseded_at is null
    for update;
    if found and prior_item.content_hash=item_hash then
      update public.calendar_context_items
      set last_seen_at=p_synced_at,sync_marker=sync_id
      where id=prior_item.id;
      unchanged_count := unchanged_count + 1;
      continue;
    end if;
    if found then
      update public.calendar_context_items set superseded_at=now() where id=prior_item.id;
      update public.context_events
      set state='superseded',completed_at=coalesce(completed_at,now()),outcome_reason='evidence_invalidated'
      where resource_type='calendar_item' and resource_id=prior_item.id
        and state in ('queued','deferred','failed_safe');
    end if;
    insert into public.calendar_context_items (
      user_id,source_id,external_item_id,revision,content_hash,starts_at,ends_at,timezone,
      is_all_day,status,availability,title,location,notes,url,analysis_allowed,sensitivity,
      sync_marker,last_seen_at
    ) values (
      p_user_id,source_row.id,item->>'external_id',item->>'revision',item_hash,
      (item->>'starts_at')::timestamptz,(item->>'ends_at')::timestamptz,item->>'timezone',
      coalesce((item->>'is_all_day')::boolean,false),coalesce(item->>'status','confirmed'),
      coalesce(item->>'availability','busy'),nullif(item->>'title',''),
      nullif(item->>'location',''),nullif(item->>'notes',''),nullif(item->>'url',''),
      coalesce((item->>'analysis_allowed')::boolean,true),coalesce(item->>'sensitivity','unknown'),
      sync_id,p_synced_at
    ) returning * into item_row;
    accepted_count := accepted_count + 1;

    insert into public.context_events (
      user_id,source_id,source_kind,event_kind,resource_type,resource_id,occurred_at,
      effective_from,effective_to,evaluate_after,content_hash,dedupe_key,metadata
    ) values (
      p_user_id,source_row.id,'calendar','calendar_changed','calendar_item',item_row.id,p_synced_at,
      item_row.starts_at,item_row.ends_at,now(),item_hash,
      'calendar:'||item_row.id::text||':changed',
      jsonb_build_object('access_mode',p_access_mode,'all_day',item_row.is_all_day)
    )
    on conflict (user_id,dedupe_key) do update set dedupe_key=excluded.dedupe_key
    returning id into context_event_id;
    immediate_event_ids := array_append(immediate_event_ids,context_event_id);

    if item_row.status <> 'cancelled' and item_row.ends_at > now() then
      insert into public.context_events (
        user_id,source_id,source_kind,event_kind,resource_type,resource_id,occurred_at,
        effective_from,effective_to,evaluate_after,content_hash,dedupe_key,metadata
      ) values (
        p_user_id,source_row.id,'calendar','calendar_window_opening','calendar_item',item_row.id,p_synced_at,
        item_row.starts_at,item_row.ends_at,greatest(now(),item_row.starts_at-interval '24 hours'),
        item_hash,'calendar:'||item_row.id::text||':window',
        jsonb_build_object('access_mode',p_access_mode,'all_day',item_row.is_all_day)
      )
      on conflict (user_id,dedupe_key) do update set dedupe_key=excluded.dedupe_key
      returning id,evaluate_after into context_event_id,next_due;
      if next_due <= now() then
        immediate_event_ids := array_append(immediate_event_ids,context_event_id);
      end if;
    end if;
  end loop;

  foreach deleted_external_id in array coalesce(p_deleted_external_ids,'{}'::text[])
  loop
    select * into prior_item from public.calendar_context_items
    where source_id=source_row.id and external_item_id=deleted_external_id
      and superseded_at is null and tombstone=false
    for update;
    if not found then continue; end if;
    update public.calendar_context_items
    set superseded_at=now(),title=null,location=null,notes=null,url=null,
        analysis_allowed=false
    where id=prior_item.id;
    update public.context_events
    set state='superseded',completed_at=coalesce(completed_at,now()),outcome_reason='evidence_invalidated'
    where resource_type='calendar_item' and resource_id=prior_item.id
      and event_kind='calendar_window_opening' and state in ('queued','deferred','failed_safe');
    insert into public.context_events (
      user_id,source_id,source_kind,event_kind,resource_type,resource_id,occurred_at,
      effective_from,effective_to,evaluate_after,content_hash,dedupe_key,metadata
    ) values (
      p_user_id,source_row.id,'calendar','calendar_deleted','calendar_item',prior_item.id,p_synced_at,
      prior_item.starts_at,prior_item.ends_at,now(),
      encode(extensions.digest('deleted:'||prior_item.id::text,'sha256'),'hex'),
      'calendar:'||prior_item.id::text||':deleted','{}'::jsonb
    )
    on conflict (user_id,dedupe_key) do update set dedupe_key=excluded.dedupe_key
    returning id into context_event_id;
    immediate_event_ids := array_append(immediate_event_ids,context_event_id);
    deleted_count := deleted_count + 1;
  end loop;

  if p_full_sync then
    for prior_item in select * from public.calendar_context_items
      where source_id=source_row.id and superseded_at is null and tombstone=false
        and sync_marker<>sync_id
      for update
    loop
      update public.calendar_context_items
      set superseded_at=now(),title=null,location=null,notes=null,url=null,
          analysis_allowed=false
      where id=prior_item.id;
      update public.context_events
      set state='superseded',completed_at=coalesce(completed_at,now()),outcome_reason='evidence_invalidated'
      where resource_type='calendar_item' and resource_id=prior_item.id
        and event_kind='calendar_window_opening' and state in ('queued','deferred','failed_safe');
      insert into public.context_events (
        user_id,source_id,source_kind,event_kind,resource_type,resource_id,occurred_at,
        effective_from,effective_to,evaluate_after,content_hash,dedupe_key,metadata
      ) values (
        p_user_id,source_row.id,'calendar','calendar_deleted','calendar_item',prior_item.id,p_synced_at,
        prior_item.starts_at,prior_item.ends_at,now(),
        encode(extensions.digest('deleted:'||prior_item.id::text,'sha256'),'hex'),
        'calendar:'||prior_item.id::text||':deleted','{}'::jsonb
      )
      on conflict (user_id,dedupe_key) do update set dedupe_key=excluded.dedupe_key
      returning id into context_event_id;
      immediate_event_ids := array_append(immediate_event_ids,context_event_id);
      deleted_count := deleted_count + 1;
    end loop;
  end if;

  select min(evaluate_after) into next_due
  from public.context_events
  where source_id=source_row.id and state in ('queued','deferred','failed_safe')
    and evaluate_after>now();
  return jsonb_build_object(
    'source_id',p_external_source_id,
    'accepted',accepted_count,
    'unchanged',unchanged_count,
    'deleted',deleted_count,
    'context_event_ids',to_jsonb(immediate_event_ids),
    'next_due_at',next_due
  );
end;
$$;
revoke all on function public.sync_calendar_context(uuid,uuid,text,text,text,boolean,timestamptz,jsonb,text[])
  from public, anon, authenticated;
grant execute on function public.sync_calendar_context(uuid,uuid,text,text,text,boolean,timestamptz,jsonb,text[])
  to service_role;

create or replace function public.claim_due_context_events(p_limit integer default 50)
returns table (event_id uuid,user_id uuid,attempt smallint)
language sql
security definer
set search_path = ''
as $$
  with claims as (
    select event.id
    from public.context_events event
    join public.profiles profile on profile.id=event.user_id
    where event.state in ('queued','deferred','failed_safe')
      and event.evaluate_after<=now()
      and event.attempts<10
      and (event.leased_at is null or event.leased_at<now()-interval '15 minutes')
    order by event.evaluate_after,event.created_at
    for update of event skip locked
    limit least(greatest(p_limit,1),100)
  )
  update public.context_events event
  set state='processing',leased_at=now(),attempts=event.attempts+1
  from claims where event.id=claims.id
  returning event.id,event.user_id,event.attempts;
$$;
revoke all on function public.claim_due_context_events(integer) from public, anon, authenticated;
grant execute on function public.claim_due_context_events(integer) to service_role;

create or replace function public.delete_calendar_context_source(
  p_user_id uuid,
  p_external_source_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare source_row public.context_sources;
affected_run_ids uuid[] := '{}'::uuid[];
begin
  select * into source_row from public.context_sources
  where user_id=p_user_id and source_kind='calendar'
    and external_source_id=p_external_source_id::text
  for update;
  if not found then return false; end if;
  select coalesce(array_agg(collaboration.id),'{}'::uuid[]) into affected_run_ids
  from public.collaboration_runs collaboration
  where collaboration.user_id=p_user_id and exists (
    select 1 from public.context_events event
    where event.source_id=source_row.id
      and coalesce(collaboration.evidence_packet->'context_event_ids','[]'::jsonb) ? event.id::text
  );
  if cardinality(affected_run_ids)>0 then
    update public.collaboration_runs set state='cancelled',
      cancel_requested_at=coalesce(cancel_requested_at,now()),
      completed_at=coalesce(completed_at,now())
    where id=any(affected_run_ids);
    update public.collaboration_tasks set state='cancelled',
      completed_at=coalesce(completed_at,now()),error_class='evidence_invalidated'
    where run_id=any(affected_run_ids);
    delete from public.collaboration_results where run_id=any(affected_run_ids);
  end if;
  delete from public.context_sources where id=source_row.id;
  insert into public.audit_events (
    user_id,actor_type,action,resource_type,resource_id,purpose,metadata
  ) values (
    p_user_id,'user','context_source.deleted','context_source',
    p_external_source_id::text,'user_requested_deletion',
    jsonb_build_object('source_kind','calendar')
  );
  return true;
end;
$$;
revoke all on function public.delete_calendar_context_source(uuid,uuid) from public, anon, authenticated;
grant execute on function public.delete_calendar_context_source(uuid,uuid) to service_role;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'context_sources','calendar_context_items','context_events',
    'temporal_context_snapshots','awareness_evaluations','awareness_candidates'
  ] loop
    execute format('alter table public.%I enable row level security',table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id=(select auth.uid()))',
      table_name||'_own_read',table_name
    );
    execute format('revoke all on public.%I from anon,authenticated',table_name);
    execute format('grant select on public.%I to authenticated',table_name);
  end loop;
end $$;

insert into private.feature_flags (key,scope_type,scope_id,value,rollout_note,updated_by)
values (
  'ambient_awareness','global','*','false'::jsonb,
  'Opt-in message/calendar context ledger and reviewed cross-source candidates','migration-027'
)
on conflict (key,scope_type,scope_id) do nothing;
