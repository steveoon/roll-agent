import { resolve } from "node:path";
import type { RuntimeModule, ThreadStoreInstance } from "../../runtime-host/engine-factory.ts";
import type { RollConfig } from "../../config/schema.ts";
import { createSessionOwnershipHost } from "../../runtime-host/session-ownership.ts";

/** No writable factory, Agent bootstrap, migration or retention on history-only paths. */
export function withReadOnlyChatHistory<T>(
  runtime: RuntimeModule,
  config: RollConfig,
  read: (store: ThreadStoreInstance) => T,
): T | undefined {
  const dir = resolve(runtime.expandTilde(config.runtime.threadsDir));
  if (runtime.inspectThreadLibrary(dir).schemaVersion === null) return undefined;
  let ownershipProbe;
  try {
    ownershipProbe = createSessionOwnershipHost();
  } catch {
    ownershipProbe = { probe: () => "unknown" as const };
  }
  const store = new runtime.ThreadStore(dir, { readOnly: true, ownershipProbe });
  try {
    return read(store);
  } finally {
    store.close();
  }
}

export function readOnlyConversationText(store: ThreadStoreInstance, threadId: string): string {
  const snapshot = store.readSnapshot(threadId);
  const messages =
    snapshot.transcript.length > 0
      ? snapshot.transcript.map((entry) => entry.message)
      : snapshot.messages;
  const lines = [
    `会话 ${threadId} · 只读`,
    snapshot.thread.title ?? "（无标题）",
    `项目：${snapshot.thread.workspace ?? "未分类"}`,
  ];
  for (const message of messages) {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    if (text.length > 0) lines.push(`\n[${message.role}]\n${text}`);
  }
  return lines.join("\n");
}
