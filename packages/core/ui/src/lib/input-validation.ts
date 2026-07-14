import type { ConfigNumberConstraints } from "../types.ts";

const ENV_REFERENCE_PREFIX = "$";
export const ENV_REFERENCE_TEMPLATE = `${ENV_REFERENCE_PREFIX}{ENV_VAR}`;

export function isCompleteEnvReference(value: string): boolean {
  return /^\$\{[^{}\s]+\}$/u.test(value);
}

export function validateEnvironmentReference(value: string): string | undefined {
  return isCompleteEnvReference(value) ? undefined : `请输入完整的 ${ENV_REFERENCE_TEMPLATE} 引用`;
}

export function validateAgentScalarInput(
  type: "boolean" | "number",
  value: string,
): string | undefined {
  if (value.length === 0) return undefined;
  if (type === "boolean" && (value.toLowerCase() === "true" || value.toLowerCase() === "false")) {
    return undefined;
  }
  if (type === "number" && Number.isFinite(Number(value))) return undefined;
  return validateEnvironmentReference(value);
}

export function validateNumberInput(
  value: string,
  constraints: ConfigNumberConstraints,
): string | undefined {
  if (value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "请输入有效数字";
  if (constraints.integer && !Number.isInteger(parsed)) return "请输入整数";
  if (constraints.minimum !== undefined) {
    const invalid = constraints.exclusiveMinimum
      ? parsed <= constraints.minimum
      : parsed < constraints.minimum;
    if (invalid) {
      return constraints.exclusiveMinimum
        ? `必须大于 ${String(constraints.minimum)}`
        : `不能小于 ${String(constraints.minimum)}`;
    }
  }
  if (constraints.maximum !== undefined) {
    const invalid = constraints.exclusiveMaximum
      ? parsed >= constraints.maximum
      : parsed > constraints.maximum;
    if (invalid) {
      return constraints.exclusiveMaximum
        ? `必须小于 ${String(constraints.maximum)}`
        : `不能大于 ${String(constraints.maximum)}`;
    }
  }
  return undefined;
}

export function validateJsonText(value: string, present: boolean): string | undefined {
  if (!present) return undefined;
  try {
    JSON.parse(value);
    return undefined;
  } catch {
    return "请输入有效 JSON";
  }
}
