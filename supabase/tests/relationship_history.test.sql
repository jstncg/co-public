begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(30);

select has_table('private', 'transport_phone_link_challenges', 'private phone-link challenges exist');
select has_table('private', 'app_member_links', 'verified app sessions are linked privately');
select ok(
  not has_function_privilege(
    'authenticated',
    'public.begin_transport_phone_link(uuid,uuid,text,text,text,timestamptz)',
    'execute'
  ),
  'authenticated callers cannot manufacture verified phone challenges'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.verify_transport_app_link(uuid,uuid,text,timestamptz)',
    'execute'
  ),
  'authenticated callers cannot manufacture app-to-member links'
);

insert into auth.users (id, email, role, aud, created_at, updated_at)
values
  ('0198c5d2-bfed-75e0-b7d1-8a89b7c04210', 'history-one@example.test', 'authenticated', 'authenticated', now(), now()),
  ('0198c5d2-bfed-75e0-b7d1-8a89b7c04220', 'history-two@example.test', 'authenticated', 'authenticated', now(), now()),
  ('0198c5d2-bfed-75e0-b7d1-8a89b7c04290', 'history-app@example.test', 'authenticated', 'authenticated', now(), now());

set local role service_role;
select is(
  public.begin_transport_phone_link(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04211',
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04210',
    repeat('c', 64), '0123', repeat('d', 64), now() + interval '5 minutes'
  )::text,
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04211',
  'service creates a bounded hashed challenge'
);
select is(
  public.verify_transport_phone_link(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04211',
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04210', repeat('e', 64), now()
  ),
  false,
  'an incorrect code hash does not link the phone'
);
select is(
  public.verify_transport_phone_link(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04211',
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04210', repeat('d', 64), now()
  ),
  true,
  'the matching code hash links the phone exactly once'
);
select is(
  (select phone_last4 from public.transport_phone_link_status('0198c5d2-bfed-75e0-b7d1-8a89b7c04210')),
  '0123',
  'link status reveals only the last four digits'
);
select is(
  public.verify_transport_phone_link(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04211',
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04210', repeat('d', 64), now()
  ),
  false,
  'a consumed challenge cannot be replayed'
);
select lives_ok(
  $$select public.begin_transport_phone_link(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04221',
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04220',
    repeat('c', 64), '0123', repeat('f', 64), now() + interval '5 minutes'
  )$$,
  'the same phone may receive a challenge for recovery without changing ownership'
);
select throws_ok(
  $$select public.verify_transport_phone_link(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04221',
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04220', repeat('f', 64), now()
  )$$,
  'P0001', 'phone already linked',
  'a verified phone cannot be silently reassigned to another account'
);
reset role;
select is(
  (select user_id::text from private.phone_mappings where phone_hash = repeat('c', 64)),
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04210',
  'failed reassignment preserves the original owner'
);

set local role service_role;
select lives_ok(
  $$select public.begin_transport_phone_link(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04291',
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04290',
    repeat('c', 64), '0123', repeat('a', 64), now() + interval '5 minutes'
  )$$,
  'an app session may prove ownership of a phone that already has a relationship'
);
select is(
  public.verify_transport_app_link(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04291',
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04290', repeat('a', 64), now()
  )::text,
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04210',
  'verified ownership resolves the app onto the existing canonical member'
);
select is(
  public.resolve_transport_app_member('0198c5d2-bfed-75e0-b7d1-8a89b7c04290')::text,
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04210',
  'subsequent app requests resolve to the canonical member'
);
reset role;
select is(
  (select member_user_id::text from private.app_member_links
   where app_user_id = '0198c5d2-bfed-75e0-b7d1-8a89b7c04290'),
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04210',
  'the private session link retains explicit lineage'
);
set local role service_role;
select is(
  public.verify_transport_app_link(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04291',
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04290', repeat('a', 64), now()
  )::text,
  null,
  'the verified handoff cannot be replayed'
);
reset role;

insert into public.artifacts (
  id, user_id, client_artifact_id, idempotency_key, source_type, captured_at,
  raw_text, source_coverage, analysis_allowed, processing_status
) values (
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04230',
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04210',
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04231', 'history:artifact', 'text', now(),
  'the original evidence', 'text', true, 'ready'
);
insert into public.observations (id, user_id, artifact_id, observation_type, statement, scope, confidence)
values (
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04232',
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04210',
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04230', 'interest', 'old reading', 'artifact', 0.8
);
insert into public.hypotheses (id, user_id, statement, alternatives_json, confidence, sensitivity, status)
values (
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04233',
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04210', 'old hypothesis', '["another explanation"]', 0.7, 'low', 'approved'
);
insert into public.evidence_links (user_id, hypothesis_id, artifact_id, observation_id, direction)
values (
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04210',
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04233',
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04230',
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04232', 'support'
);
insert into public.conversations (id, user_id, transport, external_thread_id)
values (
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04234',
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04210', 'sendblue', '+14155550123'
);
insert into public.messages (
  id, conversation_id, user_id, transport, idempotency_key, external_message_id,
  direction, text, sent_at, artifact_ids
) values (
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04235',
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04234',
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04210', 'sendblue', 'history:message', 'history-message',
  'inbound', 'the original evidence', now(), array['0198c5d2-bfed-75e0-b7d1-8a89b7c04230'::uuid]
);
insert into public.message_artifacts (message_id, artifact_id, user_id)
values (
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04235',
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04230',
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04210'
);

set local role service_role;
select isnt(
  public.correct_user_artifact(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04210',
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04231', 'this was about the room, not the topic'
  ),
  null,
  'an owned artifact accepts an explicit correction'
);
reset role;
select is((select count(*)::integer from public.annotations where annotation_type = 'correction'), 1, 'correction is retained as user evidence');
select ok((select invalidated_at is not null from public.observations where id = '0198c5d2-bfed-75e0-b7d1-8a89b7c04232'), 'correction invalidates the old observation');
select is((select status from public.hypotheses where id = '0198c5d2-bfed-75e0-b7d1-8a89b7c04233'), 'outdated', 'correction outdates derived hypotheses');
select is((select count(*)::integer from private.job_runs where resource_version = 'artifact-correction.v1'), 1, 'correction queues recompilation');

set local role service_role;
select lives_ok(
  $$select public.delete_user_artifact(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04210',
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04231'
  )$$,
  'artifact deletion completes after correction'
);
reset role;
select is((select count(*)::integer from public.artifacts where id = '0198c5d2-bfed-75e0-b7d1-8a89b7c04230'), 0, 'artifact row is hard deleted');
select is((select count(*)::integer from public.message_artifacts where artifact_id = '0198c5d2-bfed-75e0-b7d1-8a89b7c04230'), 0, 'message-artifact join cascades');
select is((select cardinality(artifact_ids) from public.messages where id = '0198c5d2-bfed-75e0-b7d1-8a89b7c04235'), 0, 'message attachment cache no longer retains the deleted id');
select is((select count(*)::integer from public.audit_events where action in ('artifact.correct', 'artifact.delete')), 2, 'correction and deletion are audited without raw content');

set local role service_role;
select lives_ok(
  $$select public.unlink_transport_phone('0198c5d2-bfed-75e0-b7d1-8a89b7c04210')$$,
  'a user can unlink the rail through the authenticated service boundary'
);
reset role;
select is((select count(*)::integer from private.phone_mappings where user_id = '0198c5d2-bfed-75e0-b7d1-8a89b7c04210'), 0, 'unlink removes the private mapping');
select is((select count(*)::integer from public.audit_events where action = 'transport.phone_unlink'), 1, 'unlink is audited');

select * from finish();
rollback;
