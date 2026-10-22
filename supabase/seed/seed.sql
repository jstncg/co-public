-- co · deterministic demo data for the five §37 journeys (maya / alex / priya / sam / jordan).
-- fixed uuids: 00000000-0000-4000-8000-000000000NXX where N = entity class, XX = index.
--   1xx users · 9xx auth ids · 2xx artifacts · 3xx annotations · 4xx observations
--   5xx threads · 6xx hypotheses · 7xx evidence_links · 8xx radar (watch/sub/event/candidate)
-- loaded by `supabase db reset` (see supabase/seed/README.md). applied after migrations; inserts only.

-- ---------- users & devices ----------
insert into users (id, auth_id, timezone, city, register, onboarding_state) values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000901', 'America/New_York', 'brooklyn', 'warm',    'complete'), -- maya
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000902', 'America/New_York', null,       'direct',  'complete'), -- alex
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000903', 'America/New_York', null,       'neutral', 'complete'), -- priya
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000904', 'America/New_York', null,       'direct',  'complete'), -- sam
  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000905', 'America/New_York', null,       'warm',    'complete'); -- jordan

insert into devices (id, user_id, app_version) values
  ('00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000101', '0.1.0'),
  ('00000000-0000-4000-8000-000000000112', '00000000-0000-4000-8000-000000000102', '0.1.0'),
  ('00000000-0000-4000-8000-000000000113', '00000000-0000-4000-8000-000000000103', '0.1.0'),
  ('00000000-0000-4000-8000-000000000114', '00000000-0000-4000-8000-000000000104', '0.1.0'),
  ('00000000-0000-4000-8000-000000000115', '00000000-0000-4000-8000-000000000105', '0.1.0');

-- founder review consent (maya/alex/priya only — jordan never consented, sam not asked yet)
insert into consents (user_id, consent_type, version) values
  ('00000000-0000-4000-8000-000000000101', 'founder_review', 'v1'),
  ('00000000-0000-4000-8000-000000000102', 'founder_review', 'v1'),
  ('00000000-0000-4000-8000-000000000103', 'founder_review', 'v1');

-- ---------- maya: creative room ----------
insert into artifacts (id, user_id, source_type, title, canonical_url, captured_at, raw_text, transcript, timestamp_seconds, coverage, processing_status) values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', 'short_video', 'pottery reel', 'https://instagram.example/reel/pottery-studio', '2026-05-26 19:12:00+00', 'small studio, six people at wheels, someone laughing off a collapsed bowl', null, null, 'text', 'processed'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000101', 'screenshot', 'communal dinner', null, '2026-05-29 01:40:00+00', 'long table dinner, mismatched chairs, handwritten menu, "bring a dish" note', null, null, 'image', 'processed'),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000101', 'social_post', 'book-club post', 'https://social.example/p/bookclub-openseats', '2026-06-01 22:05:00+00', 'neighborhood book club has two open seats. we argue kindly on thursdays.', null, null, 'text', 'processed'),
  ('00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000101', 'youtube', 'the third place, timestamped', 'https://youtube.example/watch?v=thirdplace', '2026-06-03 03:22:00+00', null, 'the cafe was never about coffee. it was the one room where nobody performed.', 1042, 'text', 'processed'),
  ('00000000-0000-4000-8000-000000000205', '00000000-0000-4000-8000-000000000101', 'voice', 'voice note: interesting friends', null, '2026-06-05 02:10:00+00', null, 'i keep thinking my friends who seem happiest all have some room they go back to every week. i want that. not a hobby exactly. the room.', null, 'full_media', 'processed');

insert into annotations (id, artifact_id, user_id, annotation_type, value, free_text) values
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', 'why', 'the people around them', 'the people making things together, not the pots'),
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000101', 'why', 'how the life feels', null),
  ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000101', 'why', 'i want this', 'i want a standing thing with the same people'),
  ('00000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000101', 'why', 'i want to understand it', null);

insert into observations (id, user_id, artifact_id, observation_type, statement, confidence) values
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000201', 'user_statement', 'kept the pottery reel for the people making things together, not the pots', 0.95),
  ('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000202', 'user_statement', 'drawn to how a communal dinner life feels', 0.9),
  ('00000000-0000-4000-8000-000000000403', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000203', 'user_statement', 'wants a standing weekly thing with the same people', 0.95),
  ('00000000-0000-4000-8000-000000000404', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000204', 'observation', 'saved a timestamped segment about third places where nobody performs', 0.7),
  ('00000000-0000-4000-8000-000000000405', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000205', 'user_statement', 'wants "the room", explicitly not a hobby', 0.95);

insert into threads (id, user_id, title, current_question, summary, status, confidence) values
  ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000101', 'small rooms, shared making', 'is the draw the making or the recurring room?', 'five saves in ten days about small groups meeting regularly around shared creation', 'active', 0.6);

insert into thread_memberships (thread_id, artifact_id, relationship, confidence, user_confirmed) values
  ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000201', 'supports', 0.8, true),
  ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000202', 'supports', 0.7, false),
  ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000203', 'supports', 0.85, true),
  ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000204', 'context',  0.6, false),
  ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000205', 'supports', 0.9, true);

-- §13.3 shape: statement + live alternatives, receipts via evidence_links. status review = awaiting founder approval.
insert into hypotheses (id, user_id, thread_id, statement, alternatives_json, confidence, status) values
  ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000501',
   'you may not be looking for a hobby. across pottery, dinners, and book-club saves, the repeated part is a small group meeting regularly around shared creation.',
   '[{"h":"wants pottery itself","p":0.18},{"h":"wants recurring creative participation","p":0.47},{"h":"wants a new social circle","p":0.25},{"h":"admires the aesthetic","p":0.10}]',
   0.47, 'review');

insert into evidence_links (id, hypothesis_id, artifact_id, observation_id, direction, weight) values
  ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000401', 'support', 1.0),
  ('00000000-0000-4000-8000-000000000702', '00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000402', 'support', 0.8),
  ('00000000-0000-4000-8000-000000000703', '00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000403', 'support', 1.0),
  ('00000000-0000-4000-8000-000000000704', '00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000404', 'context', 0.5),
  ('00000000-0000-4000-8000-000000000705', '00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000205', '00000000-0000-4000-8000-000000000405', 'support', 1.0);

-- ---------- alex: knowledge radar ----------
insert into artifacts (id, user_id, source_type, title, canonical_url, captured_at, raw_text, coverage, processing_status) values
  ('00000000-0000-4000-8000-000000000211', '00000000-0000-4000-8000-000000000102', 'article', 'thinking in systems, applied', 'https://essays.example/systems-applied', '2026-05-20 14:00:00+00', 'stocks, flows, and why point interventions fail in complex orgs', 'text', 'processed'),
  ('00000000-0000-4000-8000-000000000212', '00000000-0000-4000-8000-000000000102', 'podcast', 'ai research roundup ep 12', 'https://systemsthinkers.example/episodes/ai-roundup-12', '2026-05-27 16:30:00+00', null, 'url_only', 'processed'),
  ('00000000-0000-4000-8000-000000000213', '00000000-0000-4000-8000-000000000102', 'text', 'note: generalists', null, '2026-06-02 11:15:00+00', 'generalists win when the map keeps changing. depth is a bet the map holds.', 'text', 'processed');

insert into annotations (id, artifact_id, user_id, annotation_type, value, free_text) values
  ('00000000-0000-4000-8000-000000000311', '00000000-0000-4000-8000-000000000212', '00000000-0000-4000-8000-000000000102', 'watch_request', 'keep me posted', 'keep me posted on new episodes about systems thinking');

insert into watch_entities (id, user_id, entity_type, display_name, identifiers_json, desired_event_types, importance, approved_at, last_checked_at) values
  ('00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000102', 'podcast', 'Systems Thinkers Radio',
   '{"rss_url":"https://systemsthinkers.example/feed","relationship_note":"you said you wanted to stay on top of systems-thinking episodes"}',
   '{new_episode}', 'normal', '2026-06-02 12:00:00+00', '2026-06-08 10:00:00+00');

insert into source_subscriptions (id, watch_entity_id, adapter_type, source_url, source_external_id, last_success_at) values
  ('00000000-0000-4000-8000-000000000811', '00000000-0000-4000-8000-000000000801', 'podcast', 'https://systemsthinkers.example/feed', 'Systems Thinkers Radio', '2026-06-08 10:00:00+00');

insert into world_events (id, canonical_event_key, event_type, title, summary, entity_ids, source_url, source_title, source_published_at, trust_score) values
  ('00000000-0000-4000-8000-000000000821', 'systems thinkers radio|new_episode|the rise of systems thinkers|2026-06-08|systemsthinkers.example/episodes/rise', 'new_episode',
   'The Rise of Systems Thinkers', 'why generalists and synthesizers win the next decade',
   '{00000000-0000-4000-8000-000000000801}', 'https://systemsthinkers.example/episodes/rise', 'Systems Thinkers Radio', '2026-06-08 09:00:00+00', 0.8);

insert into radar_candidates (id, user_id, world_event_id, personal_fit, novelty, timeliness, actionability, source_trust, creepiness_risk, total_score, why_user_json, status) values
  ('00000000-0000-4000-8000-000000000831', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000821',
   0.85, 0.7, 0.8, 0.6, 0.8, 0.05, 0.665,
   '{"text":"you asked co to watch this feed, and you keep saving systems-thinking pieces.","evidence_ids":["00000000-0000-4000-8000-000000000311","00000000-0000-4000-8000-000000000211","00000000-0000-4000-8000-000000000213"]}',
   'sent');

-- ---------- priya: launch watch ----------
insert into artifacts (id, user_id, source_type, title, canonical_url, captured_at, raw_text, coverage, processing_status) values
  ('00000000-0000-4000-8000-000000000221', '00000000-0000-4000-8000-000000000103', 'social_post', 'andera teaser', 'https://social.example/p/andera-teaser', '2026-05-15 18:00:00+00', 'andera demo: memory layers for small teams. waitlist open.', 'text', 'processed'),
  ('00000000-0000-4000-8000-000000000222', '00000000-0000-4000-8000-000000000103', 'social_post', 'andera prototype thread', 'https://social.example/p/andera-proto', '2026-05-24 20:30:00+00', 'long thread on andera early prototypes and design decisions', 'text', 'processed'),
  ('00000000-0000-4000-8000-000000000223', '00000000-0000-4000-8000-000000000103', 'text', 'note: andera', null, '2026-05-24 20:35:00+00', 'stay close to their work. this is the team i would want to build with.', 'text', 'processed');

insert into annotations (id, artifact_id, user_id, annotation_type, value, free_text) values
  ('00000000-0000-4000-8000-000000000321', '00000000-0000-4000-8000-000000000223', '00000000-0000-4000-8000-000000000103', 'watch_request', 'keep me posted', 'you wanted to stay close to their work');

insert into watch_entities (id, user_id, entity_type, display_name, identifiers_json, desired_event_types, importance, approved_at, last_checked_at, last_material_event_at) values
  ('00000000-0000-4000-8000-000000000802', '00000000-0000-4000-8000-000000000103', 'company', 'Andera',
   '{"website":"https://andera.dev","rss_url":"https://andera.dev/blog/feed.atom","relationship_note":"you said you wanted to stay close to their work"}',
   '{launch,funding,new_post}', 'high', '2026-05-25 09:00:00+00', '2026-06-08 16:00:00+00', '2026-06-08 15:00:00+00');

insert into source_subscriptions (id, watch_entity_id, adapter_type, source_url, source_external_id, last_success_at) values
  ('00000000-0000-4000-8000-000000000812', '00000000-0000-4000-8000-000000000802', 'rss', 'https://andera.dev/blog/feed.atom', 'Andera', '2026-06-08 16:00:00+00');

insert into world_events (id, canonical_event_key, event_type, title, summary, entity_ids, source_url, source_title, source_published_at, trust_score) values
  ('00000000-0000-4000-8000-000000000822', 'andera|launch|andera launched|2026-06-08|andera.dev/blog/launch', 'launch',
   'Andera launched', 'andera is live: public launch post from the official blog',
   '{00000000-0000-4000-8000-000000000802}', 'https://andera.dev/blog/launch', 'Andera Blog', '2026-06-08 15:00:00+00', 0.9);

insert into radar_candidates (id, user_id, world_event_id, personal_fit, novelty, timeliness, actionability, source_trust, creepiness_risk, total_score, why_user_json, status) values
  ('00000000-0000-4000-8000-000000000832', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000822',
   0.9, 0.8, 0.9, 0.8, 0.9, 0.05, 0.73,
   '{"text":"you asked co to watch them, and you said you wanted to stay close to their work.","evidence_ids":["00000000-0000-4000-8000-000000000321","00000000-0000-4000-8000-000000000222"]}',
   'sent');

-- ---------- sam: false pattern (receipts + contradiction prevent send) ----------
insert into artifacts (id, user_id, source_type, title, canonical_url, captured_at, raw_text, coverage, processing_status) values
  ('00000000-0000-4000-8000-000000000231', '00000000-0000-4000-8000-000000000104', 'social_post', 'trail run at dawn', 'https://social.example/p/run-dawn', '2026-05-22 13:00:00+00', 'runner on a ridge trail, fog below, film grain', 'text', 'processed'),
  ('00000000-0000-4000-8000-000000000232', '00000000-0000-4000-8000-000000000104', 'social_post', 'marathon street shot', 'https://social.example/p/run-street', '2026-05-28 15:20:00+00', 'marathon crowd shot, long lens compression, golden hour', 'text', 'processed'),
  ('00000000-0000-4000-8000-000000000233', '00000000-0000-4000-8000-000000000104', 'social_post', 'track night', 'https://social.example/p/run-track', '2026-06-04 02:45:00+00', 'night track meet under floodlights, motion blur lane lines', 'text', 'processed');

insert into annotations (id, artifact_id, user_id, annotation_type, value, free_text) values
  ('00000000-0000-4000-8000-000000000331', '00000000-0000-4000-8000-000000000233', '00000000-0000-4000-8000-000000000104', 'why', null, 'i like the photography, not running');

insert into observations (id, user_id, artifact_id, observation_type, statement, confidence) values
  ('00000000-0000-4000-8000-000000000431', '00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000231', 'observation', 'saved a running photo (ridge trail, film grain)', 0.7),
  ('00000000-0000-4000-8000-000000000432', '00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000232', 'observation', 'saved a running photo (marathon, long lens)', 0.7),
  ('00000000-0000-4000-8000-000000000433', '00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000233', 'observation', 'saved a running photo (track night, motion blur)', 0.7),
  ('00000000-0000-4000-8000-000000000434', '00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000233', 'user_statement', 'i like the photography, not running', 0.95);

-- the false pattern: rejected by contradiction, never sent. receipts stay visible for the demo.
insert into hypotheses (id, user_id, statement, alternatives_json, confidence, status) values
  ('00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000104',
   'sam may want to take up running',
   '[{"h":"wants to run","p":0.15},{"h":"drawn to sports photography","p":0.7},{"h":"admires athletic discipline","p":0.15}]',
   0.15, 'rejected');

insert into evidence_links (id, hypothesis_id, artifact_id, observation_id, direction, weight) values
  ('00000000-0000-4000-8000-000000000711', '00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000231', '00000000-0000-4000-8000-000000000431', 'support', 0.6),
  ('00000000-0000-4000-8000-000000000712', '00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000232', '00000000-0000-4000-8000-000000000432', 'support', 0.6),
  ('00000000-0000-4000-8000-000000000713', '00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000233', '00000000-0000-4000-8000-000000000433', 'support', 0.6),
  ('00000000-0000-4000-8000-000000000714', '00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000233', '00000000-0000-4000-8000-000000000434', 'contradict', 1.0);

-- ---------- jordan: privacy (saved without analysis) ----------
-- no observations, no segments, no annotations, no pattern use. fully deletable.
insert into artifacts (id, user_id, source_type, title, captured_at, raw_object_path, mime_type, duration_seconds, retention_mode, sensitivity, coverage, processing_status) values
  ('00000000-0000-4000-8000-000000000241', '00000000-0000-4000-8000-000000000105', 'voice', 'voice note', '2026-06-06 04:30:00+00', '00000000-0000-4000-8000-000000000105/voice/241.m4a', 'audio/mp4', 94, 'no_analysis', 'high', 'full_media', 'stored_only');
