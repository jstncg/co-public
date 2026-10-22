-- One database-owned lease decides which Edge invocation may run a native turn

create table private.app_chat_turn_claims (
  user_id uuid not null references public.profiles(id) on delete cascade,
  turn_id uuid not null,
  user_text text not null check (length(trim(user_text)) between 1 and 20000),
  status text not null check (status in ('pending', 'complete')),
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, turn_id)
);
create index app_chat_turn_claims_lease_idx
  on private.app_chat_turn_claims (lease_expires_at)
  where status = 'pending';
revoke all on table private.app_chat_turn_claims from public, anon, authenticated;

create or replace function public.claim_app_chat_turn(
  p_user_id uuid,
  p_turn_id uuid,
  p_user_text text,
  p_now timestamptz default now()
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  turn private.app_chat_turn_claims%rowtype;
  inserted_count integer;
begin
  if length(trim(p_user_text)) not between 1 and 20000
     or p_now < now() - interval '2 minutes'
     or p_now > now() + interval '2 minutes' then
    raise exception 'invalid app chat claim';
  end if;

  insert into private.app_chat_turn_claims (
    user_id, turn_id, user_text, status, lease_expires_at, updated_at
  ) values (
    p_user_id, p_turn_id, trim(p_user_text), 'pending', p_now + interval '5 minutes', p_now
  ) on conflict (user_id, turn_id) do nothing;
  get diagnostics inserted_count = row_count;

  select * into turn
  from private.app_chat_turn_claims claim
  where claim.user_id = p_user_id and claim.turn_id = p_turn_id
  for update;

  if trim(turn.user_text) <> trim(p_user_text) then
    raise exception 'turn text conflict';
  end if;
  if turn.status = 'complete' then
    return 'complete';
  end if;
  if inserted_count = 0 and turn.lease_expires_at > p_now then
    return 'busy';
  end if;

  update private.app_chat_turn_claims
  set status = 'pending', lease_expires_at = p_now + interval '5 minutes', updated_at = p_now
  where user_id = p_user_id and turn_id = p_turn_id;
  return 'claimed';
end;
$$;

create or replace function public.release_app_chat_turn(
  p_user_id uuid,
  p_turn_id uuid
) returns void
language sql
security definer
set search_path = ''
as $$
  update private.app_chat_turn_claims
  set lease_expires_at = now(), updated_at = now()
  where user_id = p_user_id and turn_id = p_turn_id and status = 'pending';
$$;

create or replace function public.complete_app_chat_turn(
  p_user_id uuid,
  p_turn_id uuid
) returns void
language sql
security definer
set search_path = ''
as $$
  update private.app_chat_turn_claims
  set status = 'complete', lease_expires_at = now(), updated_at = now()
  where user_id = p_user_id and turn_id = p_turn_id;
$$;

revoke all on function public.claim_app_chat_turn(uuid,uuid,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_app_chat_turn(uuid,uuid,text,timestamptz)
  to service_role;
revoke all on function public.release_app_chat_turn(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.release_app_chat_turn(uuid,uuid)
  to service_role;
revoke all on function public.complete_app_chat_turn(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.complete_app_chat_turn(uuid,uuid)
  to service_role;
