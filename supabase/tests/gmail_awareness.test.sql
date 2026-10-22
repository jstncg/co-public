begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(34);

select has_table('public', 'email_context_items', 'Gmail evidence has a user-owned table');
select has_table('private', 'gmail_watch_state', 'Gmail provider watch state stays private');
select has_table('private', 'gmail_sync_queue', 'Gmail wakeups have a durable private queue');
select ok(
  not has_table_privilege('authenticated', 'private.gmail_watch_state', 'select'),
  'authenticated clients cannot inspect provider watch identities'
);

insert into auth.users (id,email,role,aud,created_at,updated_at)
values
  ('0199a000-0000-7000-8000-000000000001','gmail-one@example.test','authenticated','authenticated',now(),now()),
  ('0199a000-0000-7000-8000-000000000002','gmail-two@example.test','authenticated','authenticated',now(),now());

select isnt(
  public.register_gmail_context_source(
    '0199a000-0000-7000-8000-000000000001','GMAIL-ONE@example.test','100',
    now()+interval '7 days','snippet'
  ),
  null,
  'the service-only function can register a scoped Gmail watch'
);
select is(
  (select sync_cursor from public.context_sources
   where user_id='0199a000-0000-7000-8000-000000000001' and source_kind='email'),
  '100',
  'registration commits the initial History cursor'
);
select is(
  (select last_watch_history_id::text from private.gmail_watch_state
   where user_id='0199a000-0000-7000-8000-000000000001'),
  '100',
  'registration records provider watch metadata separately'
);
select lives_ok(
  $$select public.register_gmail_context_source(
    '0199a000-0000-7000-8000-000000000001','gmail-one@example.test','101',
    now()+interval '7 days','snippet'
  )$$,
  'watch renewal is idempotent'
);
select is(
  (select sync_cursor from public.context_sources
   where user_id='0199a000-0000-7000-8000-000000000001' and source_kind='email'),
  '100',
  'renewal cannot skip the committed ingestion cursor'
);
select is(
  (select last_watch_history_id::text from private.gmail_watch_state
   where user_id='0199a000-0000-7000-8000-000000000001'),
  '101',
  'renewal advances only provider watch metadata'
);
select is(
  (public.enqueue_gmail_sync(
    'gmail-one@example.test','105','push-1','2026-09-01T19:00:00Z'
  )->>'accepted')::boolean,
  true,
  'an authenticated push identity can queue a known source'
);
select is(
  (select target_history_id::text from private.gmail_sync_queue),
  '105',
  'the durable queue stores the greatest target cursor'
);

create temporary table gmail_claim (payload jsonb);
insert into gmail_claim
select public.claim_gmail_sync(
  '0199a000-0000-7000-8000-000000000001',
  (select id from public.context_sources
   where user_id='0199a000-0000-7000-8000-000000000001' and source_kind='email')
);
select is((select payload->>'start_history_id' from gmail_claim),'100','claim starts at the committed cursor');
select is((select payload->>'target_history_id' from gmail_claim),'105','claim carries the coalesced target');

create temporary table gmail_apply (payload jsonb);
insert into gmail_apply
select public.apply_gmail_sync(
  '0199a000-0000-7000-8000-000000000001',
  (select id from public.context_sources
   where user_id='0199a000-0000-7000-8000-000000000001' and source_kind='email'),
  (select (payload->>'lease_token')::uuid from gmail_claim),
  '100','105',
  '[{"external_id":"message-1","thread_id":"thread-1","history_id":"105","internal_date":"2026-09-01T19:00:00Z","change_kind":"received","from":"sender@example.test","to":"gmail-one@example.test","cc":null,"subject":"A bounded subject","sent_date":"Tue, 1 Sep 2026 12:00:00 -0700","snippet":"A redacted snippet","label_ids":["INBOX"],"analysis_allowed":true,"sensitivity":"medium"}]'::jsonb,
  '{}'::text[],false
);
select is((select (payload->>'accepted')::integer from gmail_apply),1,'one bounded item is accepted');
select is(
  (select sync_cursor from public.context_sources
   where user_id='0199a000-0000-7000-8000-000000000001' and source_kind='email'),
  '105',
  'apply atomically advances the source cursor'
);
select is((select count(*)::integer from public.email_context_items),1,'one current evidence row is stored');
select is(
  (select count(*)::integer from public.context_events where event_kind='email_received'),
  1,
  'one append-only received event is created'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','0199a000-0000-7000-8000-000000000002',true);
select is(
  (select count(*)::integer from public.email_context_items),
  0,
  'another authenticated user cannot read Gmail evidence'
);
reset role;

select lives_ok(
  $$select public.enqueue_gmail_sync(
    'gmail-one@example.test','107','push-2','2026-09-01T19:01:00Z'
  )$$,
  'a later push requeues the source'
);
truncate gmail_claim;
insert into gmail_claim
select public.claim_gmail_sync(
  '0199a000-0000-7000-8000-000000000001',
  (select id from public.context_sources
   where user_id='0199a000-0000-7000-8000-000000000001' and source_kind='email')
);
select is((select payload->>'start_history_id' from gmail_claim),'105','a later claim resumes from committed state');
truncate gmail_apply;
insert into gmail_apply
select public.apply_gmail_sync(
  '0199a000-0000-7000-8000-000000000001',
  (select id from public.context_sources
   where user_id='0199a000-0000-7000-8000-000000000001' and source_kind='email'),
  (select (payload->>'lease_token')::uuid from gmail_claim),
  '105','106','[]'::jsonb,'{}'::text[],false
);
select is((select state from private.gmail_sync_queue),'queued','partial progress preserves a newer wakeup');
select is((select attempts::integer from private.gmail_sync_queue),0,'successful partial progress resets failures');
truncate gmail_claim;
insert into gmail_claim
select public.claim_gmail_sync(
  '0199a000-0000-7000-8000-000000000001',
  (select id from public.context_sources
   where user_id='0199a000-0000-7000-8000-000000000001' and source_kind='email')
);
select is(
  public.pause_gmail_context_source(
    '0199a000-0000-7000-8000-000000000001',
    (select id from public.context_sources
     where user_id='0199a000-0000-7000-8000-000000000001' and source_kind='email'),
    (select (payload->>'lease_token')::uuid from gmail_claim)
  ),
  true,
  'a credential failure pauses the exact leased source'
);
select is(
  (select status from public.context_sources
   where user_id='0199a000-0000-7000-8000-000000000001' and source_kind='email'),
  'paused',
  'reauthorization prevents additional provider reads'
);
select is((select state from private.gmail_sync_queue),'idle','reauthorization clears the active lease');
select is(
  (select count(*)::integer from public.audit_events
   where action='context_source.reauthorization_required'),
  1,
  'reauthorization leaves a content-free operational receipt'
);
select lives_ok(
  $$select public.register_gmail_context_source(
    '0199a000-0000-7000-8000-000000000001','gmail-one@example.test','108',
    now()+interval '7 days','snippet'
  )$$,
  'reauthorization can register a fresh provider watch'
);
select is(
  (select status from public.context_sources
   where user_id='0199a000-0000-7000-8000-000000000001' and source_kind='email'),
  'active',
  'successful reauthorization activates the source'
);
select is(
  (select state from private.gmail_sync_queue),
  'queued',
  'reauthorization resumes a cursor that was pending before the pause'
);
select is(
  public.delete_gmail_context_source(
    '0199a000-0000-7000-8000-000000000001',
    (select id from public.context_sources
     where user_id='0199a000-0000-7000-8000-000000000001' and source_kind='email')
  ),
  true,
  'the user-scoped delete removes the source'
);
select is((select count(*)::integer from public.email_context_items),0,'source deletion cascades evidence');
select is(
  (select count(*)::integer from public.context_events where source_kind='email'),
  0,
  'source deletion cascades derived events'
);
select is(
  (select count(*)::integer from public.audit_events
   where user_id='0199a000-0000-7000-8000-000000000001'
     and action='context_source.deleted' and resource_type='context_source'),
  1,
  'source deletion leaves a content-free audit receipt'
);

reset role;
select * from finish();
rollback;
