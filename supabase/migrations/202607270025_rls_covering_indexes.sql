-- Every RLS policy in this schema filters `user_id = auth.uid()`, so user_id is on the hot path of
-- every authenticated query — but Postgres does not index foreign keys automatically and migrations
-- 0001-0024 only indexed a handful. This adds a covering index for any FK column lacking one,
-- idempotently, so re-running is a no-op.
do $$
declare
  fk record;
  idx_name text;
begin
  for fk in
    select
      con.conrelid::regclass::text as tbl,
      nsp.nspname as schema_name,
      cls.relname as table_name,
      string_agg(quote_ident(att.attname), ', ' order by k.ord) as cols,
      string_agg(att.attname, '_' order by k.ord) as col_slug
    from pg_constraint con
    join pg_class cls on cls.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = cls.relnamespace
    join lateral unnest(con.conkey) with ordinality as k(attnum, ord) on true
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
    where con.contype = 'f'
      and nsp.nspname in ('public', 'private')
    group by con.oid, con.conrelid, nsp.nspname, cls.relname
    having not exists (
      select 1
      from pg_index i
      where i.indrelid = con.conrelid
        and (i.indkey::int2[])[0:array_length(con.conkey, 1) - 1] = con.conkey
    )
  loop
    idx_name := left(format('%s_%s_fk_idx', fk.table_name, fk.col_slug), 63);
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relname = idx_name and n.nspname = fk.schema_name
    ) then
      execute format('create index %I on %I.%I (%s)', idx_name, fk.schema_name, fk.table_name, fk.cols);
    end if;
  end loop;
end $$;
