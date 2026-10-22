begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(11);

select ok(
  has_function_privilege('service_role', 'public.claim_api_rate_limit(text,text,integer,integer,timestamptz)', 'execute'),
  'server workers can atomically claim an API budget'
);
select ok(
  not has_function_privilege('authenticated', 'public.claim_api_rate_limit(text,text,integer,integer,timestamptz)', 'execute'),
  'authenticated clients cannot forge rate-limit claims'
);
select ok(
  not has_table_privilege('authenticated', 'private.api_rate_limits', 'select'),
  'rate-limit counters are private'
);

create temporary table claimed_results (
  label text primary key,
  allowed boolean,
  retry_after_seconds integer,
  current_count integer
);
grant insert, select on claimed_results to service_role;

set local role service_role;
insert into claimed_results select 'first', result.* from public.claim_api_rate_limit('user:one','captures.write',2,60,'2026-07-20 12:00:00+00') result;
insert into claimed_results select 'second', result.* from public.claim_api_rate_limit('user:one','captures.write',2,60,'2026-07-20 12:00:00+00') result;
insert into claimed_results select 'blocked', result.* from public.claim_api_rate_limit('user:one','captures.write',2,60,'2026-07-20 12:00:00+00') result;
insert into claimed_results select 'other-user', result.* from public.claim_api_rate_limit('user:two','captures.write',2,60,'2026-07-20 12:00:00+00') result;
insert into claimed_results select 'other-bucket', result.* from public.claim_api_rate_limit('user:one','account.export',2,60,'2026-07-20 12:00:00+00') result;
insert into claimed_results select 'reset', result.* from public.claim_api_rate_limit('user:one','captures.write',2,60,'2026-07-20 12:01:00+00') result;
reset role;

select ok((select allowed from claimed_results where label='first'), 'first request is allowed');
select is((select current_count from claimed_results where label='second'), 2, 'same user and bucket share an atomic counter');
select ok(not (select allowed from claimed_results where label='blocked'), 'request beyond the budget is blocked');
select is((select retry_after_seconds from claimed_results where label='blocked'), 60, 'blocked request receives a bounded retry delay');
select ok((select allowed from claimed_results where label='other-user'), 'different users do not share a budget');
select ok((select allowed from claimed_results where label='other-bucket'), 'different operations do not share a bucket');
select is((select current_count from claimed_results where label='reset'), 1, 'counter resets exactly at the next window');

set local role service_role;
select throws_ok(
  $$select * from public.claim_api_rate_limit('x','bad bucket',0,0,'2026-07-20 12:00:00+00')$$,
  '22023', null, 'invalid policies fail closed'
);
reset role;

select * from finish();
rollback;
