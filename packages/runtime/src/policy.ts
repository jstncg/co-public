import type { AutonomyConfig, ToolDefinition } from "./types.ts";

export interface PolicyDecision {
  allowed: boolean;
  approvalRequired: boolean;
  reason: string;
}

export class ActionPolicy {
  readonly config: AutonomyConfig;

  constructor(config: AutonomyConfig) {
    this.config = config;
  }

  decide(tool: ToolDefinition): PolicyDecision {
    if (this.config.autoApproveRisks.includes(tool.risk)) {
      return { allowed: true, approvalRequired: false, reason: `${tool.risk} is within the configured standing authority` };
    }
    return {
      allowed: true,
      approvalRequired: true,
      reason: `${tool.risk} crosses the current authority boundary; review the exact arguments before execution`,
    };
  }
}
