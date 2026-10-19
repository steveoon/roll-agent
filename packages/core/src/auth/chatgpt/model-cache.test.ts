import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatGptCredentialStore } from "./storage.ts";
import { createChatGptAuthService } from "./service.ts";
import { writeChatGptModelCache } from "./model-cache.ts";

test("cached models follow the current or explicit account without networking and expire to unknown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "roll-model-cache-"));
  try {
    const store = new ChatGptCredentialStore(directory);
    const hostId = await store.hostId();
    let now = 1_000;
    const service = createChatGptAuthService({
      store,
      now: () => now,
      fetch: async () => {
        throw new Error("unexpected network");
      },
    });
    assert.deepEqual(service.cachedModels(), []);
    const [first, second] = [randomUUID(), randomUUID()];
    assert.ok(first && second);
    for (const id of [first, second]) {
      store.save({ id, clientId: "fixture", hostId });
      const profile = store.read(id);
      assert.ok(profile);
      writeChatGptModelCache(
        directory,
        profile,
        [{ slug: id, displayName: id, reasoningEfforts: ["max"] }],
        now,
      );
    }
    await store.setCurrent(first);
    assert.equal(service.cachedModels()[0]?.slug, first);
    assert.equal(service.cachedModels(second)[0]?.slug, second);
    await store.setCurrent(second);
    assert.equal(service.cachedModels()[0]?.slug, second);
    now += 8 * 24 * 60 * 60_000;
    assert.deepEqual(service.cachedModels(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
