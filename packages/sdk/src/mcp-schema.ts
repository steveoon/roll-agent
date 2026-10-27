import { z } from "zod";

const MAX_SCHEMA_UNWRAP_DEPTH = 8;

export function getMcpCompatibleInputSchema(schema: z.ZodType): z.core.$ZodType {
  let current: z.core.$ZodType = schema;

  for (let depth = 0; depth < MAX_SCHEMA_UNWRAP_DEPTH; depth += 1) {
    if (current instanceof z.ZodPipe) {
      current = current.in instanceof z.ZodTransform ? current.out : current.in;
      continue;
    }

    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodPrefault ||
      current instanceof z.ZodCatch ||
      current instanceof z.ZodReadonly
    ) {
      current = current.unwrap();
      continue;
    }

    if (current instanceof z.ZodObject && current._zod.def.checks?.length) {
      // Root refinements used to live in ZodEffects. Keep MCP's shape validation separate
      // from parseToolInput(), which applies the original refinements exactly once.
      return current.clone({ ...current._zod.def, checks: [] });
    }

    return current;
  }

  return current;
}

export async function parseToolInput(schema: z.ZodType, input: unknown): Promise<unknown> {
  const result = await schema.safeParseAsync(input);

  if (!result.success) {
    throw new Error(`Tool input validation failed: ${formatZodError(result.error)}`);
  }

  return result.data;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
