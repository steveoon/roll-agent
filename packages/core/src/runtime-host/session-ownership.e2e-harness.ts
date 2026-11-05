// Separate-process test harness. It uses the exact public Core store factory used by roll chat.
import * as runtime from "@roll-agent/runtime";
import { MockLanguageModelV4 } from "ai/test";
import { createOwnedThreadStore } from "./session-ownership.ts";
const dir = process.argv[2];
const id = process.argv[3];
const kind = process.argv[4] ?? "cli";
if (dir === undefined || id === undefined) throw new Error("Missing isolated fixture args");
const store = createOwnedThreadStore(runtime, dir, kind);
const engine = new runtime.ConversationEngine({
  store,
  model: new MockLanguageModelV4({}),
  provider: "mock",
  modelName: "no-model-calls",
  settings: runtime.runtimeSettingsSchema.parse({}),
  sources: [],
  skillLibrary: null,
  workspaceInstructions: null,
  sessionExecEnabled: false,
  fileToolsEnabled: false,
});
process.send?.({ event: "ready" });
process.on("message", (command: unknown) => {
  (async () => {
    if (command === "open") {
      try {
        const session = await engine.resumeSession(id);
        const messageCount = session.getMessages().length;
        store.appendMessages(id, [{ role: "user", content: `${kind} persisted` }]);
        store.updateTitle(id, `${kind} idle`);
        process.send?.({
          event: "opened",
          title: store.getThread(session.id)?.title,
          messageCount,
        });
      } catch (error) {
        process.send?.({
          event: "conflict",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (command === "close") {
      await engine.dispose();
      store.close();
      process.exit(0);
    } else if (command === "crash") process.exit(0);
  })().catch((error) => {
    process.stderr.write(String(error));
    process.exit(1);
  });
});
