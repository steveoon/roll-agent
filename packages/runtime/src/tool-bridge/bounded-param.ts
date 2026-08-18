import { z } from "zod";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  type NormalizedToolResult,
} from "./normalize-result.ts";

export interface BoundedIntParamSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly description: string;
  readonly defaultNote?: string;
}

export interface BoundedIntParam {
  readonly schema: z.ZodOptional<z.ZodNumber>;
  readonly check: (value: number | undefined) => NormalizedToolResult | undefined;
}

export function boundedIntParam(spec: BoundedIntParamSpec): BoundedIntParam {
  const rangeNote = `范围 ${String(spec.min)}-${String(spec.max)}`;
  const schema = z
    .number()
    .optional()
    .describe(
      `${spec.description}（整数，${rangeNote}${spec.defaultNote !== undefined ? `，${spec.defaultNote}` : ""}）`,
    );
  const check = (value: number | undefined): NormalizedToolResult | undefined => {
    if (
      value === undefined ||
      (Number.isInteger(value) && value >= spec.min && value <= spec.max)
    ) {
      return undefined;
    }
    return failedToolResult(
      TOOL_OUTCOME_KINDS.invalidInput,
      `${spec.name} 越界：允许 ${rangeNote} 的整数，你传了 ${String(value)}`,
    );
  };
  return { schema, check };
}
