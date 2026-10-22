begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(25);

select has_table('public', 'conversations', 'conversations table exists');
select has_table('public', 'messages', 'messages table exists');
select has_table('public', 'message_artifacts', 'message-artifact link table exists');
select has_table('public', 'interaction_policies', 'standing-order table exists');
select has_table('private', 'phone_mappings', 'private phone mapping table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.messages'::regclass),
  'messages has row-level security enabled'
);
select ok(has_table_privilege('authenticated', 'public.messages', 'select'), 'authenticated users may read their rail');
select ok(not has_table_privilege('authenticated', 'public.messages', 'insert'), 'authenticated users cannot insert canonical messages');
select ok(
  not has_function_privilege(
    'authenticated',
    'public.ingest_transport_message(text,text,text,text,text,text,text,text,text[],timestamptz,text,jsonb,jsonb)',
    'execute'
  ),
  'authenticated users cannot execute transport ingest'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.ingest_transport_message(text,text,text,text,text,text,text,text,text[],timestamptz,text,jsonb,jsonb)',
    'execute'
  ),
  'service role can execute transport ingest'
);

insert into auth.users (id, email, role, aud, created_at, updated_at)
values
  ('0198c5d2-bfed-75e0-b7d1-8a89b7c04110', 'transport-one@example.test', 'authenticated', 'authenticated', now(), now()),
  ('0198c5d2-bfed-75e0-b7d1-8a89b7c04120', 'transport-two@example.test', 'authenticated', 'authenticated', now(), now());

set local role service_role;
select lives_ok(
  $$select public.link_verified_transport_phone(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04110', repeat('a', 64), '4567', now()
  )$$,
  'service role can provision the first verified phone mapping'
);
select lives_ok(
  $$select public.link_verified_transport_phone(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04120', repeat('b', 64), '7654', now()
  )$$,
  'service role can provision a second isolated phone mapping'
);

select is(
  (select deduped from public.ingest_transport_message(
    repeat('a', 64), 'sendblue', '+15551234567', 'sendblue:message-1', 'message-1', null,
    'inbound', 'https://example.com/watch', array[]::text[], '2026-07-20T19:00:00Z', null,
    '{}'::jsonb,
    '[{"source_type":"youtube","canonical_url":"https://example.com/watch","coverage":"full_media","extraction":"specific rail watch","timestamp_seconds":null}]'::jsonb
  )),
  false,
  'first transport message is stored'
);
select is(
  (select deduped from public.ingest_transport_message(
    repeat('a', 64), 'sendblue', '+15551234567', 'sendblue:message-1', 'message-1', null,
    'inbound', 'https://example.com/watch', array[]::text[], '2026-07-20T19:00:00Z', null,
    '{}'::jsonb,
    '[{"source_type":"youtube","canonical_url":"https://example.com/watch","coverage":"full_media","extraction":"specific rail watch","timestamp_seconds":null}]'::jsonb
  )),
  true,
  'exact replay returns a successful dedupe'
);
reset role;

select is(
  (select count(*)::integer from public.messages where user_id = '0198c5d2-bfed-75e0-b7d1-8a89b7c04110'),
  1,
  'replay creates one canonical message'
);
select is(
  (select count(*)::integer from public.artifacts where user_id = '0198c5d2-bfed-75e0-b7d1-8a89b7c04110'),
  1,
  'artifact is created atomically'
);
select is(
  (select count(*)::integer from public.message_artifacts where user_id = '0198c5d2-bfed-75e0-b7d1-8a89b7c04110'),
  1,
  'artifact link is created atomically'
);

set local role service_role;
select is(
  public.apply_transport_status(
    repeat('a', 64), 'sendblue', 'message-1', 'READ', '2026-07-20T19:01:00Z', null
  )::text,
  (select id::text from public.messages where external_message_id = 'message-1'),
  'read callback resolves the existing message'
);
reset role;
select is(
  (select read_at::text from public.messages where external_message_id = 'message-1'),
  '2026-07-20 19:01:00+00',
  'read callback stores the first read timestamp'
);

set local role service_role;
select throws_ok(
  $$select * from public.ingest_transport_message(
    repeat('c', 64), 'sendblue', '+15550000000', 'sendblue:unknown', 'unknown', null,
    'inbound', 'unknown', array[]::text[], now(), null, '{}'::jsonb, '[]'::jsonb
  )$$,
  'P0001',
  'unknown transport tenant',
  'unknown phones cannot self-register through ingest'
);
select is(
  public.apply_transport_status(
    repeat('a', 64), 'sendblue', 'message-before-ingest', 'DELIVERED', now(), null
  ),
  null,
  'status before message remains retryable and creates no row'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '0198c5d2-bfed-75e0-b7d1-8a89b7c04110', true);
select is((select count(*)::integer from public.messages), 1, 'first user can read their message');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '0198c5d2-bfed-75e0-b7d1-8a89b7c04120', true);
select is((select count(*)::integer from public.messages), 0, 'second user cannot read the first user rail');
select throws_ok(
  $$insert into public.messages (
    conversation_id, user_id, transport, idempotency_key, external_message_id,
    direction, text, sent_at
  ) select conversation_id, user_id, transport, 'forbidden', 'forbidden', direction, text, sent_at
    from public.messages limit 1$$,
  '42501',
  'permission denied for table messages',
  'authenticated users cannot forge canonical messages'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '0198c5d2-bfed-75e0-b7d1-8a89b7c04110', true);
select lives_ok(
  $$insert into public.interaction_policies (user_id, instruction, scope, exact_receipt)
    select user_id, 'stop asking follow-up questions', 'all', id
    from public.messages where external_message_id = 'message-1'$$,
  'a user can persist a standing order against their own exact receipt'
);
reset role;

select * from finish();
rollback;
