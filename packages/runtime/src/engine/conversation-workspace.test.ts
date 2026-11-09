import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { runtimeSettingsSchema } from "../host-contracts/runtime-settings.ts";
import { ThreadStore } from "../store/thread-store.ts";
import { ConversationEngine } from "./conversation-engine.ts";

test("host workspace stamps new conversations and forks without reclassifying resumed history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-engine-workspace-"));
  const store = new ThreadStore(dir);
  const engine = new ConversationEngine({
    settings: runtimeSettingsSchema.parse({ shell: { enabled: false } }),
    provider: "mock",
    modelName: "current-model",
    model: new MockLanguageModelV4(),
    workspace: "/destination-workspace",
    sources: [],
    store,
    skillLibrary: null,
    workspaceInstructions: null,
    fileToolsEnabled: false,
  });
  try {
    const source = store.createThread({ workspace: "/source-workspace" });
    store.appendMessages(source, [{ role: "user", content: "source context" }]);
    const legacy = store.createThread();
    const created = await engine.createSession();
    assert.equal(store.getThread(created.id)?.workspace, "/destination-workspace");
    const fork = await engine.forkSession(store.readSnapshot(source));
    assert.equal(store.getThread(fork.id)?.workspace, "/destination-workspace");
    assert.equal(store.getThread(fork.id)?.derivedFrom?.threadId, source);
    assert.deepEqual(store.getMessages(fork.id), store.getMessages(source));
    await engine.resumeSession(source);
    await engine.resumeSession(legacy);
    assert.equal(store.getThread(source)?.workspace, "/source-workspace");
    assert.equal(store.getThread(legacy)?.workspace, undefined);
  } finally {
    await engine.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
