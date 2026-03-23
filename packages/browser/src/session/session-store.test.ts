import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { SessionStore } from "./session-store.ts";

test("SessionStore persists cookies and localStorage snapshots", async () => {
  const sessionsDir = mkdtempSync(resolve(tmpdir(), "roll-browser-session-"));

  try {
    const store = new SessionStore(sessionsDir);
    const cookies = [{ name: "sid", value: "abc", domain: ".example.com", path: "/" }];
    const localStorage = { token: "secret", lastPlatform: "zhipin" };

    await store.saveCookies("zhipin", cookies);
    await store.saveLocalStorage("zhipin", localStorage);

    assert.deepEqual(await store.loadCookies("zhipin"), cookies);
    assert.deepEqual(await store.loadLocalStorage("zhipin"), localStorage);
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});
