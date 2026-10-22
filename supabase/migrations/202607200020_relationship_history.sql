-- Week 2: verified phone ownership, relationship history controls, and correction/deletion propagation.

create table private.transport_phone_link_challenges (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  phone_hash text not null check (phone_hash ~ '^[a-f0-9]{64}$'),
  phone_last4 text not null check (phone_last4 ~ '^[0-9]{4}$'),
  code_hash text not null check (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  attempts smallint not null default 0 check (attempts between 0 and 5),
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);
create index transport_phone_link_challenges_user_idx
  on private.transport_phone_link_challenges (user_id, created_at desc);
revoke all on table private.transport_phone_link_challenges from public, anon, authenticated;

create or replace function public.begin_transport_phone_link(
  p_challenge_id uuid,
  p_user_id uuid,
  p_phone_hash text,
  p_phone_last4 text,
  p_code_hash text,
  p_expires_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_phone_hash !~ '^[a-f0-9]{64}$'
     or p_phone_last4 !~ '^[0-9]{4}$'
     or p_code_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at < now() + interval '4 minutes'
     or p_expires_at > now() + interval '11 minutes' then
    raise exception 'invalid phone-link challenge';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'profile unavailable';
  end if;
  if (
    select count(*) from private.transport_phone_link_challenges
    where (user_id = p_user_id or phone_hash = p_phone_hash)
      and created_at > now() - interval '15 minutes'
  ) >= 3 then
    raise exception 'phone-link rate limit';
  end if;

  update private.transport_phone_link_challenges
  set consumed_at = now()
  where user_id = p_user_id and consumed_at is null;
  insert into private.transport_phone_link_challenges (
    id, user_id, phone_hash, phone_last4, code_hash, expires_at
  ) values (
    p_challenge_id, p_user_id, p_phone_hash, p_phone_last4, p_code_hash, p_expires_at
  );
  return p_challenge_id;
end;
$$;

create or replace function public.cancel_transport_phone_link(p_challenge_id uuid, p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.transport_phone_link_challenges
  set consumed_at = coalesce(consumed_at, now())
  where id = p_challenge_id and user_id = p_user_id;
$$;

create or replace function public.verify_transport_phone_link(
  p_challenge_id uuid,
  p_user_id uuid,
  p_code_hash text,
  p_verified_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  challenge private.transport_phone_link_challenges%rowtype;
  existing_user_id uuid;
begin
  if p_code_hash !~ '^[a-f0-9]{64}$'
     or p_verified_at < now() - interval '2 minutes'
     or p_verified_at > now() + interval '2 minutes' then
    raise exception 'invalid phone-link verification';
  end if;
  select * into challenge
  from private.transport_phone_link_challenges
  where id = p_challenge_id and user_id = p_user_id
  for update;
  if not found or challenge.consumed_at is not null or challenge.expires_at < p_verified_at or challenge.attempts >= 5 then
    return false;
  end if;

  update private.transport_phone_link_challenges
  set attempts = attempts + 1
  where id = p_challenge_id;
  if challenge.code_hash <> p_code_hash then return false; end if;

  select mapping.user_id into existing_user_id
  from private.phone_mappings mapping
  where mapping.phone_hash = challenge.phone_hash
  for update;
  if found and existing_user_id <> p_user_id then
    raise exception 'phone already linked';
  end if;

  delete from private.phone_mappings
  where user_id = p_user_id and phone_hash <> challenge.phone_hash;
  insert into private.phone_mappings (phone_hash, phone_last4, user_id, verified_at)
  values (challenge.phone_hash, challenge.phone_last4, p_user_id, p_verified_at)
  on conflict (phone_hash) do update set
    phone_last4 = excluded.phone_last4,
    verified_at = excluded.verified_at
  where private.phone_mappings.user_id = excluded.user_id;
  update private.transport_phone_link_challenges
  set consumed_at = p_verified_at
  where id = p_challenge_id;
  insert into public.audit_events (
    user_id, actor_type, actor_id, action, resource_type, resource_id, purpose
  ) values (
    p_user_id, 'user', p_user_id::text, 'transport.phone_link', 'profile', p_user_id::text,
    'verified_relationship_handoff'
  );
  return true;
end;
$$;

create or replace function public.transport_phone_link_status(p_user_id uuid)
returns table (phone_last4 text, verified_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  select mapping.phone_last4, mapping.verified_at
  from private.phone_mappings mapping
  where mapping.user_id = p_user_id
  order by mapping.verified_at desc
  limit 1;
$$;

create or replace function public.unlink_transport_phone(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.phone_mappings where user_id = p_user_id;
  update private.transport_phone_link_challenges set consumed_at = coalesce(consumed_at, now())
  where user_id = p_user_id;
  insert into public.audit_events (
    user_id, actor_type, actor_id, action, resource_type, resource_id, purpose
  ) values (
    p_user_id, 'user', p_user_id::text, 'transport.phone_unlink', 'profile', p_user_id::text,
    'user_requested_unlink'
  );
end;
$$;

-- A verified number must never be silently reassigned across accounts, including through the
-- operational provisioning function introduced in migration 019.
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
declare existing_user_id uuid;
begin
  if p_phone_hash !~ '^[a-f0-9]{64}$' or p_phone_last4 !~ '^[0-9]{4}$' then
    raise exception 'invalid verified phone mapping';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'profile unavailable';
  end if;
  select mapping.user_id into existing_user_id
  from private.phone_mappings mapping where mapping.phone_hash = p_phone_hash for update;
  if found and existing_user_id <> p_user_id then raise exception 'phone already linked'; end if;
  delete from private.phone_mappings where user_id = p_user_id and phone_hash <> p_phone_hash;
  insert into private.phone_mappings (phone_hash, phone_last4, user_id, verified_at)
  values (p_phone_hash, p_phone_last4, p_user_id, p_verified_at)
  on conflict (phone_hash) do update set
    phone_last4 = excluded.phone_last4,
    verified_at = excluded.verified_at
  where private.phone_mappings.user_id = excluded.user_id;
end;
$$;

create or replace function public.correct_user_artifact(
  p_user_id uuid,
  p_client_artifact_id uuid,
  p_correction text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare target_id uuid; annotation_id uuid;
begin
  if length(trim(p_correction)) not between 1 and 1000 then raise exception 'invalid correction'; end if;
  select id into target_id from public.artifacts
  where user_id = p_user_id and client_artifact_id = p_client_artifact_id and deleted_at is null
  for update;
  if not found then raise exception 'artifact unavailable'; end if;

  insert into public.annotations (artifact_id, user_id, annotation_type, value, free_text)
  values (target_id, p_user_id, 'correction', 'user_correction', trim(p_correction))
  returning id into annotation_id;
  update public.observations set invalidated_at = now(), invalidation_reason = 'user_correction'
  where user_id = p_user_id and artifact_id = target_id and invalidated_at is null;
  update public.hypotheses set status = 'outdated', updated_at = now()
  where user_id = p_user_id and id in (
    select hypothesis_id from public.evidence_links where artifact_id = target_id
  );
  insert into private.job_runs (task_type, resource_type, resource_id, resource_version, idempotency_key)
  values (
    'pattern_recompile', 'user', p_user_id, 'artifact-correction.v1',
    format('pattern-recompile:correction:%s:%s', p_user_id, annotation_id)
  );
  insert into public.audit_events (
    user_id, actor_type, actor_id, action, resource_type, resource_id, purpose,
    metadata
  ) values (
    p_user_id, 'user', p_user_id::text, 'artifact.correct', 'artifact', target_id::text,
    'user_supplied_correction', jsonb_build_object('recompile_queued', true)
  );
  return annotation_id;
end;
$$;

-- Keep the denormalized message attachment list consistent with the canonical join table.
create or replace function public.delete_user_artifact(
  p_user_id uuid,
  p_client_artifact_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare target_id uuid;
begin
  select id into target_id from public.artifacts
  where user_id = p_user_id and client_artifact_id = p_client_artifact_id
  for update;
  if not found then return; end if;

  update public.messages
  set artifact_ids = array_remove(artifact_ids, target_id)
  where user_id = p_user_id and target_id = any(artifact_ids);
  update public.hypotheses set status = 'outdated', updated_at = now()
  where user_id = p_user_id and id in (
    select hypothesis_id from public.evidence_links where artifact_id = target_id
  );
  insert into public.audit_events (
    user_id, actor_type, actor_id, action, resource_type, resource_id, purpose, metadata
  ) values (
    p_user_id, 'user', p_user_id::text, 'artifact.delete', 'artifact', target_id::text,
    'user_requested_deletion', jsonb_build_object('derived_memory_invalidated', true, 'recompile_queued', true)
  );
  insert into private.job_runs (
    task_type, resource_type, resource_id, resource_version, idempotency_key
  ) values (
    'pattern_recompile', 'user', p_user_id, 'artifact-deletion.v1',
    format('pattern-recompile:%s:%s', p_user_id, p_client_artifact_id)
  ) on conflict (idempotency_key) do nothing;
  delete from public.artifacts where id = target_id and user_id = p_user_id;
end;
$$;

revoke all on function public.begin_transport_phone_link(uuid,uuid,text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.begin_transport_phone_link(uuid,uuid,text,text,text,timestamptz) to service_role;
revoke all on function public.verify_transport_phone_link(uuid,uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.verify_transport_phone_link(uuid,uuid,text,timestamptz) to service_role;
revoke all on function public.cancel_transport_phone_link(uuid,uuid) from public, anon, authenticated;
grant execute on function public.cancel_transport_phone_link(uuid,uuid) to service_role;
revoke all on function public.transport_phone_link_status(uuid) from public, anon, authenticated;
grant execute on function public.transport_phone_link_status(uuid) to service_role;
revoke all on function public.unlink_transport_phone(uuid) from public, anon, authenticated;
grant execute on function public.unlink_transport_phone(uuid) to service_role;
revoke all on function public.correct_user_artifact(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.correct_user_artifact(uuid,uuid,text) to service_role;

insert into private.feature_flags (key, scope_type, scope_id, value, rollout_note, updated_by)
values ('phone_linking','global','*','false'::jsonb,'Verified app-to-rail relationship handoff','migration-020')
on conflict (key, scope_type, scope_id) do nothing;
