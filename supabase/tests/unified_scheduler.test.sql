begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(8);

select ok(has_function_privilege('service_role','public.claim_due_callbacks(integer)','execute'), 'scheduler worker can claim due callbacks');
select ok(not has_function_privilege('authenticated','public.claim_due_callbacks(integer)','execute'), 'clients cannot claim the global callback queue');

insert into auth.users (id,email,role,aud,created_at,updated_at)
values ('0198c5d2-bfed-75e0-b7d1-8a89b7c04910','scheduler@example.test','authenticated','authenticated',now(),now());
select lives_ok(
  $$insert into public.callbacks (id,user_id,callback_type,resource_id,lock_screen_copy,scheduled_at)
    values
      ('0198c5d2-bfed-75e0-b7d1-8a89b7c04911','0198c5d2-bfed-75e0-b7d1-8a89b7c04910','absence','0198c5d2-bfed-75e0-b7d1-8a89b7c04921','generic',now()-interval '1 minute'),
      ('0198c5d2-bfed-75e0-b7d1-8a89b7c04912','0198c5d2-bfed-75e0-b7d1-8a89b7c04910','reminder','0198c5d2-bfed-75e0-b7d1-8a89b7c04922','generic',now()-interval '1 minute'),
      ('0198c5d2-bfed-75e0-b7d1-8a89b7c04913','0198c5d2-bfed-75e0-b7d1-8a89b7c04910','second_opinion','0198c5d2-bfed-75e0-b7d1-8a89b7c04923','generic',now()+interval '1 day')$$,
  'all unified proactive trigger classes satisfy the callback contract'
);
set local role service_role;
select is((select callback_id::text from public.claim_due_callbacks(1)), '0198c5d2-bfed-75e0-b7d1-8a89b7c04912', 'requested reminders claim before organic work');
reset role;
select ok((select delivery_claimed_at is not null from public.callbacks where id='0198c5d2-bfed-75e0-b7d1-8a89b7c04912'), 'claim is leased durably');
set local role service_role;
select is((select callback_id::text from public.claim_due_callbacks(1)), '0198c5d2-bfed-75e0-b7d1-8a89b7c04911', 'absence work claims only after higher priorities');
reset role;
select throws_ok(
  $$update public.callbacks set suppression_reason='private_raw_reason' where id='0198c5d2-bfed-75e0-b7d1-8a89b7c04911'$$,
  '23514', null, 'suppression reasons are content-free and allowlisted'
);
set local role authenticated;
select set_config('request.jwt.claim.sub','0198c5d2-bfed-75e0-b7d1-8a89b7c04910',true);
select is((select count(*)::integer from public.callbacks), 3, 'the user can inspect every callback in their interruption economy');
reset role;

select * from finish();
rollback;
