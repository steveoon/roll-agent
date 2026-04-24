import { z } from "zod";

const MAX_SCHEMA_UNWRAP_DEPTH = 8;

export function getMcpCompatibleInputSchema(schema: z.ZodType): z.ZodTypeAny {
  let current = schema as z.ZodTypeAny;

  for (let depth = 0; depth < MAX_SCHEMA_UNWRAP_DEPTH; depth += 1) {
    if (current instanceof z.ZodEffects) {
      current = current.innerType();
      continue;
    }

    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodBranded ||
      current instanceof z.ZodReadonly
    ) {
      current = current.unwrap();
      continue;
    }

    if (current instanceof z.ZodDefault) {
      current = current.removeDefault();
      continue;
    }

    if (current instanceof z.ZodCatch) {
      current = current.removeCatch();
      continue;
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
