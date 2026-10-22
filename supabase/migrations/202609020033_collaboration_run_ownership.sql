-- A collaboration idempotency key names one immutable request, and one leased worker owns execution.

alter table public.collaboration_runs
  add column request_payload jsonb,
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add constraint collaboration_runs_request_payload_object
    check (request_payload is null or jsonb_typeof(request_payload) = 'object'),
  add constraint collaboration_runs_lease_pair
    check ((lease_token is null) = (lease_expires_at is null));

create index collaboration_runs_lease_idx
  on public.collaboration_runs (state, lease_expires_at)
  where state = 'running';

create or replace function private.clear_terminal_collaboration_lease()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state in ('succeeded', 'failed', 'cancelled', 'budget_exhausted') then
    new.lease_token := null;
    new.lease_expires_at := null;
  end if;
  return new;
end;
$$;

create trigger collaboration_runs_clear_terminal_lease
before update of state on public.collaboration_runs
for each row execute function private.clear_terminal_collaboration_lease();

create or replace function public.enqueue_collaboration_run(
  p_user_id uuid,
  p_request_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored public.collaboration_runs%rowtype;
  created boolean := false;
begin
  if jsonb_typeof(p_request_payload) <> 'object'
     or p_request_payload ->> 'tenant_id' <> p_user_id::text then
    raise exception using errcode = '22023', message = 'invalid collaboration request scope';
  end if;

  insert into public.collaboration_runs (
    user_id,
    idempotency_key,
    objective,
    state,
    evidence_packet,
    token_budget,
    max_concurrency,
    max_retries_per_task,
    request_payload
  ) values (
    p_user_id,
    p_request_payload ->> 'idempotency_key',
    p_request_payload ->> 'objective',
    'queued',
    p_request_payload -> 'evidence_packet',
    p_request_payload -> 'token_budget',
    (p_request_payload ->> 'max_concurrency')::smallint,
    (p_request_payload ->> 'max_retries_per_task')::smallint,
    p_request_payload
  )
  on conflict (user_id, idempotency_key) do nothing
  returning * into stored;

  if found then
    created := true;
  else
    select * into strict stored
    from public.collaboration_runs
    where user_id = p_user_id
      and idempotency_key = p_request_payload ->> 'idempotency_key'
    for update;
    if stored.request_payload is null or stored.request_payload <> p_request_payload then
      raise exception using errcode = '22000', message = 'collaboration idempotency collision';
    end if;
  end if;

  return jsonb_build_object(
    'run_id', stored.id,
    'state', stored.state,
    'created_at', stored.created_at,
    'deduped', not created
  );
end;
$$;

create or replace function public.claim_collaboration_run(
  p_user_id uuid,
  p_run_id uuid,
  p_request_payload jsonb,
  p_lease_seconds integer default 1200
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored public.collaboration_runs%rowtype;
  token uuid;
begin
  if p_lease_seconds not between 60 and 1800 then
    raise exception using errcode = '22023', message = 'invalid collaboration lease duration';
  end if;

  select * into strict stored
  from public.collaboration_runs
  where id = p_run_id and user_id = p_user_id
  for update;

  if stored.request_payload is null or stored.request_payload <> p_request_payload then
    raise exception using errcode = '22000', message = 'collaboration request mismatch';
  end if;
  if stored.state in ('succeeded', 'failed', 'cancelled', 'budget_exhausted') then
    return jsonb_build_object('claimed', false, 'run_id', stored.id, 'state', stored.state);
  end if;
  if stored.state = 'running' and stored.lease_expires_at > now() then
    return jsonb_build_object('claimed', false, 'run_id', stored.id, 'state', stored.state);
  end if;

  token := gen_random_uuid();
  update public.collaboration_runs
  set state = 'running',
      lease_token = token,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      started_at = coalesce(started_at, now()),
      completed_at = null
  where id = stored.id;

  return jsonb_build_object(
    'claimed', true,
    'run_id', stored.id,
    'state', 'running',
    'lease_token', token
  );
end;
$$;

create or replace function public.renew_collaboration_run_lease(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 1200
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_lease_seconds not between 60 and 1800 then
    raise exception using errcode = '22023', message = 'invalid collaboration lease duration';
  end if;
  update public.collaboration_runs
  set lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_run_id
    and user_id = p_user_id
    and state = 'running'
    and lease_token = p_lease_token;
  return found;
end;
$$;

create or replace function public.finish_collaboration_run(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_state text,
  p_input_tokens integer default 0,
  p_output_tokens integer default 0,
  p_cached_input_tokens integer default 0
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_state not in ('succeeded', 'failed', 'budget_exhausted')
     or least(p_input_tokens, p_output_tokens, p_cached_input_tokens) < 0 then
    raise exception using errcode = '22023', message = 'invalid collaboration completion';
  end if;
  update public.collaboration_runs
  set state = p_state,
      input_tokens = p_input_tokens,
      output_tokens = p_output_tokens,
      cached_input_tokens = p_cached_input_tokens,
      lease_token = null,
      lease_expires_at = null,
      completed_at = now()
  where id = p_run_id
    and user_id = p_user_id
    and state = 'running'
    and lease_token = p_lease_token;
  return found;
end;
$$;

revoke all on function public.enqueue_collaboration_run(uuid,jsonb) from public, anon, authenticated;
revoke all on function public.claim_collaboration_run(uuid,uuid,jsonb,integer) from public, anon, authenticated;
revoke all on function public.renew_collaboration_run_lease(uuid,uuid,uuid,integer) from public, anon, authenticated;
revoke all on function public.finish_collaboration_run(uuid,uuid,uuid,text,integer,integer,integer) from public, anon, authenticated;
grant execute on function public.enqueue_collaboration_run(uuid,jsonb) to service_role;
grant execute on function public.claim_collaboration_run(uuid,uuid,jsonb,integer) to service_role;
grant execute on function public.renew_collaboration_run_lease(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.finish_collaboration_run(uuid,uuid,uuid,text,integer,integer,integer) to service_role;
