-- Export private-schema personal records without exposing the private schema through PostgREST or
-- leaking Apple refresh credentials / keyed phone hashes.

create or replace function public.export_private_user_data(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'model_runs', coalesce((
      select jsonb_agg(to_jsonb(run) order by run.created_at)
      from private.model_runs run where run.user_id = p_user_id
    ), '[]'::jsonb),
    'external_queries', coalesce((
      select jsonb_agg(to_jsonb(query) order by query.created_at)
      from private.external_queries query where query.user_id = p_user_id
    ), '[]'::jsonb),
    'review_decisions', coalesce((
      select jsonb_agg(to_jsonb(decision) order by decision.created_at)
      from private.review_decisions decision where decision.user_id = p_user_id
    ), '[]'::jsonb),
    'apple_authorization', coalesce((
      select jsonb_build_object('stored', true, 'created_at', credential.created_at, 'updated_at', credential.updated_at)
      from private.apple_credentials credential where credential.user_id = p_user_id
    ), jsonb_build_object('stored', false)),
    'transport_phone_link', coalesce((
      select jsonb_build_object('phone_last4', mapping.phone_last4, 'verified_at', mapping.verified_at)
      from private.phone_mappings mapping where mapping.user_id = p_user_id
      order by mapping.verified_at desc limit 1
    ), 'null'::jsonb)
  );
$$;

revoke all on function public.export_private_user_data(uuid) from public, anon, authenticated;
grant execute on function public.export_private_user_data(uuid) to service_role;

