create table private.api_rate_limits (
  scope_key text not null check (length(scope_key) between 3 and 200),
  bucket text not null check (bucket ~ '^[a-z0-9_.:-]{1,80}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (scope_key, bucket)
);

create index api_rate_limits_window_idx on private.api_rate_limits (window_started_at);

create or replace function public.claim_api_rate_limit(
  p_scope_key text,
  p_bucket text,
  p_limit integer,
  p_window_seconds integer,
  p_now timestamptz default now()
) returns table(allowed boolean, retry_after_seconds integer, current_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed private.api_rate_limits;
  window_length interval;
begin
  if length(coalesce(p_scope_key, '')) not between 3 and 200 then
    raise exception using errcode = '22023', message = 'invalid rate-limit scope';
  end if;
  if coalesce(p_bucket, '') !~ '^[a-z0-9_.:-]{1,80}$' then
    raise exception using errcode = '22023', message = 'invalid rate-limit bucket';
  end if;
  if p_limit not between 1 and 10000 or p_window_seconds not between 1 and 2592000 then
    raise exception using errcode = '22023', message = 'invalid rate-limit policy';
  end if;

  window_length := pg_catalog.make_interval(secs => p_window_seconds);
  insert into private.api_rate_limits (scope_key, bucket, window_started_at, request_count, updated_at)
  values (p_scope_key, p_bucket, p_now, 1, p_now)
  on conflict (scope_key, bucket) do update set
    window_started_at = case
      when private.api_rate_limits.window_started_at + window_length <= p_now then p_now
      else private.api_rate_limits.window_started_at
    end,
    request_count = case
      when private.api_rate_limits.window_started_at + window_length <= p_now then 1
      else private.api_rate_limits.request_count + 1
    end,
    updated_at = p_now
  returning * into claimed;

  return query select
    claimed.request_count <= p_limit,
    case when claimed.request_count <= p_limit then 0 else greatest(
      1,
      ceil(extract(epoch from (claimed.window_started_at + window_length - p_now)))::integer
    ) end,
    claimed.request_count;
end;
$$;

revoke all on table private.api_rate_limits from public, anon, authenticated;
revoke all on function public.claim_api_rate_limit(text, text, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_api_rate_limit(text, text, integer, integer, timestamptz) to service_role;
