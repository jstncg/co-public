export type DemoPersona = "maya" | "alex" | "priya" | "sam";

export type DemoSeed = {
  profiles: Record<string, unknown>[];
  artifacts: Record<string, unknown>[];
  annotations: Record<string, unknown>[];
  modelRuns: Record<string, unknown>[];
  observations: Record<string, unknown>[];
  hypotheses: Record<string, unknown>[];
  evidenceLinks: Record<string, unknown>[];
  consents: Record<string, unknown>[];
  watches: Record<string, unknown>[];
  worldEvents: Record<string, unknown>[];
  sourceReceipts: Record<string, unknown>[];
  radarCandidates: Record<string, unknown>[];
  moves: Record<string, unknown>[];
  outcomes: Record<string, unknown>[];
  callbacks: Record<string, unknown>[];
  productEvents: Record<string, unknown>[];
};

const prefixes: Record<DemoPersona, string> = { maya: "a", alex: "b", priya: "c", sam: "d" };
const at = (day: number, hour = 12) => `2026-07-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`;
const id = (persona: DemoPersona, group: number, item: number) =>
  `${prefixes[persona].repeat(8)}-${String(group).padStart(4, "0")}-4000-8000-${String(item).padStart(12, "0")}`;

type Moment = {
  title: string;
  sourceType: string;
  coverage: string;
  day: number;
  text?: string;
  url?: string;
  note?: string;
  timestampSeconds?: number;
};

const moments: Record<DemoPersona, Moment[]> = {
  maya: [
    { title: "pottery reel", sourceType: "short_video", coverage: "url_only", day: 8, url: "https://example.com/maya/pottery", note: "I want more rooms like this." },
    { title: "communal dinner", sourceType: "screenshot", coverage: "image", day: 10, text: "A long table after everyone cooked together.", note: "The together part matters." },
    { title: "neighborhood book club", sourceType: "social_post", coverage: "url_only", day: 12, url: "https://example.com/maya/book-club", note: "People discussing one thing, not networking." },
    { title: "third places", sourceType: "youtube", coverage: "url_only", day: 14, url: "https://www.youtube.com/watch?v=demo&t=482", timestampSeconds: 482, note: "A recurring room changes who you meet." },
    { title: "interesting friends", sourceType: "voice", coverage: "text", day: 16, text: "I think I want interesting friends, but maybe what I actually want is a place where people keep showing up to make something.", note: "This felt unusually true." },
  ],
  alex: [
    { title: "systems thinking article", sourceType: "article", coverage: "text", day: 9, url: "https://example.com/alex/systems", text: "Generalists connect feedback loops across disciplines." },
    { title: "AI research podcast", sourceType: "podcast", coverage: "url_only", day: 11, url: "https://example.com/alex/podcast", note: "Listen when there is a concrete new episode." },
    { title: "note about generalists", sourceType: "text", coverage: "text", day: 13, text: "The useful people are often translators between fields." },
    { title: "watched creator project", sourceType: "person", coverage: "url_only", day: 15, url: "https://example.com/systems-thinkers", note: "Watch this project for new episodes." },
  ],
  priya: [
    { title: "Andera prototype post", sourceType: "social_post", coverage: "url_only", day: 9, url: "https://example.com/andera/prototype" },
    { title: "Andera build update", sourceType: "social_post", coverage: "url_only", day: 13, url: "https://example.com/andera/build-update" },
    { title: "stay close to their work", sourceType: "text", coverage: "text", day: 15, text: "Stay close to Andera's work; congratulate them when they launch." },
  ],
  sam: [
    { title: "rainy running portrait", sourceType: "social_post", coverage: "url_only", day: 8, url: "https://example.com/sam/running-portrait" },
    { title: "track photo essay", sourceType: "article", coverage: "text", day: 11, url: "https://example.com/sam/track-photos", text: "A photo essay shot around an empty track." },
    { title: "marathon contact sheet", sourceType: "image", coverage: "image", day: 14, text: "Black-and-white marathon contact sheet." },
    { title: "photography correction", sourceType: "text", coverage: "text", day: 16, text: "I like the photography, not running.", note: "Do not turn this into a fitness goal." },
  ],
};

export function buildDemoSeed(userIds: Record<DemoPersona, string>): DemoSeed {
  const seed: DemoSeed = {
    profiles: [], artifacts: [], annotations: [], modelRuns: [], observations: [], hypotheses: [], evidenceLinks: [],
    consents: [], watches: [], worldEvents: [], sourceReceipts: [], radarCandidates: [], moves: [], outcomes: [], callbacks: [], productEvents: [],
  };

  for (const persona of Object.keys(moments) as DemoPersona[]) {
    const userId = userIds[persona];
    seed.profiles.push({ id: userId, timezone: "America/Los_Angeles", city: "San Francisco", locale: "en-US", register: "warm", onboarding_state: "complete", cohort_city: "demo" });
    seed.consents.push({ id: id(persona, 9, 1), user_id: userId, consent_type: "founder_review", version: "demo.v1", granted_at: at(7), expires_at: "2030-01-01T00:00:00Z", metadata: { seeded_demo: true } });

    moments[persona].forEach((moment, index) => {
      const artifactId = id(persona, 1, index + 1);
      seed.artifacts.push({
        id: artifactId, user_id: userId, client_artifact_id: id(persona, 2, index + 1), idempotency_key: `demo:${persona}:${index + 1}`,
        source_type: moment.sourceType, canonical_url: moment.url ?? null, title: moment.title, publisher: moment.url ? "demo public source" : null,
        captured_at: at(moment.day), raw_text: moment.text ?? null, timestamp_seconds: moment.timestampSeconds ?? null, user_note: moment.note ?? null,
        source_coverage: moment.coverage, processing_status: "ready", analysis_allowed: true, sensitivity: "low",
      });
      seed.observations.push({
        id: id(persona, 3, index + 1), user_id: userId, artifact_id: artifactId, observation_type: "source_content",
        statement: moment.text ?? moment.title, scope: "seeded visible or user-supplied content", confidence: 0.8,
        evidence_span: { seeded_demo: true, coverage: moment.coverage }, created_at: at(moment.day, 13),
      });
      if (moment.note) {
        seed.annotations.push({ id: id(persona, 4, index + 1), user_id: userId, artifact_id: artifactId, annotation_type: "why", value: moment.note, created_at: at(moment.day, 14) });
        seed.observations.push({
          id: id(persona, 5, index + 1), user_id: userId, artifact_id: artifactId, observation_type: "user_why",
          statement: moment.note, scope: "why this specific catch mattered", confidence: 1,
          evidence_span: { annotation_id: id(persona, 4, index + 1), seeded_demo: true }, created_at: at(moment.day, 14),
        });
      }
      seed.productEvents.push({ user_id: userId, event_name: "capture_saved", properties: { sourceType: moment.sourceType, sourceCoverage: moment.coverage, success: true }, occurred_at: at(moment.day) });
    });
  }

  const addPattern = (persona: DemoPersona, statement: string, alternatives: string[], status: string, directions: string[]) => {
    const userId = userIds[persona];
    const hypothesisId = id(persona, 6, 1);
    const runId = id(persona, 7, 1);
    seed.modelRuns.push({
      id: runId, user_id: userId, task_type: "pattern_candidate", provider: "mock", model: "seeded-demo",
      prompt_version: "pattern-candidate.v1", input_artifact_ids: moments[persona].map((_, index) => id(persona, 1, index + 1)),
      output_schema_version: "pattern-candidate.v1", latency_ms: 0, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
      status: "succeeded", uncertainty_summary: alternatives, created_at: at(17),
    });
    seed.hypotheses.push({
      id: hypothesisId, user_id: userId, statement, alternatives_json: alternatives, confidence: status === "review" ? 0.58 : 0.82,
      sensitivity: "low", status, proposed_copy: statement, reason_to_send: status === "review" ? "blocked by explicit contradiction" : "three receipts across multiple days",
      fingerprint: `demo:${persona}:pattern`, created_at: at(17), updated_at: at(17),
    });
    directions.forEach((direction, index) => seed.evidenceLinks.push({
      id: id(persona, 8, index + 1), user_id: userId, hypothesis_id: hypothesisId,
      artifact_id: id(persona, 1, index + 1), observation_id: id(persona, direction === "contradict" ? 5 : 3, index + 1),
      direction, weight: direction === "contradict" ? 1.4 : 1, created_at: at(17),
    }));
    return hypothesisId;
  };

  const mayaPattern = addPattern("maya", "You keep returning to rooms where people make or discuss something together.", ["You may simply like warm visual scenes.", "The repeat attendance may matter more than the activity."], "delivered", ["support", "support", "support", "support", "support"]);
  addPattern("sam", "You may want to start running.", ["The photography style, not the activity, may be the draw."], "review", ["support", "support", "support", "contradict"]);

  seed.moves.push({ id: id("maya", 10, 1), user_id: userIds.maya, origin_type: "hypothesis", origin_id: mayaPattern, move_type: "experiment", title: "Try a six-week ceramics course", plan_json: { steps: ["choose one beginner course", "attend the first class", "notice whether the people or the making mattered more"] }, status: "completed", approved_at: at(18), completed_at: at(19), created_at: at(18), updated_at: at(19) });
  seed.outcomes.push({ id: id("maya", 11, 1), user_id: userIds.maya, move_id: id("maya", 10, 1), result: "The people mattered; I attended again.", value_rating: 5, surprise_rating: 3, repeat_intent: "yes", created_at: at(20) });

  const addRadar = (persona: "alex" | "priya", displayName: string, relationship: string, eventType: string, title: string, summary: string, url: string, why: string) => {
    const userId = userIds[persona];
    const watchId = id(persona, 12, 1);
    const eventId = id(persona, 13, 1);
    const candidateId = id(persona, 14, 1);
    seed.watches.push({ id: watchId, user_id: userId, entity_type: persona === "alex" ? "project" : "company", display_name: displayName, relationship_note: relationship, desired_event_types: [eventType], importance: 0.8, approved_at: at(15), created_at: at(15), updated_at: at(15) });
    seed.worldEvents.push({ id: eventId, canonical_key: `demo:${persona}:${eventType}`, event_type: eventType, title, summary, canonical_url: url, published_at: at(19), discovered_at: at(19), content_hash: `demo-${persona}`, source_trust: 0.9, public_metadata: { seeded_demo: true } });
    seed.sourceReceipts.push({ id: id(persona, 15, 1), user_id: userId, world_event_id: eventId, canonical_url: url, source_title: title, publisher: "demo public source", retrieved_at: at(19), coverage: "text", content_hash: `demo-${persona}`, provider_metadata: { adapter: "seeded-demo", adapter_version: "v1" } });
    seed.radarCandidates.push({ id: candidateId, user_id: userId, watch_entity_id: watchId, world_event_id: eventId, personal_relevance: 0.9, novelty: 0.95, timeliness: 0.9, actionability: 0.8, source_trust: 0.9, creepiness_risk: 0.05, total_score: 0.89, evidence_artifact_ids: [id(persona, 1, moments[persona].length)], why_user: why, status: "inbox", created_at: at(19) });
    seed.callbacks.push({ id: id(persona, 16, 1), user_id: userId, callback_type: "radar", resource_id: candidateId, evidence_artifact_ids: [id(persona, 1, moments[persona].length)], lock_screen_copy: "Something you asked co to watch changed.", scheduled_at: at(19, 16), sent_at: at(19, 16), created_at: at(19, 15) });
    return candidateId;
  };

  const alexRadar = addRadar("alex", "Rise of Systems Thinkers", "I want concrete new work from this project.", "episode_release", "New “Rise of Systems Thinkers” episode", "A new episode connects AI research with cross-disciplinary generalists.", "https://example.com/systems-thinkers/new-episode", "You explicitly watched this project for new episodes after saving systems-thinking material.");
  const priyaRadar = addRadar("priya", "Andera", "Stay close to their work and congratulate a real launch.", "launch", "Andera launched", "Andera published its launch announcement.", "https://example.com/andera/launch", "You explicitly approved an Andera launch watch after saving two public updates.");

  seed.moves.push(
    { id: id("alex", 10, 1), user_id: userIds.alex, origin_type: "radar", origin_id: alexRadar, move_type: "listen_share", title: "Listen, save a timestamp, and send it to a friend", plan_json: { steps: ["open the cited episode", "save one timestamp", "edit a message draft"] }, status: "approved", approved_at: at(20), created_at: at(20), updated_at: at(20) },
    { id: id("priya", 10, 1), user_id: userIds.priya, origin_type: "radar", origin_id: priyaRadar, move_type: "message", title: "Open the source and draft congratulations", plan_json: { steps: ["open the launch source", "edit congratulations", "choose whether to share"] }, status: "prepared", created_at: at(20), updated_at: at(20) },
  );

  return seed;
}

export const demoEmails: Record<DemoPersona, string> = {
  maya: "maya@demo.co.local", alex: "alex@demo.co.local", priya: "priya@demo.co.local", sam: "sam@demo.co.local",
};
