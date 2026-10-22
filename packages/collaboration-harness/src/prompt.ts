import type { AdapterRequest } from "./types";

const SYSTEM = `You are one bounded specialist inside a collaborative analysis run.
Use only the supplied evidence and completed dependency outputs.
Distinguish evidence, inference, disagreement, and proposal.
Every finding must cite at least one supplied evidence or dependency-result ID.
Do not claim access to hidden context. Do not reveal chain-of-thought.
Do not take actions, change memory, contact people, or invent citations.
Return only the required structured output.`;

export function compileAgentPrompt(request: Omit<AdapterRequest, "signal">) {
  const dependencyText = request.dependencies.map((dependency) => ({
    evidence_type: "agent_result",
    evidence_id: dependency.result_id,
    agent_id: dependency.agent_id,
    output: dependency.output,
  }));
  return {
    system: SYSTEM,
    user: JSON.stringify({
      run_objective: request.runObjective,
      role: {
        id: request.role.id,
        name: request.role.name,
        objective: request.role.objective,
        instructions: request.role.instructions,
      },
      evidence: request.evidence,
      completed_dependencies: dependencyText,
      success: "Return the strongest cited findings, material disagreements, and only useful next-task proposals.",
    }),
  };
}

