# seed — §37 demo journeys

Deterministic demo data for screenshots, UI development, and automated tests. Loaded by
`supabase db reset` (configure `[db.seed] sql_paths = ["./seed/seed.sql"]` in `supabase/config.toml`,
or run `psql "$DATABASE_URL" -f supabase/seed/seed.sql` after migrations).

## fixed uuid scheme

`00000000-0000-4000-8000-000000000NXX` — `N` = entity class, `XX` = index:

| N | class | N | class |
|---|-------|---|-------|
| 1 | users (101–105), devices (111–115) | 5 | threads |
| 9 | auth ids (901–905) | 6 | hypotheses |
| 2 | artifacts | 7 | evidence_links |
| 3 | annotations | 8 | radar: watch_entities (80x), subscriptions (81x), world_events (82x), candidates (83x) |
| 4 | observations | | |

## journeys

- **maya** (`…101`) creative room: 5 artifacts (pottery reel, communal dinner screenshot, book-club
  post, third-place youtube timestamp, voice note) with realistic why annotations, thread
  "small rooms, shared making", hypothesis `…601` in `review` with 5 evidence_links + §13.3 alternatives.
- **alex** (`…102`) knowledge radar: article/podcast/note saves, approved watch on
  "Systems Thinkers Radio" (+podcast subscription), world_event `new_episode`
  "The Rise of Systems Thinkers", radar_candidate `sent` with cited why_user evidence.
- **priya** (`…103`) launch watch: repeated andera posts + "stay close to their work" note +
  explicit watch approval, world_event `launch` "Andera launched", radar_candidate `sent`.
- **sam** (`…104`) false pattern: 3 running posts + why "i like the photography, not running";
  hypothesis `…602` ("sam may want to take up running") is `rejected`, with 3 supporting and
  1 `contradict` evidence_link — the contradiction is what prevented the send.
- **jordan** (`…105`) privacy: one voice artifact with `retention_mode='no_analysis'`,
  `sensitivity='high'`, `processing_status='stored_only'` — **no** observations, segments,
  annotations, or pattern use. (`raw_object_path` points at a storage object the seed does not
  create; upload a dummy m4a if a demo needs playback.)

Auth note: `users.auth_id` values are fixed uuids with no matching `auth.users` rows — fine for
workers/tests (service role bypasses RLS). To log in as a demo user, create the auth user first
and update `auth_id`.
