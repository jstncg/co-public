import type { CoRuntime } from "./runtime.ts";

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

export class RuntimeMetrics {
  readonly startedAt = Date.now();
  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<string, { count: number; sumSeconds: number }>();
  private activeRequests = 0;

  beginRequest(): () => void {
    this.activeRequests += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    };
  }

  observeRequest(method: string, route: string, status: number, durationMs: number): void {
    const labels = `${method}|${route}|${status}`;
    this.requests.set(labels, (this.requests.get(labels) ?? 0) + 1);
    const durationLabels = `${method}|${route}`;
    const prior = this.durations.get(durationLabels) ?? { count: 0, sumSeconds: 0 };
    prior.count += 1;
    prior.sumSeconds += durationMs / 1_000;
    this.durations.set(durationLabels, prior);
  }

  render(runtime: CoRuntime): string {
    const tenantId = runtime.config.tenantId;
    const jobRows = runtime.store.db.prepare("SELECT status,COUNT(*) AS count FROM jobs WHERE tenant_id=? GROUP BY status").all(tenantId) as Array<{ status: string; count: number }>;
    const runRows = runtime.store.db.prepare("SELECT status,COUNT(*) AS count FROM runs WHERE tenant_id=? GROUP BY status").all(tenantId) as Array<{ status: string; count: number }>;
    const skillRows = runtime.store.db.prepare("SELECT status,COUNT(*) AS count FROM skill_proposals WHERE tenant_id=? GROUP BY status").all(tenantId) as Array<{ status: string; count: number }>;
    const agentRows = runtime.store.db.prepare("SELECT status,COUNT(*) AS count FROM retained_agents WHERE tenant_id=? GROUP BY status").all(tenantId) as Array<{ status: string; count: number }>;
    const goalRows = runtime.store.db.prepare("SELECT status,COUNT(*) AS count FROM goals WHERE tenant_id=? GROUP BY status").all(tenantId) as Array<{ status: string; count: number }>;
    const refinementRows = runtime.store.db.prepare("SELECT status,COUNT(*) AS count FROM refinement_proposals WHERE tenant_id=? GROUP BY status").all(tenantId) as Array<{ status: string; count: number }>;
    const lines = [
      "# HELP co_uptime_seconds Process uptime in seconds.",
      "# TYPE co_uptime_seconds gauge",
      `co_uptime_seconds ${(Date.now() - this.startedAt) / 1_000}`,
      "# HELP co_http_active_requests Requests currently being processed.",
      "# TYPE co_http_active_requests gauge",
      `co_http_active_requests ${this.activeRequests}`,
      "# HELP co_http_requests_total HTTP requests by method, route, and status.",
      "# TYPE co_http_requests_total counter",
    ];
    for (const [key, count] of [...this.requests.entries()].sort()) {
      const [method = "", route = "", status = ""] = key.split("|");
      lines.push(`co_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${escapeLabel(status)}"} ${count}`);
    }
    lines.push("# HELP co_http_request_duration_seconds HTTP request duration.", "# TYPE co_http_request_duration_seconds summary");
    for (const [key, value] of [...this.durations.entries()].sort()) {
      const [method = "", route = ""] = key.split("|");
      const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}"`;
      lines.push(`co_http_request_duration_seconds_count{${labels}} ${value.count}`);
      lines.push(`co_http_request_duration_seconds_sum{${labels}} ${value.sumSeconds}`);
    }
    lines.push("# HELP co_jobs Jobs by status.", "# TYPE co_jobs gauge");
    for (const row of jobRows) lines.push(`co_jobs{status="${escapeLabel(String(row.status))}"} ${Number(row.count)}`);
    lines.push("# HELP co_runs Runs by status.", "# TYPE co_runs gauge");
    for (const row of runRows) lines.push(`co_runs{status="${escapeLabel(String(row.status))}"} ${Number(row.count)}`);
    lines.push("# HELP co_child_agents Child-agent runs by status.", "# TYPE co_child_agents gauge");
    const childRows = runtime.store.db.prepare("SELECT status,COUNT(*) AS count FROM runs WHERE tenant_id=? AND kind='child' GROUP BY status").all(tenantId) as Array<{ status: string; count: number }>;
    for (const row of childRows) lines.push(`co_child_agents{status="${escapeLabel(String(row.status))}"} ${Number(row.count)}`);
    lines.push("# HELP co_retained_agents Retained addressable agents by lifecycle state.", "# TYPE co_retained_agents gauge");
    for (const row of agentRows) lines.push(`co_retained_agents{status="${escapeLabel(String(row.status))}"} ${Number(row.count)}`);
    lines.push("# HELP co_goals Persistent goals by lifecycle state.", "# TYPE co_goals gauge");
    for (const row of goalRows) lines.push(`co_goals{status="${escapeLabel(String(row.status))}"} ${Number(row.count)}`);
    lines.push("# HELP co_refinement_proposals Governed refinement proposals by lifecycle state.", "# TYPE co_refinement_proposals gauge");
    for (const row of refinementRows) lines.push(`co_refinement_proposals{status="${escapeLabel(String(row.status))}"} ${Number(row.count)}`);
    lines.push("# HELP co_skill_proposals Skill proposals by lifecycle state.", "# TYPE co_skill_proposals gauge");
    for (const row of skillRows) lines.push(`co_skill_proposals{status="${escapeLabel(String(row.status))}"} ${Number(row.count)}`);
    lines.push("# HELP co_connector_ready Connector readiness by direction.", "# TYPE co_connector_ready gauge");
    for (const connector of runtime.connectors.status) {
      lines.push(`co_connector_ready{connector="${escapeLabel(connector.id)}",direction="inbound"} ${connector.inboundConfigured ? 1 : 0}`);
      lines.push(`co_connector_ready{connector="${escapeLabel(connector.id)}",direction="outbound"} ${connector.outboundConfigured ? 1 : 0}`);
    }
    lines.push("# HELP co_memory_records Active memory records.", "# TYPE co_memory_records gauge");
    const memory = runtime.store.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE tenant_id=? AND status='active'").get(tenantId) as { count: number };
    lines.push(`co_memory_records ${Number(memory.count)}`);
    const product = runtime.outcomes.summary(tenantId);
    lines.push(
      "# HELP co_product_member_feedback_total Explicit owner-provenanced ratings of preceding substantive Co messages.",
      "# TYPE co_product_member_feedback_total gauge",
    );
    for (const [kind, count] of Object.entries(product.byKind)) {
      lines.push(`co_product_member_feedback_total{kind="${escapeLabel(kind)}"} ${count}`);
    }
    lines.push(
      "# HELP co_product_feedback_coverage_ratio Share of substantive assistant messages with explicit owner feedback.",
      "# TYPE co_product_feedback_coverage_ratio gauge",
      `co_product_feedback_coverage_ratio ${product.feedbackCoverageRatio}`,
      "# HELP co_product_good_response_ratio Member-validated useful responses divided by every substantive response Co chose to send.",
      "# TYPE co_product_good_response_ratio gauge",
      `co_product_good_response_ratio ${product.goodResponseRatio}`,
      "# HELP co_product_obvious_or_annoying_response_ratio Member-validated obvious or annoying responses divided by every substantive response Co chose to send.",
      "# TYPE co_product_obvious_or_annoying_response_ratio gauge",
      `co_product_obvious_or_annoying_response_ratio ${product.obviousOrAnnoyingResponseRatio}`,
      "# HELP co_product_useful_surprises_total Explicitly member-validated useful surprises.",
      "# TYPE co_product_useful_surprises_total gauge",
      `co_product_useful_surprises_total ${product.usefulSurprises}`,
      "# HELP co_product_silent_responses_total Foreground turns that intentionally used the explicit silence protocol.",
      "# TYPE co_product_silent_responses_total gauge",
      `co_product_silent_responses_total ${product.silentResponses}`,
      "# HELP co_product_tapback_responses_total Foreground turns acknowledged through a provider-accepted iMessage reaction rather than a text bubble.",
      "# TYPE co_product_tapback_responses_total gauge",
      `co_product_tapback_responses_total ${product.tapbackResponses}`,
      "# HELP co_product_proactive_interruptions_sent_total Proactive interventions actually submitted for delivery.",
      "# TYPE co_product_proactive_interruptions_sent_total gauge",
      `co_product_proactive_interruptions_sent_total ${product.proactiveInterruptionsSent}`,
      "# HELP co_product_proactive_attention_admissions_total Proactive candidates admitted through the rolling attention budget.",
      "# TYPE co_product_proactive_attention_admissions_total gauge",
      `co_product_proactive_attention_admissions_total ${product.proactiveAdmissionCount}`,
      "# HELP co_product_proactive_attention_admissions_rolling_24h_max Maximum admissions observed in any inclusive rolling 24-hour window.",
      "# TYPE co_product_proactive_attention_admissions_rolling_24h_max gauge",
      `co_product_proactive_attention_admissions_rolling_24h_max ${product.maximumRolling24HourAdmissions}`,
      "# HELP co_product_proactive_attention_projection_valid Whether every retained admission timestamp is valid for rolling-window qualification.",
      "# TYPE co_product_proactive_attention_projection_valid gauge",
      `co_product_proactive_attention_projection_valid ${product.attentionAdmissionProjectionValid ? 1 : 0}`,
      "# HELP co_product_proactive_interventions_total Proactive interventions by provider-accepted and member-delivered evidence state.",
      "# TYPE co_product_proactive_interventions_total gauge",
      `co_product_proactive_interventions_total{state="accepted"} ${product.proactiveAccepted}`,
      `co_product_proactive_interventions_total{state="delivered"} ${product.proactiveDelivered}`,
      "# HELP co_product_proactive_feedback_total Current explicit owner ratings causally linked to a proactive intervention.",
      "# TYPE co_product_proactive_feedback_total gauge",
    );
    for (const [kind, count] of Object.entries(product.proactiveByKind)) {
      lines.push(`co_product_proactive_feedback_total{kind="${escapeLabel(kind)}"} ${count}`);
    }
    lines.push(
      "# HELP co_product_proactive_feedback_coverage_ratio Current proactive ratings divided by provider-accepted proactive interventions.",
      "# TYPE co_product_proactive_feedback_coverage_ratio gauge",
      `co_product_proactive_feedback_coverage_ratio ${product.proactiveFeedbackCoverageRatio}`,
      "# HELP co_product_proactive_good_response_ratio Member-validated useful proactive messages divided by every provider-accepted proactive message.",
      "# TYPE co_product_proactive_good_response_ratio gauge",
      `co_product_proactive_good_response_ratio ${product.proactiveGoodResponseRatio}`,
      "# HELP co_product_proactive_obvious_or_annoying_response_ratio Member-validated obvious or annoying proactive messages divided by every provider-accepted proactive message.",
      "# TYPE co_product_proactive_obvious_or_annoying_response_ratio gauge",
      `co_product_proactive_obvious_or_annoying_response_ratio ${product.proactiveObviousOrAnnoyingResponseRatio}`,
    );
    if (product.firstUsefulSurpriseElapsedDays !== null) {
      lines.push(
        "# HELP co_product_first_useful_surprise_elapsed_days Days from the first owner message to the first owner-validated useful surprise.",
        "# TYPE co_product_first_useful_surprise_elapsed_days gauge",
        `co_product_first_useful_surprise_elapsed_days ${product.firstUsefulSurpriseElapsedDays}`,
      );
    }
    if (product.ratedGoodResponseRatio !== null) {
      lines.push(
        "# HELP co_product_rated_good_response_ratio Useful ratings divided by explicit non-neutral ratings; inspect feedback coverage with it.",
        "# TYPE co_product_rated_good_response_ratio gauge",
        `co_product_rated_good_response_ratio ${product.ratedGoodResponseRatio}`,
        "# HELP co_product_rated_obvious_or_annoying_ratio Obvious or annoying ratings divided by explicit non-neutral ratings.",
        "# TYPE co_product_rated_obvious_or_annoying_ratio gauge",
        `co_product_rated_obvious_or_annoying_ratio ${product.ratedObviousOrAnnoyingRatio ?? 0}`,
      );
    }
    if (product.contextAdvantageRatio !== null) {
      lines.push(
        "# HELP co_product_context_advantage_ratio Positive explicit context-advantage ratings divided by known yes/no ratings.",
        "# TYPE co_product_context_advantage_ratio gauge",
        `co_product_context_advantage_ratio ${product.contextAdvantageRatio}`,
      );
    }
    if (product.proactiveRatedGoodResponseRatio !== null) {
      lines.push(
        "# HELP co_product_proactive_rated_good_response_ratio Useful ratings divided by explicit non-neutral ratings causally linked to proactive interventions.",
        "# TYPE co_product_proactive_rated_good_response_ratio gauge",
        `co_product_proactive_rated_good_response_ratio ${product.proactiveRatedGoodResponseRatio}`,
        "# HELP co_product_proactive_rated_obvious_or_annoying_ratio Obvious or annoying ratings divided by explicit non-neutral proactive ratings.",
        "# TYPE co_product_proactive_rated_obvious_or_annoying_ratio gauge",
        `co_product_proactive_rated_obvious_or_annoying_ratio ${product.proactiveRatedObviousOrAnnoyingRatio ?? 0}`,
      );
    }
    lines.push(
      "# HELP co_product_tenure_feedback_total Explicit member feedback by 30.4375-day relationship-tenure month.",
      "# TYPE co_product_tenure_feedback_total gauge",
      "# HELP co_product_tenure_proactive_feedback_total Current explicit owner ratings causally linked to proactive interventions, bucketed by intervention tenure month.",
      "# TYPE co_product_tenure_proactive_feedback_total gauge",
      "# HELP co_product_tenure_proactive_interruptions_sent Proactive interruptions sent by relationship-tenure month.",
      "# TYPE co_product_tenure_proactive_interruptions_sent gauge",
      "# HELP co_product_tenure_messages Messages by role and relationship-tenure month.",
      "# TYPE co_product_tenure_messages gauge",
      "# HELP co_product_tenure_proactive_interventions Proactive interventions by evidence state and relationship-tenure month.",
      "# TYPE co_product_tenure_proactive_interventions gauge",
      "# HELP co_product_tenure_quality_ratio Conservative member-validated quality ratios over all substantive or provider-accepted messages by tenure month.",
      "# TYPE co_product_tenure_quality_ratio gauge",
    );
    for (const month of product.tenureMonths) {
      for (const [kind, count] of Object.entries({
        useful_surprise: month.usefulSurprises, useful: month.useful, obvious: month.obvious, annoying: month.annoying, neutral: month.neutral,
      })) lines.push(`co_product_tenure_feedback_total{month="${month.month}",kind="${kind}"} ${count}`);
      for (const [kind, count] of Object.entries(month.proactiveByKind)) {
        lines.push(`co_product_tenure_proactive_feedback_total{month="${month.month}",kind="${escapeLabel(kind)}"} ${count}`);
      }
      lines.push(`co_product_tenure_proactive_interruptions_sent{month="${month.month}"} ${month.proactiveInterruptionsSent}`);
      lines.push(`co_product_tenure_messages{month="${month.month}",role="owner"} ${month.ownerMessages}`);
      lines.push(`co_product_tenure_messages{month="${month.month}",role="assistant_substantive"} ${month.authoredSubstantiveMessages}`);
      lines.push(`co_product_tenure_proactive_interventions{month="${month.month}",state="accepted"} ${month.proactiveAccepted}`);
      lines.push(`co_product_tenure_proactive_interventions{month="${month.month}",state="delivered"} ${month.proactiveDelivered}`);
      lines.push(`co_product_tenure_quality_ratio{month="${month.month}",surface="reactive",kind="good"} ${month.goodResponseRatio}`);
      lines.push(`co_product_tenure_quality_ratio{month="${month.month}",surface="reactive",kind="negative"} ${month.obviousOrAnnoyingResponseRatio}`);
      lines.push(`co_product_tenure_quality_ratio{month="${month.month}",surface="proactive",kind="good"} ${month.proactiveGoodResponseRatio}`);
      lines.push(`co_product_tenure_quality_ratio{month="${month.month}",surface="proactive",kind="negative"} ${month.proactiveObviousOrAnnoyingResponseRatio}`);
    }
    lines.push("# HELP co_product_promises Due-or-already-resolved promises by outcome at the observation time.", "# TYPE co_product_promises gauge");
    for (const [state, count] of Object.entries(product.promises)) lines.push(`co_product_promises{state="${escapeLabel(state)}"} ${count}`);
    lines.push("# HELP co_product_consequential_effects Consequential tool receipts by semantic effect state.", "# TYPE co_product_consequential_effects gauge");
    for (const [state, count] of Object.entries(product.consequentialEffects)) lines.push(`co_product_consequential_effects{state="${escapeLabel(state)}"} ${count}`);
    return `${lines.join("\n")}\n`;
  }
}
