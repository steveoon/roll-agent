import { redactToolArgsForLog } from "./output.ts";

export function formatToolInput(input: unknown): string {
  const json = JSON.stringify(redactToolArgsForLog(input)) ?? "";
  return json.length > 80 ? `${json.slice(0, 79)}…` : json;
}
