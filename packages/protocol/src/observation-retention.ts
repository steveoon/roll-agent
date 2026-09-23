import { z } from "zod/v4";

/** MCP metadata for tools whose successful results are replaceable observations. */
export const OBSERVATION_RETENTION_META_KEY = "roll/observationRetention";

export const observationRetentionDeclarationSchema = z
  .object({ kind: z.literal("browser-ax-snapshot") })
  .strict();

export type ObservationRetentionDeclaration = z.infer<typeof observationRetentionDeclarationSchema>;
