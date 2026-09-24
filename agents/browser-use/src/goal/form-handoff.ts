import { z } from "zod";
import { FormFieldStateSchema } from "./form-context.ts";

/** A summary is not a fresh locator or an independent certification of completion. */
export const FormHandoffSchema = z.object({
  observationFresh: z.boolean(),
  diagnosticsOmitted: z.literal(true),
  totalSteps: z.number().int().nonnegative(),
  omittedSteps: z.number().int().nonnegative(),
  fields: z
    .array(
      FormFieldStateSchema.pick({
        id: true,
        name: true,
        intent: true,
        status: true,
        reason: true,
      }).extend({
        expected: z.string().optional(),
        current: z.string().optional(),
        valueTruncated: z.boolean(),
      }),
    )
    .max(16),
  next: z.string(),
});
