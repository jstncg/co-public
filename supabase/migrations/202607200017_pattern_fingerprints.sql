alter table public.hypotheses add column fingerprint text;
create unique index hypotheses_user_fingerprint_unique on public.hypotheses (user_id, fingerprint) where fingerprint is not null;
