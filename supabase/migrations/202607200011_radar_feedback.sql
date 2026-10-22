create or replace function public.record_radar_feedback(
  p_user_id uuid,
  p_candidate_id uuid,
  p_feedback text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.radar_candidates;
  event_type_value text;
  feedback_id uuid;
begin
  if p_feedback not in ('useful','not_relevant','too_late','already_knew','too_creepy','mute_entity','mute_event_type') then
    raise exception 'invalid radar feedback';
  end if;
  select * into candidate from public.radar_candidates
  where id = p_candidate_id and user_id = p_user_id for update;
  if not found then raise exception 'radar item unavailable'; end if;

  insert into public.watch_feedback (user_id, watch_entity_id, radar_candidate_id, feedback, policy_mutation)
  values (
    p_user_id, candidate.watch_entity_id, candidate.id, p_feedback,
    case
      when p_feedback = 'mute_entity' then jsonb_build_object('paused', true)
      when p_feedback = 'mute_event_type' then jsonb_build_object('excluded_event_type', (select event_type from public.world_events where id = candidate.world_event_id))
      else '{}'::jsonb
    end
  ) returning id into feedback_id;

  if p_feedback = 'mute_entity' then
    update public.watch_entities set paused_at = now(), updated_at = now()
    where id = candidate.watch_entity_id and user_id = p_user_id;
  elsif p_feedback = 'mute_event_type' then
    select event_type into event_type_value from public.world_events where id = candidate.world_event_id;
    update public.watch_entities
    set excluded_event_types = case
      when event_type_value = any(excluded_event_types) then excluded_event_types
      else array_append(excluded_event_types, event_type_value)
    end,
    updated_at = now()
    where id = candidate.watch_entity_id and user_id = p_user_id;
  end if;

  update public.radar_candidates set status = case
    when p_feedback in ('not_relevant','too_creepy') then 'dismissed'
    when p_feedback in ('mute_entity','mute_event_type') then 'muted'
    else 'opened'
  end where id = candidate.id and user_id = p_user_id;
  return feedback_id;
end;
$$;

revoke all on function public.record_radar_feedback(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_radar_feedback(uuid, uuid, text) to service_role;
