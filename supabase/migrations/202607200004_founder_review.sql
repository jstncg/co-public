alter table public.hypotheses
  add column proposed_copy text,
  add column reason_to_send text,
  add column proposed_move jsonb;

create or replace function public.founder_review_hypothesis(
  target_hypothesis_id uuid,
  reviewer text,
  review_decision text,
  edited_statement text default null,
  rubric_labels text[] default '{}'
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.hypotheses;
  active_consent public.consents;
  decision_id uuid;
begin
  if review_decision not in ('approve','edit','reject','unsafe') then
    raise exception 'invalid review decision';
  end if;
  if review_decision = 'edit' and nullif(trim(edited_statement), '') is null then
    raise exception 'edited statement required';
  end if;

  select * into target from public.hypotheses
  where id = target_hypothesis_id and status = 'review'
  for update;
  if not found then raise exception 'review target unavailable'; end if;

  select * into active_consent from public.consents
  where user_id = target.user_id
    and consent_type = 'founder_review'
    and revoked_at is null
    and expires_at is not null
    and expires_at > now()
  order by expires_at desc
  limit 1;
  if not found then raise exception 'active founder consent required'; end if;

  if review_decision in ('approve','edit') and not exists (
    select 1 from public.deliverable_hypotheses where id = target.id
  ) then
    raise exception 'pattern does not meet evidence delivery threshold';
  end if;

  update public.hypotheses
  set statement = case when review_decision = 'edit' then trim(edited_statement) else statement end,
      status = case when review_decision in ('approve','edit') then 'approved' else 'rejected' end,
      updated_at = now()
  where id = target_hypothesis_id;

  insert into private.review_decisions (
    user_id, target_type, target_id, reviewer_id, consent_id, consent_checked_at,
    decision, edits_json, rubric_labels
  ) values (
    target.user_id, 'hypothesis', target.id, reviewer, active_consent.id, now(),
    review_decision,
    case when review_decision = 'edit' then jsonb_build_object('statement', trim(edited_statement)) else '{}'::jsonb end,
    rubric_labels
  ) returning id into decision_id;

  insert into public.audit_events (
    user_id, actor_type, actor_id, action, resource_type, resource_id, purpose, metadata
  ) values (
    target.user_id, 'founder', reviewer, 'founder_review.' || review_decision,
    'hypothesis', target.id::text, 'consented_alpha_review',
    jsonb_build_object('consent_id', active_consent.id, 'consent_expires_at', active_consent.expires_at)
  );

  return decision_id;
end;
$$;

revoke all on function public.founder_review_hypothesis(uuid, text, text, text, text[]) from public, anon, authenticated;
grant execute on function public.founder_review_hypothesis(uuid, text, text, text, text[]) to service_role;
