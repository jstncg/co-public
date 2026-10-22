begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(5);

select ok(
  not has_function_privilege('authenticated', 'public.export_private_user_data(uuid)', 'execute'),
  'authenticated clients cannot call the private export assembler directly'
);
select ok(
  has_function_privilege('service_role', 'public.export_private_user_data(uuid)', 'execute'),
  'the authenticated server boundary can assemble a private export'
);

insert into auth.users (id, email, role, aud, created_at, updated_at)
values ('0198c5d2-bfed-75e0-b7d1-8a89b7c04610', 'private-export@example.test', 'authenticated', 'authenticated', now(), now());
insert into private.apple_credentials (user_id, refresh_token)
values ('0198c5d2-bfed-75e0-b7d1-8a89b7c04610', 'must-never-leave-private-schema');
insert into private.phone_mappings (phone_hash, phone_last4, user_id, verified_at)
values (repeat('9', 64), '0123', '0198c5d2-bfed-75e0-b7d1-8a89b7c04610', now());

set local role service_role;
select is(
  public.export_private_user_data('0198c5d2-bfed-75e0-b7d1-8a89b7c04610') #>> '{apple_authorization,stored}',
  'true',
  'export records that Apple authorization is held'
);
select is(
  public.export_private_user_data('0198c5d2-bfed-75e0-b7d1-8a89b7c04610') #>> '{transport_phone_link,phone_last4}',
  '0123',
  'export includes only the useful phone suffix'
);
select ok(
  public.export_private_user_data('0198c5d2-bfed-75e0-b7d1-8a89b7c04610')::text not like '%must-never-leave-private-schema%'
  and public.export_private_user_data('0198c5d2-bfed-75e0-b7d1-8a89b7c04610')::text not like '%' || repeat('9', 64) || '%',
  'export excludes Apple secrets and keyed phone hashes'
);
reset role;

select * from finish();
rollback;
