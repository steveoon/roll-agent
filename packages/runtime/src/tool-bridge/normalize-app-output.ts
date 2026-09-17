import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  APP_OUTPUT_LIMITS,
  APP_OUTPUT_STATUS_META_KEY,
  appOutputResultSchema,
  validateAppOutputContract,
  type AppOutputContract,
  type AppOutputResult,
} from "@roll-agent/protocol";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The SDK uses isError to bypass MCP automatic validation after execution has completed. */
export function hasCompletedAppOutputMarker(value: unknown): boolean {
  if (!isObject(value) || !isObject(value._meta)) return false;
  return (
    value._meta["roll/executionStatus"] === "completed" &&
    (value._meta[APP_OUTPUT_STATUS_META_KEY] === "invalid" ||
      value._meta[APP_OUTPUT_STATUS_META_KEY] === "too_large")
  );
}

/** Only structuredContent from an opted-in tool can become application data. */
export function normalizeAppOutput(value: unknown, contract: AppOutputContract): AppOutputResult {
  try {
    if (!isObject(value)) return { status: "invalid" };
    if (hasCompletedAppOutputMarker(value) && isObject(value._meta)) {
      return {
        status: value._meta[APP_OUTPUT_STATUS_META_KEY] === "too_large" ? "too_large" : "invalid",
      };
    }
    if (value.isError === true || !isObject(value.structuredContent)) return { status: "invalid" };
    validateAppOutputContract(contract);
    const text = Array.isArray(value.content)
      ? value.content
          .filter(isObject)
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n")
          .slice(0, 4096)
      : "Tool execution completed.";
    const parsed = appOutputResultSchema.safeParse({
      status: "available",
      schemaId: contract.schemaId,
      schemaVersion: contract.schemaVersion,
      remoteReadable: contract.remoteReadable,
      data: value.structuredContent,
      fallbackText: text,
    });
    if (!parsed.success) return { status: "invalid" };
    if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > APP_OUTPUT_LIMITS.resultBytes) {
      return { status: "too_large" };
    }
    // A fresh validator prevents two different producers sharing $id from sharing a compiled schema.
    const validator = new AjvJsonSchemaValidator().getValidator(contract.outputSchema);
    if (!validator(value.structuredContent).valid) return { status: "invalid" };
    return parsed.data;
  } catch {
    // Validation happens after execution; it must never trigger another invocation.
    return { status: "invalid" };
  }
}
