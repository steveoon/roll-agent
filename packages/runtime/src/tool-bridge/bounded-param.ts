import { z } from "zod";

export interface BoundedIntParamSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly description: string;
  readonly defaultNote?: string;
}

export interface BoundedIntParam {
  readonly schema: z.ZodOptional<z.ZodNumber>;
}

export function boundedIntParam(spec: BoundedIntParamSpec): BoundedIntParam {
  const rangeNote = `范围 ${String(spec.min)}-${String(spec.max)}`;
  const schema = z
    .number()
    .int()
    .min(spec.min)
    .max(spec.max)
    .optional()
    .describe(
      `${spec.description}（整数，${rangeNote}${spec.defaultNote !== undefined ? `，${spec.defaultNote}` : ""}）`,
    );
  return { schema };
}

interface ZodIssueLike {
  readonly code?: string;
  readonly path?: readonly (string | number)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly expected?: string;
  readonly type?: string;
}

function readZodIssues(error: unknown): readonly ZodIssueLike[] | undefined {
  if (error === null || typeof error !== "object") {
    return undefined;
  }
  const candidate = error as { issues?: unknown; error?: unknown; cause?: unknown };
  if (Array.isArray(candidate.issues)) {
    return candidate.issues as readonly ZodIssueLike[];
  }
  if (candidate.error !== undefined) {
    const nested = readZodIssues(candidate.error);
    if (nested !== undefined) {
      return nested;
    }
  }
  if (candidate.cause !== undefined) {
    return readZodIssues(candidate.cause);
  }
  return undefined;
}

function valueAt(rawInput: unknown, path: readonly (string | number)[]): unknown {
  let current: unknown = rawInput;
  for (const key of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function receivedText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

export function describeZodIssues(error: unknown, rawInput: unknown): string | undefined {
  const issues = readZodIssues(error);
  if (issues === undefined || issues.length === 0) {
    return undefined;
  }
  const lines = issues.map((issue) => {
    const name = (issue.path ?? []).join(".") || "(root)";
    const received = receivedText(valueAt(rawInput, issue.path ?? []));
    const unit = issue.type === "number" ? " 的整数" : issue.type === "string" ? " 的字符长度" : "";
    if (issue.code === "too_big" && typeof issue.maximum === "number") {
      return `${name} 越界：允许≤${String(issue.maximum)}${unit}，你传了 ${received}`;
    }
    if (issue.code === "too_small" && typeof issue.minimum === "number") {
      return `${name} 越界：允许≥${String(issue.minimum)}${unit}，你传了 ${received}`;
    }
    if (issue.code === "invalid_type") {
      return `${name} 类型错误：需要${issue.expected ?? "合法类型"}，你传了 ${received}`;
    }
    return `${name}: ${issue.code ?? "invalid"}`;
  });
  return lines.join("；");
}

const SERIALIZED_INVALID_PREFIX = "AI_InvalidToolInputError:";

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function friendlyInvalidToolInputMessage(error: unknown): string | undefined {
  if (error !== null && typeof error === "object") {
    const candidate = error as { toolInput?: unknown; cause?: unknown };
    const rawInput =
      typeof candidate.toolInput === "string"
        ? parseJsonObject(candidate.toolInput)
        : candidate.toolInput;
    return describeZodIssues(candidate.cause ?? error, rawInput);
  }
  if (typeof error === "string" && error.startsWith(SERIALIZED_INVALID_PREFIX)) {
    const valueMatch = /Value:\s*(\{.*?\})\.\s*Error message:/su.exec(error);
    const rawInput = valueMatch?.[1] !== undefined ? parseJsonObject(valueMatch[1]) : undefined;
    const issuesMatch = /Error message:\s*(\[.*\])\s*$/su.exec(error);
    if (issuesMatch?.[1] !== undefined) {
      const issues = parseJsonObject(issuesMatch[1]);
      return Array.isArray(issues) ? describeZodIssues({ issues }, rawInput) : undefined;
    }
  }
  return undefined;
}
