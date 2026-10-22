create or replace function private.reject_raw_analytics() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  key text;
  allowed_keys constant text[] := array[
    'sourceType','sourceCoverage','mode','surface','result','reasonCode','moveType','feedback',
    'permissionState','retryBucket','durationBucket','latencyBucket','modelTier','count','dayIndex',
    'success','appVersion','osMajor'
  ];
begin
  if jsonb_typeof(new.properties) <> 'object' then
    raise exception 'analytics properties must be an object';
  end if;
  if (select count(*) from jsonb_object_keys(new.properties)) > 12 then
    raise exception 'too many analytics properties';
  end if;
  for key in select jsonb_object_keys(new.properties) loop
    if not (key = any(allowed_keys)) then
      raise exception 'analytics property is not allowlisted: %', key;
    end if;
  end loop;
  return new;
end;
$$;
