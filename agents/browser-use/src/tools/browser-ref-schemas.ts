import { BrowserElementRefHandleSchema } from "@roll-agent/browser";
import { z } from "zod";

export const BrowserElementRefResolveStrategySchema = z.enum(["backend_node_id", "role_name_nth"]);

export const BrowserElementRefTargetSchema = z.object({
  ref: BrowserElementRefHandleSchema,
  role: z.string(),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  resolvedBy: BrowserElementRefResolveStrategySchema,
  backendNodeId: z.number().int().positive().optional(),
  frameId: z.string().optional(),
  disabled: z.boolean(),
});

export const BrowserElementRefActionOutputSchema = z.object({
  success: z.literal(true),
  ref: BrowserElementRefHandleSchema,
  resolvedBy: BrowserElementRefResolveStrategySchema,
  target: BrowserElementRefTargetSchema,
});
