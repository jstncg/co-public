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

create or replace function private.claim_pattern_recompile_jobs(p_limit integer default 10)
returns table (job_id uuid, user_id uuid)
language sql
security definer
set search_path = ''
as $$
  with claims as (
    select id
    from private.job_runs
    where task_type = 'pattern_recompile'
      and status in ('queued', 'failed')
      and attempts < 5
    order by created_at
    for update skip locked
    limit least(greatest(p_limit, 1), 50)
  )
  update private.job_runs job
  set status = 'running', attempts = job.attempts + 1, updated_at = now(), error_class = null
  from claims
  where job.id = claims.id
  returning job.id, job.resource_id;
$$;

revoke all on function private.claim_pattern_recompile_jobs(integer) from public, anon, authenticated;
grant execute on function private.claim_pattern_recompile_jobs(integer) to service_role;
