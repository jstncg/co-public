import type { ConditionalSourceAdapter } from "./types";

export class XSourceAdapter implements ConditionalSourceAdapter {
  readonly id = "x_api";
  readonly version = "x-api.v1";

  constructor(private readonly enabled: boolean) {}

  async poll(): ReturnType<ConditionalSourceAdapter["poll"]> {
    if (!this.enabled) throw new Error("X source is disabled by feature flag");
    throw new Error("X live adapter requires approved credentials and spend cap");
  }
}
