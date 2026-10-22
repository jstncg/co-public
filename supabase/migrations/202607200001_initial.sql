create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;

create schema if not exists private;
revoke all on schema private from anon, authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  timezone text not null default 'UTC',
  city text,
  locale text not null default 'en-US',
  register text not null default 'neutral' check (register in ('direct','warm','neutral')),
  onboarding_state text not null default 'promise',
  privacy_mode text not null default 'standard' check (privacy_mode in ('standard','private')),
  proactive_weekly_cap smallint not null default 2 check (proactive_weekly_cap between 0 and 5),
  quiet_hours_start time not null default '23:00',
  quiet_hours_end time not null default '08:00',
  cohort_city text
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  apns_token text,
  apns_environment text not null default 'sandbox' check (apns_environment in ('sandbox','production')),
  app_version text not null,
  os_version text not null,
  last_seen_at timestamptz not null default now(),
  notification_settings jsonb not null default '{}'::jsonb,
  unique (user_id, id)
);

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  client_artifact_id uuid not null,
  idempotency_key text not null,
  source_type text not null check (source_type in ('text','voice','image','screenshot','url','article','youtube','podcast','short_video','social_post','ai_conversation','place','product','person','event','other')),
  source_app text,
  canonical_url text,
  title text,
  publisher text,
  creator text,
  published_at timestamptz,
  captured_at timestamptz not null,
  raw_object_path text,
  mime_type text,
  raw_text text,
  transcript text,
  thumbnail_path text,
  duration_seconds numeric,
  timestamp_seconds numeric,
  user_note text,
  retention_mode text not null default 'default' check (retention_mode in ('default','keep_raw','delete_after_processing','local_only')),
  sensitivity text not null default 'unknown' check (sensitivity in ('unknown','low','medium','high')),
  source_coverage text not null check (source_coverage in ('full_media','image','text','url_only','unavailable')),
  analysis_allowed boolean not null default true,
  processing_status text not null default 'queued' check (processing_status in ('queued','uploading','processing','ready','saved_without_analysis','failed_safe','deleting','deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, client_artifact_id),
  unique (user_id, idempotency_key),
  check (canonical_url is not null or raw_text is not null or raw_object_path is not null),
  check (analysis_allowed or processing_status in ('queued','saved_without_analysis','deleting','deleted'))
);

create index artifacts_user_captured_idx on public.artifacts (user_id, captured_at desc) where deleted_at is null;
create index artifacts_search_idx on public.artifacts using gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(raw_text,'') || ' ' || coalesce(transcript,'') || ' ' || coalesce(user_note,''))) where deleted_at is null;

create table public.artifact_segments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  artifact_id uuid not null references public.artifacts(id) on delete cascade,
  segment_type text not null,
  start_offset integer,
  end_offset integer,
  start_seconds numeric,
  end_seconds numeric,
  text text not null,
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index artifact_segments_artifact_idx on public.artifact_segments (artifact_id);
create index artifact_segments_fts_idx on public.artifact_segments using gin (to_tsvector('english', text));

create table public.source_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  artifact_id uuid references public.artifacts(id) on delete cascade,
  world_event_id uuid,
  canonical_url text not null,
  source_title text,
  publisher text,
  retrieved_at timestamptz not null default now(),
  coverage text not null check (coverage in ('full_media','image','text','url_only','unavailable')),
  content_hash text,
  citation_start integer,
  citation_end integer,
  provider_metadata jsonb not null default '{}'::jsonb,
  check ((artifact_id is not null)::int + (world_event_id is not null)::int = 1)
);
create unique index source_receipts_artifact_unique on public.source_receipts (artifact_id) where artifact_id is not null;

create table public.annotations (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.artifacts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  annotation_type text not null check (annotation_type in ('why','intent','reaction','standard_signal','circle_signal','watch_request','correction')),
  value text not null,
  free_text text,
  created_at timestamptz not null default now()
);

create table private.model_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  task_type text not null,
  provider text not null,
  model text not null,
  prompt_version text not null,
  input_artifact_ids uuid[] not null default '{}',
  sanitized_external_query text,
  output_schema_version text not null,
  latency_ms integer,
  input_tokens integer,
  output_tokens integer,
  estimated_cost numeric(12,6),
  status text not null,
  error_class text,
  uncertainty_summary jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table public.observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  artifact_id uuid not null references public.artifacts(id) on delete cascade,
  observation_type text not null,
  statement text not null,
  scope text not null,
  confidence numeric not null check (confidence between 0 and 1),
  evidence_span jsonb not null default '{}'::jsonb,
  model_run_id uuid references private.model_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  invalidation_reason text
);

create table public.threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  current_question text,
  summary text,
  status text not null default 'candidate' check (status in ('candidate','active','quiet','resolved','archived','rejected')),
  confidence numeric not null default 0 check (confidence between 0 and 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.thread_memberships (
  thread_id uuid not null references public.threads(id) on delete cascade,
  artifact_id uuid not null references public.artifacts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  relationship text not null,
  confidence numeric not null check (confidence between 0 and 1),
  user_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (thread_id, artifact_id)
);

create table public.hypotheses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  thread_id uuid references public.threads(id) on delete cascade,
  statement text not null,
  alternatives_json jsonb not null default '[]'::jsonb,
  confidence numeric not null check (confidence between 0 and 1),
  sensitivity text not null check (sensitivity in ('low','medium','high')),
  status text not null default 'candidate' check (status in ('candidate','review','approved','delivered','rejected','outdated')),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.evidence_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  hypothesis_id uuid not null references public.hypotheses(id) on delete cascade,
  artifact_id uuid not null references public.artifacts(id) on delete cascade,
  observation_id uuid references public.observations(id) on delete set null,
  direction text not null check (direction in ('support','contradict','context')),
  weight numeric not null default 1,
  created_at timestamptz not null default now()
);

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  consent_type text not null,
  version text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);
create unique index one_active_consent_version on public.consents (user_id, consent_type, version) where revoked_at is null;

create table public.audit_events (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete set null,
  actor_type text not null check (actor_type in ('user','system','founder','provider')),
  actor_id text,
  action text not null,
  resource_type text not null,
  resource_id text,
  purpose text not null,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table public.product_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_name text not null,
  properties jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create table private.job_runs (
  id uuid primary key default gen_random_uuid(),
  task_type text not null,
  resource_type text not null,
  resource_id uuid not null,
  resource_version text not null,
  idempotency_key text not null unique,
  attempts integer not null default 0,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','discarded')),
  error_class text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function private.set_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger artifacts_updated before update on public.artifacts for each row execute function private.set_updated_at();
create trigger threads_updated before update on public.threads for each row execute function private.set_updated_at();
create trigger hypotheses_updated before update on public.hypotheses for each row execute function private.set_updated_at();

create or replace function private.create_profile() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.create_profile();

create or replace function private.reject_raw_analytics() returns trigger language plpgsql set search_path = '' as $$
declare key text;
begin
  for key in select jsonb_object_keys(new.properties) loop
    if key ~* '(text|content|transcript|prompt|response|note|title|url|name|email|phone|message)' then
      raise exception 'raw-content-like analytics property is forbidden: %', key;
    end if;
  end loop;
  return new;
end;
$$;
create trigger product_events_no_raw before insert or update on public.product_events for each row execute function private.reject_raw_analytics();

create or replace function public.soft_delete_artifact(target_id uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  update public.artifacts set deleted_at = now(), processing_status = 'deleting'
  where id = target_id and user_id = auth.uid() and deleted_at is null;
  if not found then raise exception 'artifact not found'; end if;
  update public.observations set invalidated_at = now(), invalidation_reason = 'artifact_deleted'
  where artifact_id = target_id and user_id = auth.uid() and invalidated_at is null;
end;
$$;
revoke all on function public.soft_delete_artifact(uuid) from public, anon;
grant execute on function public.soft_delete_artifact(uuid) to authenticated;

do $$ declare table_name text; begin
  foreach table_name in array array['profiles','devices','artifacts','artifact_segments','source_receipts','annotations','observations','threads','thread_memberships','hypotheses','evidence_links','consents','audit_events','product_events'] loop
    execute format('alter table public.%I enable row level security', table_name);
  end loop;
end $$;

create policy profiles_own on public.profiles for all to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

do $$ declare table_name text; begin
  foreach table_name in array array['devices','artifacts','artifact_segments','source_receipts','annotations','observations','threads','thread_memberships','hypotheses','evidence_links','consents','product_events'] loop
    execute format('create policy %I on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', table_name || '_own', table_name);
  end loop;
end $$;

create policy audit_events_user_read on public.audit_events for select to authenticated using (user_id = (select auth.uid()));
create policy audit_events_user_insert on public.audit_events for insert to authenticated with check (user_id = (select auth.uid()) and actor_type = 'user');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('artifacts','artifacts',false,52428800,array['image/jpeg','image/png','image/heic','audio/m4a','audio/mp4','video/mp4','text/plain','application/pdf']),
  ('exports','exports',false,104857600,array['application/zip','application/json'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy artifacts_storage_insert on storage.objects for insert to authenticated
with check (bucket_id = 'artifacts' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy artifacts_storage_select on storage.objects for select to authenticated
using (bucket_id = 'artifacts' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy artifacts_storage_delete on storage.objects for delete to authenticated
using (bucket_id = 'artifacts' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy exports_storage_select on storage.objects for select to authenticated
using (bucket_id = 'exports' and (storage.foldername(name))[1] = (select auth.uid()::text));

revoke all on all tables in schema private from anon, authenticated;
revoke all on all functions in schema private from anon, authenticated;
