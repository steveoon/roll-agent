import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChatGptConnection } from "../../runtime-host/chatgpt-connection.ts";
import { ChatGptAuthService, ChatGptAuthError } from "./service.ts";
import { ChatGptCredentialStore } from "./storage.ts";
import { readChatGptModelCache, writeChatGptModelCache } from "./model-cache.ts";

const id = "00000000-0000-4000-8000-000000000001";
const scope = "chatgpt.tokens.use.direct";
const profile = {
  id,
  clientId: "fixture-client",
  hostId: "fixture-host",
  subject: "fixture-subject",
  credentials: {
    accessToken: "old",
    refreshToken: "rotating",
    idToken: "unused",
    expiresAt: 10,
    savedAt: 0,
    scopes: [scope],
  },
};

test("cancel after rotating POST dispatch still saves its replacement, without retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "roll-refresh-cancel-"));
  const store = new ChatGptCredentialStore(directory);
  store.save(profile);
  const abort = new AbortController();
  let posts = 0;
  const service = new ChatGptAuthService({
    store,
    now: () => 100,
    fetch: async (url, init) => {
      if (String(url).endsWith("openid-configuration")) {
        return Response.json({
          issuer: "https://auth.openai.com",
          authorization_endpoint: "https://auth.openai.com/authorize",
          token_endpoint: "https://auth.openai.com/token",
          jwks_uri: "https://auth.openai.com/jwks",
        });
      }
      if (String(url).endsWith("/jwks")) return Response.json({ keys: [] });
      posts++;
      abort.abort();
      assert.equal(init?.signal?.aborted, false);
      return new Response(
        new ReadableStream({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    access_token: "new",
                    refresh_token: "replacement",
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope,
                  }),
                ),
              );
              controller.close();
            }, 20);
          },
        }),
      );
    },
  });
  try {
    await service.getAccessToken(id, abort.signal);
    assert.equal(posts, 1);
    assert.equal(store.read(id)?.credentials?.refreshToken, "replacement");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("locked refresh observes connection deadline and dispose, never dispatching after cancellation", async () => {
  for (const stop of ["deadline", "dispose"] as const) {
    const directory = mkdtempSync(join(tmpdir(), "roll-refresh-lock-"));
    const store = new ChatGptCredentialStore(directory);
    store.save(profile);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = store.withLock(id, () => gate);
    let requests = 0;
    const service = new ChatGptAuthService({
      store,
      now: () => 100,
      fetch: async () => {
        requests++;
        throw new Error("must not dispatch");
      },
    });
    const connection = new ChatGptConnection(service, id, [], stop === "deadline" ? 25 : 1000);
    try {
      const pending = assert.rejects(connection.ensure(), {
        name: stop === "deadline" ? "TimeoutError" : "AbortError",
      });
      if (stop === "dispose") {
        await delay(10);
        connection.dispose();
      }
      await pending;
      release();
      await holder;
      await delay(40);
      assert.equal(requests, 0);
      assert.deepEqual(store.read(id), profile);
    } finally {
      release();
      await holder;
      connection.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("expired token survives offline discovery, then renews automatically exactly once on recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "roll-auth-recovery-"));
  const store = new ChatGptCredentialStore(directory);
  store.save(profile);
  let offline = true;
  let discovery = 0;
  let posts = 0;
  const service = new ChatGptAuthService({
    store,
    now: () => 100,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("openid-configuration")) {
        discovery++;
        if (offline) {
          throw new TypeError("private-network-detail", { cause: { code: "ECONNRESET" } });
        }
        return Response.json({
          issuer: "https://auth.openai.com",
          authorization_endpoint: "https://auth.openai.com/authorize",
          token_endpoint: "https://auth.openai.com/token",
          jwks_uri: "https://auth.openai.com/jwks",
        });
      }
      if (url.endsWith("/jwks")) return Response.json({ keys: [] });
      assert.equal(init?.method, "POST");
      posts++;
      return Response.json({
        access_token: "new",
        refresh_token: "rotated",
        token_type: "Bearer",
        expires_in: 3600,
        scope,
      });
    },
  });
  try {
    await assert.rejects(service.getAccessToken(id), (error: unknown) => {
      assert.ok(error instanceof ChatGptAuthError);
      assert.equal(error.code, "network_error");
      assert.doesNotMatch(error.message, /private-network-detail/);
      return true;
    });
    assert.equal(discovery, 3);
    assert.equal(posts, 0);
    assert.deepEqual(store.read(id), profile);
    offline = false;
    assert.equal(await service.getAccessToken(id), "new");
    assert.equal(await service.getAccessToken(id), "new");
    assert.equal(posts, 1);
    assert.equal(store.read(id)?.credentials?.refreshToken, "rotated");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed rotating token POST is never retried by read recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "roll-auth-no-post-retry-"));
  const store = new ChatGptCredentialStore(directory);
  store.save(profile);
  let posts = 0;
  const service = new ChatGptAuthService({
    store,
    now: () => 100,
    fetch: async (input, init) => {
      if (String(input).endsWith("openid-configuration")) {
        return Response.json({
          issuer: "https://auth.openai.com",
          authorization_endpoint: "https://auth.openai.com/authorize",
          token_endpoint: "https://auth.openai.com/token",
          jwks_uri: "https://auth.openai.com/jwks",
        });
      }
      if (String(input).endsWith("/jwks")) return Response.json({ keys: [] });
      assert.equal(init?.method, "POST");
      posts++;
      throw new TypeError("response lost");
    },
  });
  try {
    await assert.rejects(service.getAccessToken(id), /现有凭证已保留/);
    assert.equal(posts, 1);
    assert.deepEqual(store.read(id), profile);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("model display cache is account/registration bound and expires without modifying credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "roll-auth-cache-"));
  const models = [{ slug: "model", displayName: "Model", reasoningEfforts: ["max"] }];
  try {
    writeChatGptModelCache(directory, profile, models, 100);
    assert.deepEqual(readChatGptModelCache(directory, profile, 101), models);
    assert.deepEqual(readChatGptModelCache(directory, { ...profile, subject: "another" }, 101), []);
    assert.deepEqual(
      readChatGptModelCache(directory, { ...profile, clientId: "another" }, 101),
      [],
    );
    assert.deepEqual(readChatGptModelCache(directory, profile, 8 * 86400000), []);
    assert.deepEqual(readChatGptModelCache(directory, profile, 99), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
