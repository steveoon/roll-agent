import { z } from "zod";

export const THREAD_ORIGIN_KINDS = ["interactive", "scheduled"] as const;

export const scheduledThreadOriginSchema = z
  .object({
    kind: z.literal(THREAD_ORIGIN_KINDS[1]),
    scheduleId: z.string().min(1),
    invocationId: z.string().min(1),
    attempt: z.number().int().positive(),
    name: z.string().min(1),
    cwd: z.string().min(1),
    scheduledFor: z.string().datetime({ offset: true }),
    ledgerDir: z.string().min(1),
  })
  .strict()
  .readonly();

export const threadOriginSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal(THREAD_ORIGIN_KINDS[0]) }).strict(),
    scheduledThreadOriginSchema.unwrap(),
  ])
  .readonly();

export const threadDerivedFromSchema = z
  .object({
    threadId: z.string().min(1),
    origin: threadOriginSchema,
    capturedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .readonly();

export type ThreadOrigin = z.infer<typeof threadOriginSchema>;
export type ScheduledThreadOrigin = z.infer<typeof scheduledThreadOriginSchema>;
export type ThreadDerivedFrom = z.infer<typeof threadDerivedFromSchema>;
