-- A verified phone proves which existing Co relationship this app session belongs to
-- without reassigning the phone or copying the member's history into a second profile

create table private.app_member_links (
  app_user_id uuid primary key references auth.users(id) on delete cascade,
  member_user_id uuid not null references public.profiles(id) on delete cascade,
  phone_hash text not null references private.phone_mappings(phone_hash) on delete cascade,
  verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index app_member_links_member_idx
  on private.app_member_links (member_user_id, verified_at desc);
revoke all on table private.app_member_links from public, anon, authenticated;

create or replace function public.resolve_transport_app_member(p_app_user_id uuid)
returns uuid
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce(
    (select link.member_user_id
     from private.app_member_links link
     where link.app_user_id = p_app_user_id),
    p_app_user_id
  );
$$;

create or replace function public.verify_transport_app_link(
  p_challenge_id uuid,
  p_app_user_id uuid,
  p_code_hash text,
  p_verified_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  challenge private.transport_phone_link_challenges%rowtype;
  member_user_id uuid;
begin
  if p_code_hash !~ '^[a-f0-9]{64}$'
     or p_verified_at < now() - interval '2 minutes'
     or p_verified_at > now() + interval '2 minutes' then
    raise exception 'invalid phone-link verification';
  end if;

  select * into challenge
  from private.transport_phone_link_challenges
  where id = p_challenge_id and user_id = p_app_user_id
  for update;
  if not found or challenge.consumed_at is not null
     or challenge.expires_at < p_verified_at or challenge.attempts >= 5 then
    return null;
  end if;

  update private.transport_phone_link_challenges
  set attempts = attempts + 1
  where id = p_challenge_id;
  if challenge.code_hash <> p_code_hash then return null; end if;

  -- An existing mapping is the canonical iMessage relationship and keeps its identity
  select mapping.user_id into member_user_id
  from private.phone_mappings mapping
  where mapping.phone_hash = challenge.phone_hash
  for update;

  if not found then
    member_user_id := p_app_user_id;
    delete from private.phone_mappings
    where user_id = member_user_id and phone_hash <> challenge.phone_hash;
    insert into private.phone_mappings (phone_hash, phone_last4, user_id, verified_at)
    values (challenge.phone_hash, challenge.phone_last4, member_user_id, p_verified_at);
  else
    update private.phone_mappings
    set phone_last4 = challenge.phone_last4,
        verified_at = greatest(verified_at, p_verified_at)
    where phone_hash = challenge.phone_hash;
  end if;

  insert into private.app_member_links (
    app_user_id, member_user_id, phone_hash, verified_at
  ) values (
    p_app_user_id, member_user_id, challenge.phone_hash, p_verified_at
  )
  on conflict (app_user_id) do update set
    member_user_id = excluded.member_user_id,
    phone_hash = excluded.phone_hash,
    verified_at = excluded.verified_at,
    updated_at = now();

  update private.transport_phone_link_challenges
  set consumed_at = p_verified_at
  where id = p_challenge_id;

  insert into public.audit_events (
    user_id, actor_type, actor_id, action, resource_type, resource_id, purpose,
    metadata
  ) values (
    member_user_id, 'user', p_app_user_id::text, 'transport.app_member_link',
    'profile', member_user_id::text, 'verified_relationship_handoff',
    jsonb_build_object('phone_last4', challenge.phone_last4)
  );

  return member_user_id;
end;
$$;

revoke all on function public.resolve_transport_app_member(uuid) from public, anon, authenticated;
grant execute on function public.resolve_transport_app_member(uuid) to service_role;
revoke all on function public.verify_transport_app_link(uuid,uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.verify_transport_app_link(uuid,uuid,text,timestamptz) to service_role;
