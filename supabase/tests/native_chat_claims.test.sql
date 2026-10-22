begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(11);

select ok(
  not has_function_privilege('authenticated', 'public.claim_app_chat_turn(uuid,uuid,text,timestamptz)', 'execute'),
  'app clients cannot forge turn ownership'
);
select ok(
  not has_table_privilege('authenticated', 'private.app_chat_turn_claims', 'select'),
  'turn leases stay private'
);

insert into auth.users (id, email, role, aud, created_at, updated_at)
values ('0298c5d2-bfed-75e0-b7d1-8a89b7c04310', 'native-lease@example.test',
        'authenticated', 'authenticated', now(), now());

set local role service_role;
select is(
  public.claim_app_chat_turn(
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04310',
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04320', 'one meaning', now()
  ), 'claimed', 'the first worker owns the turn'
);
select is(
  public.claim_app_chat_turn(
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04310',
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04320', 'one meaning', now()
  ), 'busy', 'a concurrent worker cannot duplicate inference'
);
select throws_ok(
  $$select public.claim_app_chat_turn(
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04310',
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04320', 'different meaning', now()
  )$$,
  'P0001', 'turn text conflict', 'one turn identity cannot change meaning'
);
select lives_ok(
  $$select public.release_app_chat_turn(
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04310',
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04320'
  )$$,
  'a failed owner can release its lease'
);
select is(
  public.claim_app_chat_turn(
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04310',
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04320', 'one meaning', now()
  ), 'claimed', 'a released turn can be retried immediately'
);
select lives_ok(
  $$select public.complete_app_chat_turn(
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04310',
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04320'
  )$$,
  'the owner can complete the lease'
);
select is(
  public.claim_app_chat_turn(
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04310',
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04320', 'one meaning', now()
  ), 'complete', 'a completed turn never runs again'
);
reset role;
select is(
  (select count(*)::integer from private.app_chat_turn_claims),
  1, 'one turn has one lease row'
);
select is(
  (select status from private.app_chat_turn_claims),
  'complete', 'the durable terminal state is explicit'
);

select * from finish();
rollback;
