create unique index annotations_one_why_per_artifact
on public.annotations (artifact_id)
where annotation_type = 'why';

create or replace function public.set_why_annotation(
  p_user_id uuid,
  p_client_artifact_id uuid,
  p_value text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_artifact_id uuid;
  answer_options jsonb;
  annotation_id uuid;
begin
  if length(p_value) < 1 or length(p_value) > 60 then
    raise exception 'invalid why answer';
  end if;

  select a.id, r.why_question -> 'options'
    into target_artifact_id, answer_options
  from public.artifacts a
  join public.artifact_responses r
    on r.artifact_id = a.id and r.user_id = p_user_id
  where a.user_id = p_user_id
    and a.client_artifact_id = p_client_artifact_id;

  if target_artifact_id is null or answer_options is null
     or not answer_options @> jsonb_build_array(p_value) then
    raise exception 'why answer is not an offered option';
  end if;

  insert into public.annotations (artifact_id, user_id, annotation_type, value)
  values (target_artifact_id, p_user_id, 'why', p_value)
  on conflict (artifact_id) where annotation_type = 'why'
  do update set value = excluded.value, free_text = null, created_at = now()
  returning id into annotation_id;

  return annotation_id;
end;
$$;

revoke all on function public.set_why_annotation(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_why_annotation(uuid, uuid, text) to service_role;
