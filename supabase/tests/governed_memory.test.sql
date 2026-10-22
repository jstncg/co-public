begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(22);

select has_table('public', 'legacy_memory_claims', 'legacy claims have an inspectable user-owned home');
select has_table('public', 'memory_returns', 'receipt-backed returns exist');
select has_table('private', 'shadow_comparisons', 'shadow outputs stay private');
select ok(not has_table_privilege('authenticated', 'private.shadow_comparisons', 'select'), 'shadow outputs are not client readable');
select ok(not has_function_privilege('authenticated', 'public.create_memory_return(uuid,uuid,uuid,uuid,text,text)', 'execute'), 'clients cannot manufacture returns');

insert into auth.users (id, email, role, aud, created_at, updated_at)
values
  ('0198c5d2-bfed-75e0-b7d1-8a89b7c04710', 'memory-one@example.test', 'authenticated', 'authenticated', now(), now()),
  ('0198c5d2-bfed-75e0-b7d1-8a89b7c04720', 'memory-two@example.test', 'authenticated', 'authenticated', now(), now());
insert into public.artifacts (
  id,user_id,client_artifact_id,idempotency_key,source_type,captured_at,raw_text,source_coverage,analysis_allowed,processing_status
) values
  ('0198c5d2-bfed-75e0-b7d1-8a89b7c04731','0198c5d2-bfed-75e0-b7d1-8a89b7c04710','0198c5d2-bfed-75e0-b7d1-8a89b7c04741','memory:old','text','2026-07-01T19:00:00Z','old receipt','text',true,'ready'),
  ('0198c5d2-bfed-75e0-b7d1-8a89b7c04732','0198c5d2-bfed-75e0-b7d1-8a89b7c04710','0198c5d2-bfed-75e0-b7d1-8a89b7c04742','memory:new','text','2026-07-20T19:00:00Z','new trigger','text',true,'ready'),
  ('0198c5d2-bfed-75e0-b7d1-8a89b7c04733','0198c5d2-bfed-75e0-b7d1-8a89b7c04720','0198c5d2-bfed-75e0-b7d1-8a89b7c04743','memory:other','text','2026-07-20T19:00:00Z','other user','text',true,'ready');

set local role service_role;
select isnt(
  public.import_legacy_memory_claim(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04710','predecessor','claim-1','you always choose quiet rooms',
    array['0198c5d2-bfed-75e0-b7d1-8a89b7c04731'::uuid],'["it may be the people"]'::jsonb
  ), null, 'receipt-linked predecessor claim imports'
);
reset role;
select is((select status from public.legacy_memory_claims where source_claim_id='claim-1'), 'unconfirmed', 'legacy claims never arrive as truth');
select is((select count(*)::integer from public.legacy_memory_claims where source_claim_id='claim-1'), 1, 'the first legacy claim has one row');
set local role service_role;
select lives_ok(
  $$select public.import_legacy_memory_claim(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04710','predecessor','claim-1','you may choose quiet rooms',
    array['0198c5d2-bfed-75e0-b7d1-8a89b7c04731'::uuid],'[]'::jsonb
  )$$,
  'legacy replay updates the same unconfirmed claim'
);
select throws_ok(
  $$select public.import_legacy_memory_claim(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04710','predecessor','claim-cross','bad cross-user claim',
    array['0198c5d2-bfed-75e0-b7d1-8a89b7c04733'::uuid],'[]'::jsonb
  )$$,
  'P0001','legacy claim evidence unavailable','legacy import rejects cross-user evidence'
);
select isnt(
  public.create_memory_return(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04710','0198c5d2-bfed-75e0-b7d1-8a89b7c04731',
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04732',null,
    'the newer save makes the older one useful tonight','you saved this earlier — it matters now because the new receipt changes the decision.'
  ), null, 'a return joins one old receipt to one newer trigger'
);
select throws_ok(
  $$select public.create_memory_return(
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04710','0198c5d2-bfed-75e0-b7d1-8a89b7c04732',
    '0198c5d2-bfed-75e0-b7d1-8a89b7c04731',null,'backwards','backwards'
  )$$,
  'P0001','return trigger must be newer than its old receipt','returns cannot use an older trigger'
);
reset role;
select is((select status from public.memory_returns limit 1), 'review', 'returns require review before delivery');

insert into public.callbacks (user_id,callback_type,resource_id,evidence_artifact_ids,lock_screen_copy,scheduled_at)
select user_id,'return',id,array[old_artifact_id],'something you saved became useful',now()
from public.memory_returns limit 1;
select is((select callback_type from public.callbacks where callback_type='return' limit 1), 'return', 'the unified callback ledger accepts returns');

insert into public.consents (id,user_id,consent_type,version,expires_at)
values (
  '0198c5d2-bfed-75e0-b7d1-8a89b7c04750','0198c5d2-bfed-75e0-b7d1-8a89b7c04710',
  'founder_review','v1',now() + interval '1 day'
);
set local role service_role;
select isnt(
  public.founder_review_memory_return((select id from public.memory_returns limit 1),'founder-one','approve',null,array['fresh-chat-pass']),
  null,
  'consented founder review can approve a receipt-backed return'
);
reset role;
select is((select status from public.memory_returns limit 1), 'approved', 'approved return becomes user-visible');
select is((select count(*)::integer from private.review_decisions where target_type='return'), 1, 'return review decision is retained');
select is((select count(*)::integer from public.audit_events where resource_type='return' and action='founder_review.approve'), 1, 'return approval is audited');

set local role authenticated;
select set_config('request.jwt.claim.sub', '0198c5d2-bfed-75e0-b7d1-8a89b7c04720', true);
select is((select count(*)::integer from public.memory_returns), 0, 'another user cannot see a return');
reset role;
set local role service_role;
select is(public.dismiss_memory_return('0198c5d2-bfed-75e0-b7d1-8a89b7c04710',(select id from public.memory_returns limit 1)), true, 'user dismissal passes through the scoped server transaction');
reset role;
select is((select status from public.memory_returns limit 1), 'dismissed', 'dismissal is persisted');
delete from public.artifacts where id='0198c5d2-bfed-75e0-b7d1-8a89b7c04731';
select is((select count(*)::integer from public.memory_returns), 0, 'deleting the old receipt removes its return');

select * from finish();
rollback;
