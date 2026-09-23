export const ROLL_EXECUTION_TIMEOUT_META_KEY = "roll/executionTimeoutMs";

export function readExecutionTimeoutMs(metadata: unknown): number | undefined {
  const value =
    typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
      ? Reflect.get(metadata, ROLL_EXECUTION_TIMEOUT_META_KEY)
      : undefined;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1000 &&
    value <= 1_800_000
    ? value
    : undefined;
}
