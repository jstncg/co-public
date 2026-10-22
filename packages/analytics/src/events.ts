import { productEventSchema, type ProductEvent } from "@co/contracts";

type InsertResult = PromiseLike<{ error: { message: string } | null }>;
export type AnalyticsDatabase = {
  from(table: "product_events"): { insert(row: unknown): InsertResult };
};

export async function recordProductEvent(database: AnalyticsDatabase, userId: string, input: unknown): Promise<ProductEvent> {
  const event = productEventSchema.parse(input);
  const { error } = await database.from("product_events").insert({
    user_id: userId,
    event_name: event.name,
    properties: event.properties,
    occurred_at: event.occurredAt,
  });
  if (error) throw new Error(`product event insert: ${error.message}`);
  return event;
}

export type WeeklyMetricInputs = {
  onboardedUsers: number;
  activatedUsers: number;
  threeDayHabitUsers: number;
  qualifiedUsers: number;
  qualifiedPatternMoveUsers: number;
  radarRecipientUsers: number;
  radarUsefulActionUsers: number;
  notificationEnabledUsers: number;
  notificationMutedUsers: number;
  founderDecisions: number;
  founderEditedOrRejected: number;
  activeUsers: number;
  modelCost: number;
  deletionRequests: number;
  exportRequests: number;
  invites: number;
};

const rate = (numerator: number, denominator: number) => denominator === 0 ? null : numerator / denominator;

export function weeklyMetrics(input: WeeklyMetricInputs) {
  return {
    activationRate: rate(input.activatedUsers, input.onboardedUsers),
    threeDaySaveHabitRate: rate(input.threeDayHabitUsers, input.activatedUsers),
    patternToMoveRate: rate(input.qualifiedPatternMoveUsers, input.qualifiedUsers),
    radarUsefulActionRate: rate(input.radarUsefulActionUsers, input.radarRecipientUsers),
    notificationMuteRate: rate(input.notificationMutedUsers, input.notificationEnabledUsers + input.notificationMutedUsers),
    founderEditRejectRate: rate(input.founderEditedOrRejected, input.founderDecisions),
    averageModelCostPerActiveUser: rate(input.modelCost, input.activeUsers),
    deletionRequests: input.deletionRequests,
    exportRequests: input.exportRequests,
    organicAdvocacyInvites: input.invites,
  };
}
