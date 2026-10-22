begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(5);

insert into auth.users (id,email,role,aud,created_at,updated_at)
values ('a399b000-bbbb-4000-8000-ccccccccccc3','linq-transport@example.test',
        'authenticated','authenticated',now(),now());

set local role service_role;
select public.link_verified_transport_phone(
  'a399b000-bbbb-4000-8000-ccccccccccc3',repeat('c',64),'4567',now()
);
select lives_ok(
  $$select * from public.ingest_transport_message(
    repeat('c',64),'linq','8f392755-6865-4b18-880a-227f9d8b458f',
    'linq:89e3566e-1d13-49e5-a8ee-48490d5bfeb7','89e3566e-1d13-49e5-a8ee-48490d5bfeb7',null,
    'outbound','one relationship, another carrier',array[]::text[],now(),null,
    '{"source_version":"linq.v3"}'::jsonb,'[]'::jsonb
  )$$,
  'Linq enters through the canonical transport RPC'
);
reset role;

select is(
  (select transport from public.messages where user_id='a399b000-bbbb-4000-8000-ccccccccccc3'),
  'linq','provider identity is retained on the message'
);
select is(
  (select external_thread_id from public.conversations where user_id='a399b000-bbbb-4000-8000-ccccccccccc3'),
  '8f392755-6865-4b18-880a-227f9d8b458f','the Linq chat remains the external thread'
);

set local role service_role;
select isnt(
  public.apply_transport_status(
    repeat('c',64),'linq','89e3566e-1d13-49e5-a8ee-48490d5bfeb7','ERROR',now(),'4006'
  ),
  null::uuid,'a Linq failure joins the message it describes'
);
reset role;
select is(
  (select transport_metadata->>'error_code' from public.messages
   where user_id='a399b000-bbbb-4000-8000-ccccccccccc3'),
  '4006','the bounded Linq failure code is retained'
);

select * from finish();
rollback;
