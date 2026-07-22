import type { SessionEvent } from "@roll-agent/runtime";

export function formatDebugEvent(event: Extract<SessionEvent, { type: "debug" }>): string {
  const parts = [`chat.${event.stage}`, event.message];
  if (event.elapsedMs !== undefined) {
    parts.push(`${String(event.elapsedMs)}ms`);
  }
  if (event.data !== undefined) {
    parts.push(JSON.stringify(event.data));
  }
  return parts.join(" · ");
}
