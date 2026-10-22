-- ADR 007/008: append-only evidence interpretations and portable agent collaboration.
-- No historical artifact, segment, observation, or local log is rewritten.

alter table public.artifacts drop constraint if exists artifacts_source_type_check;
alter table public.artifacts add constraint artifacts_source_type_check check (
  source_type in (
    'text','voice','image','screenshot','url','article','youtube','podcast',
    'short_video','social_post','ai_conversation','place','product','person',
    'event','video','call','meeting','conversation','other'
  )
);
alter table public.artifacts
  add column if not exists occurred_at timestamptz,
  add column if not exists provenance_class text not null default 'external'
    check (provenance_class in ('owner','participant','external','system')),
  add column if not exists consent_state text not null default 'not_required'
    check (consent_state in ('owner_supplied','participants_consented','unknown','not_required')),
  add column if not exists source_adapter text,
  add column if not exists source_adapter_version text;

alter table public.artifact_segments
  add column if not exists segment_key text,
  add column if not exists content_kind text not null default 'normalized_text'
    check (content_kind in ('transcript','caption','turn','ocr','description','normalized_text')),
  add column if not exists speaker_label text,
  add column if not exists speaker_relation text not null default 'unknown'
    check (speaker_relation in ('user','other_person','source','unknown')),
  add column if not exists provenance_class text not null default 'external'
    check (provenance_class in ('owner','participant','external','system')),
  add column if not exists confidence numeric not null default 1 check (confidence between 0 and 1);

update public.artifact_segments
set segment_key = 'legacy:' || id::text
where segment_key is null;
alter table public.artifact_segments alter column segment_key set not null;
create unique index if not exists artifact_segments_key_unique
  on public.artifact_segments (artifact_id, segment_key);
create index if not exists artifact_segments_time_idx
  on public.artifact_segments (artifact_id, start_seconds, end_seconds);

create table public.signal_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  artifact_id uuid not null references public.artifacts(id) on delete cascade,
  signal_type text not null check (signal_type in (
    'source_claim','user_statement','commitment','question','entity','preference','moment'
  )),
  subject_relation text not null check (subject_relation in ('source','user','other_person','unknown')),
  statement text not null,
  confidence numeric not null check (confidence between 0 and 1),
  supporting_segment_ids uuid[] not null default '{}',
  contradicting_segment_ids uuid[] not null default '{}',
  uncertainty text,
  sensitivity text not null check (sensitivity in ('low','medium','high')),
  status text not null default 'proposed'
    check (status in ('proposed','accepted','rejected','held','invalidated')),
  model_run_id uuid references private.model_runs(id) on delete set null,
  compiler_version text not null,
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  invalidation_reason text
);
create index signal_candidates_artifact_idx on public.signal_candidates (artifact_id);
create index signal_candidates_user_status_idx on public.signal_candidates (user_id, status, created_at desc);

create table public.usefulness_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  artifact_id uuid not null references public.artifacts(id) on delete cascade,
  signal_id uuid not null references public.signal_candidates(id) on delete cascade,
  lane text not null check (lane in (
    'reply_now','return_later','update_candidate','watch_candidate','move_draft','hold'
  )),
  reason text not null,
  supporting_segment_ids uuid[] not null default '{}',
  relevance numeric not null check (relevance between 0 and 1),
  novelty numeric not null check (novelty between 0 and 1),
  actionability numeric not null check (actionability between 0 and 1),
  status text not null default 'proposed'
    check (status in ('proposed','review','approved','executed','rejected','expired')),
  requires_review boolean not null default true check (requires_review),
  router_version text not null,
  not_before timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (signal_id, lane, router_version)
);
create index usefulness_candidates_user_lane_idx
  on public.usefulness_candidates (user_id, lane, status, created_at desc);

create table public.collaboration_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  idempotency_key text not null,
  objective text not null,
  state text not null default 'queued'
    check (state in ('queued','running','succeeded','failed','cancelled','budget_exhausted')),
  evidence_packet jsonb not null,
  token_budget jsonb not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  max_concurrency smallint not null check (max_concurrency between 1 and 16),
  max_retries_per_task smallint not null check (max_retries_per_task between 0 and 3),
  cancel_requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create table public.collaboration_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  run_id uuid not null references public.collaboration_runs(id) on delete cascade,
  agent_id text not null,
  agent_name text not null,
  objective text not null,
  instructions text not null,
  provider text not null check (provider in ('openai','anthropic','custom')),
  model text not null,
  max_output_tokens integer not null check (max_output_tokens > 0),
  reasoning_effort text check (reasoning_effort in ('none','low','medium','high','xhigh','max')),
  timeout_ms integer not null check (timeout_ms between 1000 and 900000),
  depends_on text[] not null default '{}',
  state text not null default 'queued'
    check (state in ('queued','running','succeeded','failed','cancelled','skipped','budget_exhausted')),
  attempts smallint not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  lease_owner text,
  lease_expires_at timestamptz,
  error_class text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, agent_id)
);
create index collaboration_tasks_claim_idx
  on public.collaboration_tasks (state, lease_expires_at, created_at);

create table public.collaboration_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  run_id uuid not null references public.collaboration_runs(id) on delete cascade,
  task_id uuid not null unique references public.collaboration_tasks(id) on delete cascade,
  output jsonb not null,
  output_hash text not null,
  created_at timestamptz not null default now()
);

create table public.collaboration_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  run_id uuid not null references public.collaboration_runs(id) on delete cascade,
  task_id uuid references public.collaboration_tasks(id) on delete cascade,
  sequence integer not null,
  event_type text not null,
  agent_id text,
  state text not null,
  usage jsonb,
  detail jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  unique (run_id, sequence)
);
create index collaboration_events_monitor_idx
  on public.collaboration_events (run_id, sequence);

create trigger collaboration_runs_updated before update on public.collaboration_runs
for each row execute function private.set_updated_at();

create or replace function private.invalidate_refinery_derivatives()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare target_artifact_id uuid;
target_user_id uuid;
affected_run_ids uuid[] := '{}'::uuid[];
reason text;
begin
  if tg_table_name = 'annotations' then
    if new.annotation_type <> 'correction' then return new; end if;
    target_artifact_id := new.artifact_id;
    target_user_id := new.user_id;
    reason := 'user_correction';
  elsif tg_op = 'DELETE' then
    target_artifact_id := old.id;
    target_user_id := old.user_id;
    reason := 'artifact_deleted';
  else
    if old.deleted_at is not null or new.deleted_at is null then return new; end if;
    target_artifact_id := new.id;
    target_user_id := new.user_id;
    reason := 'artifact_deleted';
  end if;

  update public.signal_candidates
  set status = 'invalidated', invalidated_at = now(), invalidation_reason = reason
  where artifact_id = target_artifact_id and invalidated_at is null;
  update public.usefulness_candidates
  set status = 'rejected'
  where artifact_id = target_artifact_id and status in ('proposed','review','approved');

  select coalesce(array_agg(collaboration.id), '{}'::uuid[])
  into affected_run_ids
  from public.collaboration_runs collaboration
  where collaboration.user_id = target_user_id
    and (
      coalesce(collaboration.evidence_packet -> 'artifact_ids', '[]'::jsonb) ? target_artifact_id::text
      or exists (
        select 1 from public.artifact_segments segment
        where segment.artifact_id = target_artifact_id
          and coalesce(collaboration.evidence_packet -> 'segment_ids', '[]'::jsonb) ? segment.id::text
      )
      or exists (
        select 1 from public.signal_candidates signal
        where signal.artifact_id = target_artifact_id
          and coalesce(collaboration.evidence_packet -> 'signal_ids', '[]'::jsonb) ? signal.id::text
      )
    );

  if cardinality(affected_run_ids) > 0 then
    -- Lock/cancel the run before deleting derived output. The result-write guard below
    -- takes a conflicting row lock, preventing a late worker from recreating deleted output.
    update public.collaboration_runs
    set state = 'cancelled', cancel_requested_at = coalesce(cancel_requested_at, now()),
        completed_at = coalesce(completed_at, now())
    where id = any(affected_run_ids);
    update public.collaboration_tasks
    set state = 'cancelled', completed_at = coalesce(completed_at, now()),
        error_class = reason
    where run_id = any(affected_run_ids);
    -- Results may contain evidence-derived language, so user correction/deletion removes
    -- them. Content-free monitor events remain as an operational audit trail.
    delete from public.collaboration_results where run_id = any(affected_run_ids);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger refinery_correction_invalidation
after insert on public.annotations
for each row execute function private.invalidate_refinery_derivatives();

create trigger refinery_deletion_invalidation
after update of deleted_at on public.artifacts
for each row execute function private.invalidate_refinery_derivatives();

create trigger refinery_hard_deletion_invalidation
before delete on public.artifacts
for each row execute function private.invalidate_refinery_derivatives();

create or replace function private.guard_collaboration_result_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1
  from public.collaboration_runs collaboration
  where collaboration.id = new.run_id
    and collaboration.user_id = new.user_id
    and collaboration.state <> 'cancelled'
  for update;
  if not found then
    raise exception 'collaboration evidence is invalidated';
  end if;
  return new;
end;
$$;

create trigger collaboration_result_evidence_guard
before insert or update on public.collaboration_results
for each row execute function private.guard_collaboration_result_write();

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'signal_candidates','usefulness_candidates','collaboration_runs',
    'collaboration_tasks','collaboration_results','collaboration_events'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))',
      table_name || '_own_read', table_name
    );
    execute format('revoke all on public.%I from anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
  end loop;
end $$;
