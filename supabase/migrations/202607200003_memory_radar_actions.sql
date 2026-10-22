create table public.standards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  domain text not null,
  statement text not null,
  confidence numeric not null check (confidence between 0 and 1),
  origin text not null check (origin in ('explicit','inferred')),
  status text not null default 'candidate' check (status in ('candidate','active','rejected','outdated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.standard_evidence (
  standard_id uuid not null references public.standards(id) on delete cascade,
  artifact_id uuid not null references public.artifacts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  direction text not null check (direction in ('support','contradict','context')),
  created_at timestamptz not null default now(),
  primary key (standard_id, artifact_id)
);

create table public.circles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  circle_type text not null check (circle_type in ('current','admired','desired','entered')),
  description text not null,
  reward_signals jsonb not null default '[]'::jsonb,
  status text not null default 'candidate' check (status in ('candidate','active','rejected','outdated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.circle_evidence (
  circle_id uuid not null references public.circles(id) on delete cascade,
  artifact_id uuid not null references public.artifacts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  direction text not null check (direction in ('support','contradict','context')),
  created_at timestamptz not null default now(),
  primary key (circle_id, artifact_id)
);

create table public.pattern_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  hypothesis_id uuid not null references public.hypotheses(id) on delete cascade,
  verdict text not null check (verdict in ('right','partly','wrong','outdated')),
  correction text,
  created_at timestamptz not null default now()
);

create table public.watch_entities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  entity_type text not null,
  display_name text not null,
  public_identifiers jsonb not null default '{}'::jsonb,
  relationship_note text,
  desired_event_types text[] not null default '{}',
  excluded_event_types text[] not null default '{}',
  importance numeric not null default 0.5 check (importance between 0 and 1),
  approved_at timestamptz,
  paused_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (paused_at is null or approved_at is not null)
);

create table public.source_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  watch_entity_id uuid not null references public.watch_entities(id) on delete cascade,
  adapter text not null,
  adapter_version text not null,
  source_url text,
  external_id text,
  etag text,
  last_modified text,
  cursor_json jsonb not null default '{}'::jsonb,
  consecutive_failures integer not null default 0,
  last_success_at timestamptz,
  last_error_class text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_url is not null or external_id is not null)
);

create table public.world_events (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  event_type text not null,
  title text not null,
  summary text,
  canonical_url text not null,
  published_at timestamptz,
  discovered_at timestamptz not null default now(),
  content_hash text,
  source_trust numeric not null check (source_trust between 0 and 1),
  public_metadata jsonb not null default '{}'::jsonb
);

alter table public.source_receipts
  add constraint source_receipts_world_event_fk foreign key (world_event_id) references public.world_events(id) on delete cascade;

create table public.radar_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  watch_entity_id uuid not null references public.watch_entities(id) on delete cascade,
  world_event_id uuid not null references public.world_events(id) on delete cascade,
  personal_relevance numeric not null check (personal_relevance between 0 and 1),
  novelty numeric not null check (novelty between 0 and 1),
  timeliness numeric not null check (timeliness between 0 and 1),
  actionability numeric not null check (actionability between 0 and 1),
  source_trust numeric not null check (source_trust between 0 and 1),
  creepiness_risk numeric not null check (creepiness_risk between 0 and 1),
  total_score numeric not null,
  evidence_artifact_ids uuid[] not null default '{}',
  why_user text not null,
  status text not null default 'candidate' check (status in ('candidate','inbox','notified','opened','dismissed','discarded','muted')),
  model_run_id uuid references private.model_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, world_event_id)
);

create table public.watch_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  watch_entity_id uuid not null references public.watch_entities(id) on delete cascade,
  radar_candidate_id uuid references public.radar_candidates(id) on delete set null,
  feedback text not null check (feedback in ('useful','not_relevant','too_late','already_knew','too_creepy','mute_entity','mute_event_type')),
  policy_mutation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table private.external_queries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  sanitized_query text not null check (length(sanitized_query) between 1 and 320),
  evidence_artifact_ids uuid[] not null default '{}',
  provider text not null,
  returned_source_ids text[] not null default '{}',
  selected_source_id text,
  selection_reason text,
  created_at timestamptz not null default now()
);

create table public.moves (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  origin_type text not null check (origin_type in ('artifact','hypothesis','radar','user')),
  origin_id uuid,
  move_type text not null,
  title text not null,
  plan_json jsonb not null,
  required_authority text not null default 'final_user_action' check (required_authority = 'final_user_action'),
  status text not null default 'prepared' check (status in ('prepared','approved','completed','dismissed','expired')),
  prepared_at timestamptz not null default now(),
  approved_at timestamptz,
  completed_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.outcomes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  move_id uuid not null references public.moves(id) on delete cascade,
  action_taken text,
  result text,
  value_rating smallint check (value_rating between 1 and 5),
  surprise_rating smallint check (surprise_rating between 1 and 5),
  before_state jsonb not null default '{}'::jsonb,
  after_state jsonb not null default '{}'::jsonb,
  social_response text,
  repeat_intent text check (repeat_intent in ('yes','maybe','no')),
  retrospective_endorsement text,
  follow_up_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.callbacks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  callback_type text not null check (callback_type in ('pattern','radar','reminder','weekly','outcome')),
  resource_id uuid,
  evidence_artifact_ids uuid[] not null default '{}',
  lock_screen_copy text not null check (length(lock_screen_copy) <= 120),
  scheduled_at timestamptz not null,
  sent_at timestamptz,
  opened_at timestamptz,
  dismissed_at timestamptz,
  feedback text,
  created_at timestamptz not null default now()
);

create table public.data_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  request_type text not null check (request_type in ('export','delete_account')),
  status text not null default 'requested' check (status in ('requested','running','completed','failed')),
  object_path text,
  object_expires_at timestamptz,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table private.review_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null,
  target_id uuid not null,
  reviewer_id text not null,
  consent_id uuid not null references public.consents(id) on delete restrict,
  consent_checked_at timestamptz not null,
  decision text not null check (decision in ('approve','edit','reject','unsafe','abstain')),
  edits_json jsonb not null default '{}'::jsonb,
  rubric_labels text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table private.feature_flags (
  key text not null,
  scope_type text not null check (scope_type in ('global','cohort','user')),
  scope_id text not null default '*',
  value jsonb not null,
  rollout_note text not null,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (key, scope_type, scope_id)
);

create table private.anonymous_installations (
  id uuid primary key,
  secret_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  merged_user_id uuid references public.profiles(id) on delete set null,
  merged_at timestamptz
);

create trigger standards_updated before update on public.standards for each row execute function private.set_updated_at();
create trigger circles_updated before update on public.circles for each row execute function private.set_updated_at();
create trigger watch_entities_updated before update on public.watch_entities for each row execute function private.set_updated_at();
create trigger source_subscriptions_updated before update on public.source_subscriptions for each row execute function private.set_updated_at();
create trigger moves_updated before update on public.moves for each row execute function private.set_updated_at();

do $$ declare table_name text; begin
  foreach table_name in array array['standards','standard_evidence','circles','circle_evidence','pattern_feedback','watch_entities','source_subscriptions','radar_candidates','watch_feedback','moves','outcomes','callbacks','data_requests'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('create policy %I on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', table_name || '_own', table_name);
  end loop;
end $$;

alter table public.world_events enable row level security;
create policy world_events_for_owned_candidates on public.world_events for select to authenticated using (
  exists (select 1 from public.radar_candidates candidate where candidate.world_event_id = world_events.id and candidate.user_id = (select auth.uid()))
);

revoke insert, update, delete on public.world_events from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;

create or replace view public.deliverable_hypotheses
with (security_invoker = true) as
select hypothesis.*
from public.hypotheses hypothesis
join public.evidence_links evidence on evidence.hypothesis_id = hypothesis.id and evidence.direction = 'support'
join public.artifacts artifact on artifact.id = evidence.artifact_id and artifact.deleted_at is null
where hypothesis.status in ('review','approved')
  and jsonb_array_length(hypothesis.alternatives_json) > 0
  and not exists (
    select 1 from public.evidence_links contradiction
    join public.artifacts contradicted_artifact on contradicted_artifact.id = contradiction.artifact_id and contradicted_artifact.deleted_at is null
    where contradiction.hypothesis_id = hypothesis.id and contradiction.direction = 'contradict'
  )
group by hypothesis.id
having count(distinct artifact.id) >= 3 and count(distinct artifact.captured_at::date) >= 2;

grant select on public.deliverable_hypotheses to authenticated;

create or replace function public.soft_delete_artifact(target_id uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  update public.artifacts set deleted_at = now(), processing_status = 'deleting'
  where id = target_id and user_id = auth.uid() and deleted_at is null;
  if not found then raise exception 'artifact not found'; end if;
  update public.observations set invalidated_at = now(), invalidation_reason = 'artifact_deleted'
  where artifact_id = target_id and user_id = auth.uid() and invalidated_at is null;
  delete from public.artifact_segments where artifact_id = target_id and user_id = auth.uid();
  update public.hypotheses set status = 'outdated', updated_at = now()
  where user_id = auth.uid() and id in (select hypothesis_id from public.evidence_links where artifact_id = target_id);
end;
$$;
