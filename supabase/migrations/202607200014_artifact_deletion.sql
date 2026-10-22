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
    'user_requested_deletion', jsonb_build_object('derived_memory_invalidated', true)
  );
  delete from public.artifacts where id = target_id and user_id = p_user_id;
end;
$$;

revoke all on function public.delete_user_artifact(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_user_artifact(uuid, uuid) to service_role;
