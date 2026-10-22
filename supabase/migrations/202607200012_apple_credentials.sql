create table private.apple_credentials (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  refresh_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

revoke all on table private.apple_credentials from public, anon, authenticated;
