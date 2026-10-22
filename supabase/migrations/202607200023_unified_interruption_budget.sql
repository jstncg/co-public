-- Week 4: every organic callback shares one queue, unread gate, quiet-hours policy, and budget.

alter table public.callbacks drop constraint callbacks_callback_type_check;
alter table public.callbacks add constraint callbacks_callback_type_check check (
  callback_type in (
    'pattern','radar','reminder','weekly','outcome','return','event_anchor',
    'second_opinion','reflection','absence'
  )
);
alter table public.callbacks
  add column delivery_claimed_at timestamptz,
  add column inbox_only_at timestamptz,
  add column suppression_reason text check (suppression_reason is null or suppression_reason in ('quiet_hours','weekly_cap','unread_previous','no_registered_device'));
create index callbacks_due_priority_idx on public.callbacks (scheduled_at)
  where sent_at is null and inbox_only_at is null;

create or replace function public.claim_due_callbacks(p_limit integer default 50)
returns table (callback_id uuid, user_id uuid)
language sql
security definer
set search_path = ''
as $$
  with claims as (
    select callback.id
    from public.callbacks callback
    where callback.sent_at is null
      and callback.inbox_only_at is null
      and callback.scheduled_at <= now()
      and (callback.delivery_claimed_at is null or callback.delivery_claimed_at < now() - interval '10 minutes')
    order by case callback.callback_type
      when 'reminder' then 0 when 'event_anchor' then 1 when 'outcome' then 1
      when 'radar' then 2 when 'second_opinion' then 3 when 'pattern' then 4
      when 'return' then 4 when 'reflection' then 5 when 'weekly' then 5 else 6 end,
      callback.scheduled_at
    for update skip locked
    limit least(greatest(p_limit,1),100)
  )
  update public.callbacks callback set delivery_claimed_at = now()
  from claims where callback.id = claims.id
  returning callback.id, callback.user_id;
$$;
revoke all on function public.claim_due_callbacks(integer) from public, anon, authenticated;
grant execute on function public.claim_due_callbacks(integer) to service_role;

