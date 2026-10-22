begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(4);

select ok(
  to_regprocedure('public.founder_weekly_metrics(timestamp with time zone)') is not null,
  'founder metrics function is installed'
);
select ok(
  to_regprocedure('public.hybrid_search_artifact_segments(uuid,text,extensions.vector,integer)') is not null,
  'hybrid retrieval function is installed'
);

set local role service_role;
select lives_ok(
  $$select public.founder_weekly_metrics('2026-07-20T00:00:00Z')$$,
  'founder metrics executes with its hardened empty search path'
);
select lives_ok(
  $$select * from public.hybrid_search_artifact_segments(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04110',
    'synthetic query',
    ('[' || rtrim(repeat('0,', 1536), ',') || ']')::extensions.vector(1536),
    5
  )$$,
  'hybrid retrieval resolves the schema-qualified vector operator'
);
reset role;

select * from finish();
rollback;
