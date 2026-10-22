create table public.artifact_responses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  artifact_id uuid not null references public.artifacts(id) on delete cascade,
  mode text not null check (mode in ('understand','react','remember','move','quiet')),
  response text not null,
  why_question jsonb,
  suggested_actions jsonb not null default '[]'::jsonb,
  confidence numeric not null check (confidence between 0 and 1),
  model_run_id uuid references private.model_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (artifact_id)
);

alter table public.artifact_responses enable row level security;
create policy artifact_responses_own on public.artifact_responses for select to authenticated
using (user_id = (select auth.uid()));

revoke insert, update, delete on public.artifact_responses from anon, authenticated;

