import type { AgentTool } from "../types/agent.ts";
import type { AskRuntimeIssue, AskValidationIssue } from "../types/ask.ts";
import {
  describeValueType,
  getAdditionalPropertiesSetting,
  getSchemaDescription,
  getSchemaEnum,
  getSchemaItems,
  getSchemaMinItems,
  getSchemaProperties,
  getSchemaRequired,
  getSchemaType,
  isNaturallyExtractableSchema,
  isJsonSchemaObject,
  isPlainObject,
} from "./schema.ts";

export interface ToolCallPreflightSuccess {
  readonly ok: true;
}

export interface ToolCallPreflightFailure {
  readonly ok: false;
  readonly issues: ReadonlyArray<AskValidationIssue>;
  readonly runtimeIssues: ReadonlyArray<AskRuntimeIssue>;
}

export type ToolCallPreflightResult = ToolCallPreflightSuccess | ToolCallPreflightFailure;

export interface ToolCallPreflightOptions {
  readonly runtimeIssues?: ReadonlyArray<AskRuntimeIssue>;
}

function buildMissingRequiredIssue(
  fieldPath: string,
  fieldSchema: object | undefined,
): AskValidationIssue {
  const description = getSchemaDescription(fieldSchema);
  const isExplicitInputField = fieldSchema && !isNaturallyExtractableSchema(fieldSchema);

  return {
    path: fieldPath,
    code: isExplicitInputField ? "requires_explicit_input" : "missing_required",
    message: isExplicitInputField
      ? `${fieldPath} 无法从自然语言可靠提取，需要显式提供`
      : `${fieldPath} 为必填字段`,
    ...(description ? { description } : {}),
  };
}

function getMissingRequiredIssues(
  fieldPath: string,
  fieldSchema: object | undefined,
): ReadonlyArray<AskValidationIssue> {
  if (fieldSchema && isJsonSchemaObject(fieldSchema)) {
    const nestedIssues = validateObjectInput({ inputSchema: fieldSchema }, {}, fieldPath);
    if (nestedIssues.length > 0) {
      return nestedIssues;
    }
  }

  return [buildMissingRequiredIssue(fieldPath, fieldSchema)];
}

function validateSchemaValue(
  schema: object,
  value: unknown,
  path: string,
): ReadonlyArray<AskValidationIssue> {
  const issues: AskValidationIssue[] = [];
  const description = getSchemaDescription(schema);
  const enumValues = getSchemaEnum(schema);
  const expectedType = getSchemaType(schema);

  if (enumValues && !enumValues.some((candidate) => Object.is(candidate, value))) {
    issues.push({
      path,
      code: "invalid_enum",
      message: `${path} 必须是以下值之一：${enumValues.map((candidate) => JSON.stringify(candidate)).join("、")}`,
      ...(description ? { description } : {}),
      expected: enumValues.map((candidate) => JSON.stringify(candidate)).join(" | "),
      actual: JSON.stringify(value),
    });
    return issues;
  }

  if (!expectedType) {
    return issues;
  }

  const actualType = describeValueType(value);
  const pushInvalidType = (): void => {
    issues.push({
      path,
      code: "invalid_type",
      message: `${path} 应为 ${expectedType}，当前是 ${actualType}`,
      ...(description ? { description } : {}),
      expected: expectedType,
      actual: actualType,
    });
  };

  switch (expectedType) {
    case "string":
      if (typeof value !== "string") {
        pushInvalidType();
      }
      return issues;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) {
        pushInvalidType();
      }
      return issues;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        pushInvalidType();
      }
      return issues;
    case "boolean":
      if (typeof value !== "boolean") {
        pushInvalidType();
      }
      return issues;
    case "null":
      if (value !== null) {
        pushInvalidType();
      }
      return issues;
    case "array":
      if (!Array.isArray(value)) {
        pushInvalidType();
        return issues;
      }

      {
        const minItems = getSchemaMinItems(schema);
        if (minItems !== undefined && value.length < minItems) {
          issues.push({
            path,
            code: "too_small",
            message: `${path} 至少需要 ${String(minItems)} 个元素，当前是 ${String(value.length)} 个`,
            ...(description ? { description } : {}),
            expected: `minItems: ${String(minItems)}`,
            actual: `length: ${String(value.length)}`,
          });
        }

        const itemSchema = getSchemaItems(schema);
        if (!itemSchema) {
          return issues;
        }

        issues.push(
          ...value.flatMap((item, index) =>
            validateSchemaValue(itemSchema, item, `${path}[${String(index)}]`),
          ),
        );
        return issues;
      }
    case "object":
      if (!isPlainObject(value)) {
        pushInvalidType();
        return issues;
      }
      if (!isJsonSchemaObject(schema)) {
        return issues;
      }
      return validateObjectInput({ inputSchema: schema }, value, path);
    default:
      return issues;
  }
}

function validateObjectInput(
  tool: Pick<AgentTool, "inputSchema">,
  input: Readonly<Record<string, unknown>>,
  pathPrefix = "",
): ReadonlyArray<AskValidationIssue> {
  const required = getSchemaRequired(tool);
  const properties = getSchemaProperties(tool.inputSchema);
  const issues: AskValidationIssue[] = [];

  for (const fieldName of required) {
    const value = input[fieldName];
    if (value !== undefined && value !== null) {
      continue;
    }

    const fieldSchema = properties[fieldName];
    const fieldPath = pathPrefix ? `${pathPrefix}.${fieldName}` : fieldName;
    issues.push(...getMissingRequiredIssues(fieldPath, fieldSchema));
  }

  for (const [fieldName, value] of Object.entries(input)) {
    const fieldPath = pathPrefix ? `${pathPrefix}.${fieldName}` : fieldName;
    const fieldSchema = properties[fieldName];
    if (fieldSchema) {
      issues.push(...validateSchemaValue(fieldSchema, value, fieldPath));
      continue;
    }

    if (getAdditionalPropertiesSetting(tool.inputSchema) === false) {
      issues.push({
        path: fieldPath,
        code: "unexpected_property",
        message: `${fieldPath} 不是允许的参数`,
      });
    }
  }

  return issues;
}

export function getInputValidationIssues(
  tool: Pick<AgentTool, "inputSchema">,
  input: Readonly<Record<string, unknown>>,
): ReadonlyArray<AskValidationIssue> {
  return validateObjectInput(tool, input);
}

export function preflightToolCall(
  tool: Pick<AgentTool, "inputSchema">,
  input: Readonly<Record<string, unknown>>,
  options: ToolCallPreflightOptions = {},
): ToolCallPreflightResult {
  const issues = getInputValidationIssues(tool, input);
  const runtimeIssues = options.runtimeIssues ?? [];
  return issues.length === 0 && runtimeIssues.length === 0
    ? { ok: true }
    : { ok: false, issues, runtimeIssues };
}
