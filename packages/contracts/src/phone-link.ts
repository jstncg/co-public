import { z } from "zod";

export const phoneLinkRequestSchema = z.object({
  phoneNumber: z.string().trim().regex(/^\+[1-9][0-9]{7,14}$/),
}).strict();

export const phoneLinkVerifySchema = z.object({
  challengeId: z.uuid(),
  code: z.string().regex(/^[0-9]{6}$/),
}).strict();

export const phoneLinkStatusSchema = z.object({
  linked: z.boolean(),
  phoneLast4: z.string().regex(/^[0-9]{4}$/).nullable(),
  verifiedAt: z.iso.datetime({ offset: true }).nullable(),
  handoffNumber: z.string().regex(/^\+[1-9][0-9]{7,14}$/).nullable(),
}).strict();

export type PhoneLinkStatus = z.infer<typeof phoneLinkStatusSchema>;

