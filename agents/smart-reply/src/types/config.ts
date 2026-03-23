import { z } from "zod";

export const BrandPriorityStrategySchema = z.enum([
  "user-selected",
  "conversation-extracted",
  "smart",
]);

export type BrandPriorityStrategy = z.infer<typeof BrandPriorityStrategySchema>;
