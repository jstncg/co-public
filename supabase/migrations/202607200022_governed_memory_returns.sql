-- Week 3: predecessor claims remain unconfirmed; payback returns carry an old receipt plus a new trigger.

create table public.legacy_memory_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source_system text not null check (length(source_system) between 1 and 80),
  source_claim_id text not null check (length(source_claim_id) between 1 and 200),
  statement text not null check (length(trim(statement)) between 1 and 1000),
  evidence_artifact_ids uuid[] not null check (cardinality(evidence_artifact_ids) between 1 and 20),
  alternatives_json jsonb not null default '[]'::jsonb check (jsonb_typeof(alternatives_json) = 'array'),
  status text not null default 'unconfirmed' check (status in ('unconfirmed','confirmed','rejected')),
  imported_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (user_id, source_system, source_claim_id)
);

create table public.memory_returns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  old_artifact_id uuid not null,
  trigger_artifact_id uuid,
  trigger_message_id uuid,
  reason text not null check (length(trim(reason)) between 1 and 500),
  proposed_copy text not null check (length(trim(proposed_copy)) between 1 and 1000),
  status text not null default 'candidate' check (status in ('candidate','review','approved','delivered','dismissed','rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  delivered_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (old_artifact_id, user_id) references public.artifacts(id, user_id) on delete cascade,
  foreign key (trigger_artifact_id, user_id) references public.artifacts(id, user_id) on delete cascade,
  foreign key (trigger_message_id, user_id) references public.messages(id, user_id) on delete cascade,
  check ((trigger_artifact_id is not null)::int + (trigger_message_id is not null)::int = 1),
  check (old_artifact_id <> trigger_artifact_id)
);
create unique index memory_returns_artifact_trigger_unique
  on public.memory_returns (user_id, old_artifact_id, trigger_artifact_id)
  where trigger_artifact_id is not null and status <> 'rejected';
create unique index memory_returns_message_trigger_unique
  on public.memory_returns (user_id, old_artifact_id, trigger_message_id)
  where trigger_message_id is not null and status <> 'rejected';
create index memory_returns_user_status_idx on public.memory_returns (user_id, status, created_at desc);

create table private.shadow_comparisons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  input_message_id uuid,
  predecessor_version text not null,
  canonical_version text not null,
  predecessor_output text not null,
  canonical_output text not null,
  rubric_json jsonb not null default '{}'::jsonb check (jsonb_typeof(rubric_json) = 'object'),
  winner text check (winner in ('predecessor','canonical','tie','unsafe_both')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (input_message_id, user_id) references public.messages(id, user_id) on delete cascade
);
revoke all on table private.shadow_comparisons from public, anon, authenticated;

alter table public.legacy_memory_claims enable row level security;
alter table public.memory_returns enable row level security;
create policy legacy_memory_claims_own_read on public.legacy_memory_claims for select to authenticated
  using (user_id = (select auth.uid()));
create policy memory_returns_own_read on public.memory_returns for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.legacy_memory_claims, public.memory_returns from anon, authenticated;
grant select on public.legacy_memory_claims, public.memory_returns to authenticated;

alter table public.callbacks drop constraint callbacks_callback_type_check;
alter table public.callbacks add constraint callbacks_callback_type_check
  check (callback_type in ('pattern','radar','reminder','weekly','outcome','return'));

create or replace function public.import_legacy_memory_claim(
  p_user_id uuid,
  p_source_system text,
  p_source_claim_id text,
  p_statement text,
  p_evidence_artifact_ids uuid[],
  p_alternatives jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare claim_id uuid;
begin
  if length(trim(p_source_system)) not between 1 and 80
     or length(trim(p_source_claim_id)) not between 1 and 200
     or length(trim(p_statement)) not between 1 and 1000
     or cardinality(p_evidence_artifact_ids) not between 1 and 20
     or jsonb_typeof(p_alternatives) <> 'array' then
    raise exception 'invalid legacy claim';
  end if;
  if (select count(*) from public.artifacts where user_id = p_user_id and id = any(p_evidence_artifact_ids) and deleted_at is null)
     <> cardinality(p_evidence_artifact_ids) then
    raise exception 'legacy claim evidence unavailable';
  end if;
  insert into public.legacy_memory_claims (
    user_id, source_system, source_claim_id, statement, evidence_artifact_ids, alternatives_json
  ) values (
    p_user_id, trim(p_source_system), trim(p_source_claim_id), trim(p_statement), p_evidence_artifact_ids, p_alternatives
  ) on conflict (user_id, source_system, source_claim_id) do update set
    statement = excluded.statement,
    evidence_artifact_ids = excluded.evidence_artifact_ids,
    alternatives_json = excluded.alternatives_json,
    status = 'unconfirmed',
    reviewed_at = null
  returning id into claim_id;
  return claim_id;
end;
$$;

create or replace function public.create_memory_return(
  p_user_id uuid,
  p_old_artifact_id uuid,
  p_trigger_artifact_id uuid,
  p_trigger_message_id uuid,
  p_reason text,
  p_proposed_copy text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare return_id uuid; old_captured_at timestamptz; trigger_at timestamptz;
begin
  if ((p_trigger_artifact_id is not null)::int + (p_trigger_message_id is not null)::int) <> 1
     or length(trim(p_reason)) not between 1 and 500
     or length(trim(p_proposed_copy)) not between 1 and 1000 then
    raise exception 'invalid memory return';
  end if;
  select captured_at into old_captured_at from public.artifacts
  where id = p_old_artifact_id and user_id = p_user_id and deleted_at is null;
  if not found then raise exception 'old receipt unavailable'; end if;
  if p_trigger_artifact_id is not null then
    select captured_at into trigger_at from public.artifacts
    where id = p_trigger_artifact_id and user_id = p_user_id and deleted_at is null;
  else
    select sent_at into trigger_at from public.messages
    where id = p_trigger_message_id and user_id = p_user_id;
  end if;
  if not found then raise exception 'return trigger unavailable'; end if;
  if trigger_at <= old_captured_at then raise exception 'return trigger must be newer than its old receipt'; end if;

  insert into public.memory_returns (
    user_id, old_artifact_id, trigger_artifact_id, trigger_message_id, reason, proposed_copy, status
  ) values (
    p_user_id, p_old_artifact_id, p_trigger_artifact_id, p_trigger_message_id,
    trim(p_reason), trim(p_proposed_copy), 'review'
  ) returning id into return_id;
  return return_id;
end;
$$;

create or replace function public.dismiss_memory_return(p_user_id uuid, p_return_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.memory_returns set status = 'dismissed', dismissed_at = now()
  where id = p_return_id and user_id = p_user_id and status in ('approved','delivered');
  return found;
end;
$$;

revoke all on function public.import_legacy_memory_claim(uuid,text,text,text,uuid[],jsonb) from public, anon, authenticated;
grant execute on function public.import_legacy_memory_claim(uuid,text,text,text,uuid[],jsonb) to service_role;
revoke all on function public.create_memory_return(uuid,uuid,uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.create_memory_return(uuid,uuid,uuid,uuid,text,text) to service_role;
revoke all on function public.dismiss_memory_return(uuid,uuid) from public, anon, authenticated;
grant execute on function public.dismiss_memory_return(uuid,uuid) to service_role;

create or replace function public.founder_review_memory_return(
  p_return_id uuid,
  p_reviewer text,
  p_decision text,
  p_edited_copy text default null,
  p_rubric_labels text[] default '{}'
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare target public.memory_returns; active_consent public.consents; decision_id uuid;
begin
  if p_decision not in ('approve','edit','reject','unsafe') then raise exception 'invalid review decision'; end if;
  if p_decision = 'edit' and length(trim(p_edited_copy)) not between 1 and 1000 then raise exception 'edited copy required'; end if;
  select * into target from public.memory_returns where id = p_return_id and status = 'review' for update;
  if not found then raise exception 'return review target unavailable'; end if;
  select * into active_consent from public.consents
  where user_id = target.user_id and consent_type = 'founder_review'
    and revoked_at is null and expires_at is not null and expires_at > now()
  order by expires_at desc limit 1;
  if not found then raise exception 'active founder consent required'; end if;

  update public.memory_returns set
    proposed_copy = case when p_decision = 'edit' then trim(p_edited_copy) else proposed_copy end,
    status = case when p_decision in ('approve','edit') then 'approved' else 'rejected' end,
    reviewed_by = p_reviewer,
    reviewed_at = now()
  where id = p_return_id;
  insert into private.review_decisions (
    user_id,target_type,target_id,reviewer_id,consent_id,consent_checked_at,decision,edits_json,rubric_labels
  ) values (
    target.user_id,'return',target.id,p_reviewer,active_consent.id,now(),p_decision,
    case when p_decision='edit' then jsonb_build_object('copy',trim(p_edited_copy)) else '{}'::jsonb end,
    p_rubric_labels
  ) returning id into decision_id;
  insert into public.audit_events (
    user_id,actor_type,actor_id,action,resource_type,resource_id,purpose,metadata
  ) values (
    target.user_id,'founder',p_reviewer,'founder_review.'||p_decision,'return',target.id::text,
    'consented_alpha_review',jsonb_build_object('consent_id',active_consent.id,'old_artifact_id',target.old_artifact_id)
  );
  return decision_id;
end;
$$;
revoke all on function public.founder_review_memory_return(uuid,text,text,text,text[]) from public, anon, authenticated;
grant execute on function public.founder_review_memory_return(uuid,text,text,text,text[]) to service_role;

insert into private.feature_flags (key, scope_type, scope_id, value, rollout_note, updated_by)
values
  ('memory_returns','global','*','false'::jsonb,'Receipt-backed payback before patterns','migration-022'),
  ('shadow_generation','global','*','false'::jsonb,'Canonical/predecessor comparison without live delivery','migration-022')
on conflict (key, scope_type, scope_id) do nothing;

create or replace function public.export_private_user_data(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'model_runs', coalesce((select jsonb_agg(to_jsonb(run) order by run.created_at) from private.model_runs run where run.user_id = p_user_id), '[]'::jsonb),
    'external_queries', coalesce((select jsonb_agg(to_jsonb(query) order by query.created_at) from private.external_queries query where query.user_id = p_user_id), '[]'::jsonb),
    'review_decisions', coalesce((select jsonb_agg(to_jsonb(decision) order by decision.created_at) from private.review_decisions decision where decision.user_id = p_user_id), '[]'::jsonb),
    'shadow_comparisons', coalesce((select jsonb_agg(to_jsonb(comparison) order by comparison.created_at) from private.shadow_comparisons comparison where comparison.user_id = p_user_id), '[]'::jsonb),
    'apple_authorization', coalesce((select jsonb_build_object('stored', true, 'created_at', credential.created_at, 'updated_at', credential.updated_at) from private.apple_credentials credential where credential.user_id = p_user_id), jsonb_build_object('stored', false)),
    'transport_phone_link', coalesce((select jsonb_build_object('phone_last4', mapping.phone_last4, 'verified_at', mapping.verified_at) from private.phone_mappings mapping where mapping.user_id = p_user_id order by mapping.verified_at desc limit 1), 'null'::jsonb)
  );
$$;
revoke all on function public.export_private_user_data(uuid) from public, anon, authenticated;
grant execute on function public.export_private_user_data(uuid) to service_role;
