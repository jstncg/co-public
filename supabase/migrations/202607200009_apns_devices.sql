create unique index devices_user_apns_token_unique
on public.devices (user_id, apns_token)
where apns_token is not null;

create or replace function public.register_apns_device(
  p_user_id uuid,
  p_device_id uuid,
  p_apns_token text,
  p_apns_environment text,
  p_app_version text,
  p_os_version text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  registered_id uuid;
begin
  if p_apns_token !~ '^[a-f0-9]+$'
     or length(p_apns_token) not between 32 and 200
     or length(p_apns_token) % 2 <> 0
     or p_apns_environment not in ('sandbox', 'production')
     or length(p_app_version) not between 1 and 40
     or length(p_os_version) not between 1 and 80 then
    raise exception 'invalid APNs device';
  end if;

  if exists (select 1 from public.devices where id = p_device_id and user_id <> p_user_id) then
    raise exception 'device belongs to another user';
  end if;

  delete from public.devices
  where user_id = p_user_id and apns_token = p_apns_token and id <> p_device_id;

  insert into public.devices (
    id, user_id, apns_token, apns_environment, app_version, os_version, last_seen_at
  ) values (
    p_device_id, p_user_id, p_apns_token, p_apns_environment, p_app_version, p_os_version, now()
  )
  on conflict (id) do update set
    apns_token = excluded.apns_token,
    apns_environment = excluded.apns_environment,
    app_version = excluded.app_version,
    os_version = excluded.os_version,
    last_seen_at = excluded.last_seen_at
  where public.devices.user_id = p_user_id
  returning id into registered_id;

  if registered_id is null then raise exception 'device registration rejected'; end if;
  return registered_id;
end;
$$;

revoke all on function public.register_apns_device(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.register_apns_device(uuid, uuid, text, text, text, text) to service_role;
