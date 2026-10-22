import { describe, expect, it } from "vitest";
import { awarenessTickV1 } from "../src/tasks/awareness-tick-v1";
import { collaborationRunV1 } from "../src/tasks/collaboration-run-v1";
import { contextEventV1 } from "../src/tasks/context-event-v1";
import { processArtifactV1 } from "../src/tasks/process-artifact-v1";

describe("durable refinery wiring", () => {
  it("registers the exact task id dispatched by web and transport capture", () => {
    expect(processArtifactV1.id).toBe("process-artifact-v1");
  });

  it("registers the monitorable collaboration run task", () => {
    expect(collaborationRunV1.id).toBe("collaboration-run-v1");
  });

  it("registers the durable ambient event worker and catch-up schedule", () => {
    expect(contextEventV1.id).toBe("context-event-v1");
    expect(awarenessTickV1.id).toBe("awareness-tick-v1");
  });
});
