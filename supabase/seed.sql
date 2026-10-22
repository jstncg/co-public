-- Deterministic product demo data is inserted by scripts/seed-demo.ts after local users
-- are created through the Auth API. Keeping auth creation out of SQL avoids depending on
-- Supabase Auth's internal table shape. This file intentionally remains idempotent.
select 1;

