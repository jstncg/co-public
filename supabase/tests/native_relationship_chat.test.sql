begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(15);

select has_column('private', 'app_member_links', 'transport_tenant',
                  'verified app links retain their rail tenant');
select ok(
  not has_function_privilege(
    'authenticated',
    'public.begin_app_chat_turn(uuid,uuid,text,timestamptz)',
    'execute'
  ),
  'only the trusted API can begin a native chat turn'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.transport_app_member_context(uuid)',
    'execute'
  ),
  'member context is never exposed directly to an app token'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.record_app_chat_turn(uuid,uuid,text,text,timestamptz,timestamptz)',
    'execute'
  ),
  'only the trusted API can record a native chat turn'
);

insert into auth.users (id, email, role, aud, created_at, updated_at)
values
  ('0298c5d2-bfed-75e0-b7d1-8a89b7c04210', 'native-member@example.test', 'authenticated', 'authenticated', now(), now()),
  ('0298c5d2-bfed-75e0-b7d1-8a89b7c04220', 'native-app@example.test', 'authenticated', 'authenticated', now(), now());

insert into private.phone_mappings (phone_hash, phone_last4, user_id, verified_at)
values (repeat('1', 64), '8200', '0298c5d2-bfed-75e0-b7d1-8a89b7c04210', now());

set local role service_role;
select lives_ok(
  $$select public.begin_transport_phone_link(
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04230',
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04220',
    repeat('1', 64), '8200', repeat('2', 64), now() + interval '5 minutes'
  )$$,
  'an app session can prove an existing iMessage number'
);
select is(
  public.verify_transport_app_link(
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04230',
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04220',
    repeat('2', 64), now(), repeat('1', 64), 'p15551000999'
  )::text,
  '0298c5d2-bfed-75e0-b7d1-8a89b7c04210',
  'verification joins the app to the existing canonical relationship'
);
select is(
  (select context.member_user_id::text
   from public.transport_app_member_context('0298c5d2-bfed-75e0-b7d1-8a89b7c04220') context),
  '0298c5d2-bfed-75e0-b7d1-8a89b7c04210',
  'the trusted API resolves the canonical member'
);
select is(
  (select context.transport_tenant
   from public.transport_app_member_context('0298c5d2-bfed-75e0-b7d1-8a89b7c04220') context),
  'p15551000999',
  'the trusted API resolves the same engine tenant'
);

select lives_ok(
  $$select public.begin_app_chat_turn(
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04210',
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04240',
    'what changed', now()
  )$$,
  'the inbound turn is durable before inference starts'
);
select is(
  (select count(*)::integer from public.messages
   where user_id = '0298c5d2-bfed-75e0-b7d1-8a89b7c04210' and transport = 'app'),
  1,
  'only the member message exists before the agent answers'
);
select throws_ok(
  $$select public.begin_app_chat_turn(
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04210',
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04240',
    'different meaning', now()
  )$$,
  'P0001',
  'turn text conflict',
  'one turn identity can never acquire different text'
);

select lives_ok(
  $$select public.record_app_chat_turn(
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04210',
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04240',
    'what changed', 'the price dropped', now(), now()
  )$$,
  'the native turn is recorded atomically'
);
select lives_ok(
  $$select public.record_app_chat_turn(
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04210',
    '0298c5d2-bfed-75e0-b7d1-8a89b7c04240',
    'what changed', 'the price dropped', now(), now()
  )$$,
  'retrying the same native turn is idempotent'
);
reset role;

select is(
  (select count(*)::integer from public.messages
   where user_id = '0298c5d2-bfed-75e0-b7d1-8a89b7c04210' and transport = 'app'),
  2,
  'one retry still produces exactly one inbound and one outbound message'
);
select is(
  (select string_agg(direction, ',' order by sent_at, direction)
   from public.messages
   where user_id = '0298c5d2-bfed-75e0-b7d1-8a89b7c04210' and transport = 'app'),
  'inbound,outbound',
  'the native transcript preserves both sides of the turn'
);

select * from finish();
rollback;
