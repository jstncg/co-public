create or replace function public.record_pattern_feedback(
  p_user_id uuid,
  p_hypothesis_id uuid,
  p_verdict text,
  p_correction text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  feedback_id uuid;
begin
  if p_verdict not in ('right', 'partly', 'wrong', 'outdated')
     or (p_correction is not null and length(p_correction) > 500) then
    raise exception 'invalid pattern feedback';
  end if;
  if not exists (
    select 1 from public.hypotheses
    where id = p_hypothesis_id and user_id = p_user_id and status in ('approved', 'delivered')
  ) then raise exception 'pattern unavailable'; end if;

  insert into public.pattern_feedback (user_id, hypothesis_id, verdict, correction)
  values (p_user_id, p_hypothesis_id, p_verdict, nullif(trim(p_correction), ''))
  returning id into feedback_id;

  if p_verdict in ('wrong', 'outdated') then
    update public.hypotheses
    set status = case when p_verdict = 'wrong' then 'rejected' else 'outdated' end,
        updated_at = now()
    where id = p_hypothesis_id and user_id = p_user_id;
  end if;
  return feedback_id;
end;
$$;

revoke all on function public.record_pattern_feedback(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_pattern_feedback(uuid, uuid, text, text) to service_role;
