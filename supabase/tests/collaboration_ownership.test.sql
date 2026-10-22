begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(17);

select ok(
  not has_function_privilege('authenticated','public.enqueue_collaboration_run(uuid,jsonb)','execute'),
  'member clients cannot enqueue through the service-role boundary'
);
select ok(
  not has_function_privilege('authenticated','public.claim_collaboration_run(uuid,uuid,jsonb,integer)','execute'),
  'member clients cannot claim worker ownership'
);

insert into auth.users (id,email,role,aud,created_at,updated_at)
values ('a199b000-bbbb-4000-8000-ccccccccccc1','collaboration-owner@example.test',
        'authenticated','authenticated',now(),now());

create temporary table collaboration_request (payload jsonb);
insert into collaboration_request values (
  '{
    "tenant_id":"a199b000-bbbb-4000-8000-ccccccccccc1",
    "idempotency_key":"collaboration:test:ownership",
    "objective":"Produce one cited reading.",
    "evidence_packet":{
      "artifact_ids":["b199b000-cccc-4000-8000-ddddddddddd2"],
      "signal_ids":[],"segment_ids":[],"context_event_ids":[]
    },
    "agents":[{
      "id":"reader","name":"Reader","objective":"Read the evidence.","instructions":"",
      "model":{"provider":"openai","model":"configured-model","max_output_tokens":400,
               "reasoning_effort":"low","timeout_ms":30000},
      "depends_on":[]
    }],
    "synthesis_agent_id":"reader",
    "token_budget":{"max_input_tokens":2000,"max_output_tokens":500,"max_total_tokens":2500},
    "max_concurrency":1,"max_retries_per_task":0
  }'::jsonb
);

create temporary table first_enqueue (payload jsonb);
insert into first_enqueue
select public.enqueue_collaboration_run(
  'a199b000-bbbb-4000-8000-ccccccccccc1',
  (select payload from collaboration_request)
);
select is((select (payload->>'deduped')::boolean from first_enqueue),false,
          'the first exact request creates a run');

create temporary table second_enqueue (payload jsonb);
insert into second_enqueue
select public.enqueue_collaboration_run(
  'a199b000-bbbb-4000-8000-ccccccccccc1',
  (select payload from collaboration_request)
);
select is((select (payload->>'deduped')::boolean from second_enqueue),true,
          'an exact retry resolves to the existing run');
select is((select payload->>'run_id' from second_enqueue),(select payload->>'run_id' from first_enqueue),
          'an exact retry preserves run identity');
select throws_ok(
  $$select public.enqueue_collaboration_run(
      'a199b000-bbbb-4000-8000-ccccccccccc1',
      (select payload || '{"objective":"Different work."}'::jsonb from collaboration_request)
    )$$,
  '22000','collaboration idempotency collision',
  'an idempotency key cannot be rebound to different work'
);

create temporary table first_claim (payload jsonb);
insert into first_claim
select public.claim_collaboration_run(
  'a199b000-bbbb-4000-8000-ccccccccccc1',
  (select (payload->>'run_id')::uuid from first_enqueue),
  (select payload from collaboration_request),120
);
select is((select (payload->>'claimed')::boolean from first_claim),true,
          'the first worker claims the queued run');
select isnt((select payload->>'lease_token' from first_claim),null::text,
            'a claim receives an opaque lease token');

create temporary table blocked_claim (payload jsonb);
insert into blocked_claim
select public.claim_collaboration_run(
  'a199b000-bbbb-4000-8000-ccccccccccc1',
  (select (payload->>'run_id')::uuid from first_enqueue),
  (select payload from collaboration_request),120
);
select is((select (payload->>'claimed')::boolean from blocked_claim),false,
          'a second worker cannot claim a live lease');
select is(
  public.renew_collaboration_run_lease(
    'a199b000-bbbb-4000-8000-ccccccccccc1',
    (select (payload->>'run_id')::uuid from first_enqueue),
    'c199b000-dddd-4000-8000-eeeeeeeeeee9',120
  ),false,'a different token cannot renew the lease'
);

update public.collaboration_runs set lease_expires_at=now()-interval '1 second'
where id=(select (payload->>'run_id')::uuid from first_enqueue);
create temporary table recovery_claim (payload jsonb);
insert into recovery_claim
select public.claim_collaboration_run(
  'a199b000-bbbb-4000-8000-ccccccccccc1',
  (select (payload->>'run_id')::uuid from first_enqueue),
  (select payload from collaboration_request),120
);
select is((select (payload->>'claimed')::boolean from recovery_claim),true,
          'an expired lease can be recovered');
select isnt((select payload->>'lease_token' from recovery_claim),
            (select payload->>'lease_token' from first_claim),
            'recovery rotates lease ownership');
select is(
  public.finish_collaboration_run(
    'a199b000-bbbb-4000-8000-ccccccccccc1',
    (select (payload->>'run_id')::uuid from first_enqueue),
    (select (payload->>'lease_token')::uuid from first_claim),
    'succeeded',1,1,0
  ),false,'a stale worker cannot finish the recovered run'
);
select is(
  public.finish_collaboration_run(
    'a199b000-bbbb-4000-8000-ccccccccccc1',
    (select (payload->>'run_id')::uuid from first_enqueue),
    (select (payload->>'lease_token')::uuid from recovery_claim),
    'succeeded',10,5,2
  ),true,'the current owner can finish the run'
);
select is(
  (select state from public.collaboration_runs
   where id=(select (payload->>'run_id')::uuid from first_enqueue)),
  'succeeded','the terminal state is durable'
);
select is(
  (select lease_token from public.collaboration_runs
   where id=(select (payload->>'run_id')::uuid from first_enqueue)),
  null::uuid,'terminal runs retain no active lease'
);
select is(
  (public.claim_collaboration_run(
    'a199b000-bbbb-4000-8000-ccccccccccc1',
    (select (payload->>'run_id')::uuid from first_enqueue),
    (select payload from collaboration_request),120
  )->>'claimed')::boolean,
  false,'a terminal run cannot be reclaimed'
);

select * from finish();
rollback;
