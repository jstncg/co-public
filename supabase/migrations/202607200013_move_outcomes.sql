create unique index outcomes_one_per_move on public.outcomes (move_id);

create or replace function public.transition_user_move(
  p_user_id uuid,
  p_move_id uuid,
  p_next_status text,
  p_user_confirmed boolean
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare current_status text;
begin
  select status into current_status from public.moves
  where id = p_move_id and user_id = p_user_id for update;
  if not found then raise exception 'move unavailable'; end if;
  if not p_user_confirmed then raise exception 'final user confirmation required'; end if;
  if not (
    (current_status = 'prepared' and p_next_status in ('approved','dismissed')) or
    (current_status = 'approved' and p_next_status in ('completed','dismissed'))
  ) then raise exception 'invalid move transition'; end if;

  update public.moves set
    status = p_next_status,
    approved_at = case when p_next_status = 'approved' then now() else approved_at end,
    completed_at = case when p_next_status = 'completed' then now() else completed_at end,
    dismissed_at = case when p_next_status = 'dismissed' then now() else dismissed_at end,
    updated_at = now()
  where id = p_move_id and user_id = p_user_id;
  return p_next_status;
end;
$$;

create or replace function public.record_move_outcome(
  p_user_id uuid,
  p_move_id uuid,
  p_result text,
  p_value_rating integer,
  p_surprise_rating integer,
  p_repeat_intent text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.moves;
  outcome_id uuid;
begin
  if length(trim(p_result)) not between 1 and 500
     or p_value_rating not between 1 and 5
     or p_surprise_rating not between 1 and 5
     or p_repeat_intent not in ('yes','maybe','no') then
    raise exception 'invalid outcome';
  end if;
  select * into target from public.moves
  where id = p_move_id and user_id = p_user_id and status = 'completed' for update;
  if not found then raise exception 'completed move unavailable'; end if;

  insert into public.outcomes (user_id, move_id, result, value_rating, surprise_rating, repeat_intent)
  values (p_user_id, p_move_id, trim(p_result), p_value_rating, p_surprise_rating, p_repeat_intent)
  on conflict (move_id) do update set
    result = excluded.result,
    value_rating = excluded.value_rating,
    surprise_rating = excluded.surprise_rating,
    repeat_intent = excluded.repeat_intent
  returning id into outcome_id;

  if target.origin_type = 'artifact' and target.origin_id is not null then
    delete from public.observations
    where user_id = p_user_id and artifact_id = target.origin_id
      and observation_type = 'move_outcome'
      and evidence_span ->> 'move_id' = p_move_id::text;
    insert into public.observations (
      user_id, artifact_id, observation_type, statement, scope, confidence, evidence_span
    ) values (
      p_user_id, target.origin_id, 'move_outcome', trim(p_result),
      'this move under these conditions',
      case when p_value_rating >= 4 and p_repeat_intent = 'yes' then 0.85 else 0.55 end,
      jsonb_build_object('move_id', p_move_id, 'outcome_id', outcome_id)
    );
  end if;
  return outcome_id;
end;
$$;

revoke all on function public.transition_user_move(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.transition_user_move(uuid, uuid, text, boolean) to service_role;
revoke all on function public.record_move_outcome(uuid, uuid, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.record_move_outcome(uuid, uuid, text, integer, integer, text) to service_role;
