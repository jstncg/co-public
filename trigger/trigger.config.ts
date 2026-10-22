import { defineConfig } from "@trigger.dev/sdk/v3";

// BLOCKED: needs a trigger.dev project (human). set TRIGGER_PROJECT_REF + TRIGGER_SECRET_KEY, see docs/setup.md.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_replace_me",
  dirs: ["./src/tasks"],
  maxDuration: 300,
  retries: {
    enabledInDev: false,
    default: { maxAttempts: 3, minTimeoutInMs: 1000, maxTimeoutInMs: 30_000, factor: 2, randomize: true },
  },
});
