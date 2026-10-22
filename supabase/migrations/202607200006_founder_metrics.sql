create or replace function public.founder_weekly_metrics(report_end timestamptz default now())
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
with
report_window as (
  select report_end - interval '7 days' as starts_at, report_end as ends_at
),
onboarded as (
  select id, created_at from public.profiles where created_at <= report_end
),
activated as (
  select distinct user_id from public.artifacts where deleted_at is null and captured_at <= report_end
),
habit as (
  select profile.id as user_id
  from onboarded profile
  join public.artifacts artifact on artifact.user_id = profile.id
    and artifact.deleted_at is null
    and artifact.captured_at >= profile.created_at
    and artifact.captured_at < profile.created_at + interval '7 days'
  group by profile.id
  having count(distinct artifact.captured_at::date) >= 3
),
moment_qualified as (
  select user_id
  from public.artifacts
  where deleted_at is null and captured_at <= report_end
  group by user_id
  having count(*) >= 5 and count(distinct captured_at::date) >= 3
),
why_qualified as (
  select user_id from public.annotations
  where annotation_type = 'why' and created_at <= report_end
  group by user_id having count(*) >= 3
),
qualified as (
  select moment.user_id
  from moment_qualified moment
  join why_qualified why on why.user_id = moment.user_id
  where exists (
    select 1 from public.hypotheses hypothesis
    where hypothesis.user_id = moment.user_id and hypothesis.status in ('approved','delivered')
  )
),
pattern_movers as (
  select distinct move.user_id from public.moves move, report_window
  where move.origin_type = 'hypothesis' and move.status = 'completed'
    and move.completed_at >= report_window.starts_at and move.completed_at < report_window.ends_at
),
week_four_eligible as (
  select id, created_at from onboarded where created_at <= report_end - interval '28 days'
),
week_four_retained as (
  select distinct profile.id
  from week_four_eligible profile
  join public.artifacts artifact on artifact.user_id = profile.id and artifact.deleted_at is null
    and artifact.captured_at >= profile.created_at + interval '21 days'
    and artifact.captured_at < profile.created_at + interval '28 days'
),
radar_recipients as (
  select distinct callback.user_id from public.callbacks callback, report_window
  where callback.callback_type = 'radar' and callback.sent_at >= report_window.starts_at and callback.sent_at < report_window.ends_at
),
radar_useful as (
  select distinct feedback.user_id from public.watch_feedback feedback, report_window
  where feedback.feedback = 'useful' and feedback.created_at >= report_window.starts_at and feedback.created_at < report_window.ends_at
  union
  select distinct move.user_id from public.moves move, report_window
  where move.origin_type = 'radar' and move.status = 'completed'
    and move.completed_at >= report_window.starts_at and move.completed_at < report_window.ends_at
),
notification_enabled as (
  select distinct user_id from public.product_events
  where event_name = 'notifications_granted' and occurred_at <= report_end
),
notification_muted as (
  select distinct user_id from public.product_events, report_window
  where event_name = 'radar_feedback' and properties->>'feedback' = 'mute'
    and occurred_at >= report_window.starts_at and occurred_at < report_window.ends_at
),
review_totals as (
  select count(*)::integer as decisions,
    count(*) filter (where decision in ('edit','reject','unsafe'))::integer as edited_or_rejected
  from private.review_decisions, report_window
  where created_at >= report_window.starts_at and created_at < report_window.ends_at
),
active as (
  select distinct user_id from public.artifacts, report_window
  where deleted_at is null and captured_at >= report_window.starts_at and captured_at < report_window.ends_at
),
cost as (
  select coalesce(sum(estimated_cost), 0)::numeric as total from private.model_runs, report_window
  where created_at >= report_window.starts_at and created_at < report_window.ends_at
),
requests as (
  select
    count(*) filter (where request_type = 'delete_account')::integer as deletions,
    count(*) filter (where request_type = 'export')::integer as exports
  from public.data_requests, report_window
  where requested_at >= report_window.starts_at and requested_at < report_window.ends_at
),
invites as (
  select count(*)::integer as total from public.product_events, report_window
  where event_name = 'invite_sent' and occurred_at >= report_window.starts_at and occurred_at < report_window.ends_at
),
counts as (
  select
    (select count(*) from onboarded)::integer as onboarded_users,
    (select count(*) from activated)::integer as activated_users,
    (select count(*) from habit)::integer as habit_users,
    (select count(*) from qualified)::integer as qualified_users,
    (select count(*) from qualified join pattern_movers using (user_id))::integer as pattern_move_users,
    (select count(*) from week_four_eligible)::integer as week_four_eligible_users,
    (select count(*) from week_four_retained)::integer as week_four_retained_users,
    (select count(*) from radar_recipients)::integer as radar_recipient_users,
    (select count(*) from radar_recipients join radar_useful using (user_id))::integer as radar_useful_users,
    (select count(*) from notification_enabled)::integer as notification_enabled_users,
    (select count(*) from notification_enabled join notification_muted using (user_id))::integer as notification_muted_users,
    (select decisions from review_totals) as founder_decisions,
    (select edited_or_rejected from review_totals) as founder_edited_or_rejected,
    (select count(*) from active)::integer as active_users,
    (select total from cost) as model_cost,
    (select deletions from requests) as deletion_requests,
    (select exports from requests) as export_requests,
    (select total from invites) as invites
)
select jsonb_build_object(
  'windowStart', (select starts_at from report_window),
  'windowEnd', report_end,
  'counts', to_jsonb(counts),
  'rates', jsonb_build_object(
    'activationRate', round(activated_users::numeric / nullif(onboarded_users, 0), 4),
    'threeDaySaveHabitRate', round(habit_users::numeric / nullif(activated_users, 0), 4),
    'patternToMoveRate', round(pattern_move_users::numeric / nullif(qualified_users, 0), 4),
    'weekFourRetentionRate', round(week_four_retained_users::numeric / nullif(week_four_eligible_users, 0), 4),
    'radarUsefulActionRate', round(radar_useful_users::numeric / nullif(radar_recipient_users, 0), 4),
    'notificationMuteRate', round(notification_muted_users::numeric / nullif(notification_enabled_users, 0), 4),
    'founderEditRejectRate', round(founder_edited_or_rejected::numeric / nullif(founder_decisions, 0), 4),
    'averageModelCostPerActiveUser', round(model_cost / nullif(active_users, 0), 6)
  ),
  'killLine', jsonb_build_object(
    'eligible', onboarded_users >= 100 and qualified_users >= 50 and report_end >= '2026-09-12T00:00:00Z'::timestamptz,
    'patternThreshold', 0.25,
    'habitThreshold', 0.35,
    'triggered', case when onboarded_users >= 100 and qualified_users >= 50 and report_end >= '2026-09-12T00:00:00Z'::timestamptz
      then coalesce(pattern_move_users::numeric / nullif(qualified_users, 0), 0) < 0.25
        or coalesce(habit_users::numeric / nullif(onboarded_users, 0), 0) < 0.35
      else false end
  )
)
from counts;
$$;

revoke all on function public.founder_weekly_metrics(timestamptz) from public, anon, authenticated;
grant execute on function public.founder_weekly_metrics(timestamptz) to service_role;
