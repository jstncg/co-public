/** cost records for the model_runs table (goal.md §25.6). pricing injected, never hardcoded. */

export interface ModelCostRecord {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  estimated_cost: number | null; // null = pricing unknown; the dashboard must show "unknown", not 0
}

export type PricingTable = Record<string, { input_per_mtok: number; output_per_mtok: number }>;

/** MODEL_PRICING_JSON: {"gpt-x":{"input_per_mtok":1.25,"output_per_mtok":10}} — kept current by ops, verified against live provider pricing. */
export function loadPricingTable(env: Record<string, string | undefined> = process.env): PricingTable {
  const raw = env.MODEL_PRICING_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as PricingTable;
  } catch {
    throw new Error("MODEL_PRICING_JSON is not valid JSON");
  }
}

export function estimateCost(table: PricingTable, model: string, inputTokens: number, outputTokens: number): number | null {
  const p = table[model];
  if (!p) return null;
  return (inputTokens * p.input_per_mtok + outputTokens * p.output_per_mtok) / 1_000_000;
}

export function makeCostRecord(opts: {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  pricing: PricingTable;
}): ModelCostRecord {
  return {
    provider: opts.provider,
    model: opts.model,
    input_tokens: opts.input_tokens,
    output_tokens: opts.output_tokens,
    latency_ms: opts.latency_ms,
    estimated_cost: estimateCost(opts.pricing, opts.model, opts.input_tokens, opts.output_tokens),
  };
}

export type CostSink = (record: ModelCostRecord & { task: string }) => void;
