import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createChatGptAuthService, ChatGptAuthError } from "./service.ts";
import { ChatGptCredentialStore } from "./storage.ts";

const issuer = "https://auth.test";
const keys = await generateKeyPair("RS256");
const wrongKeys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" };

async function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "roll-chatgpt-auth-"));
  const store = new ChatGptCredentialStore(directory);
  const authorizationUrls: URL[] = [];
  const requests: URLSearchParams[] = [];
  let now = Date.now();
  let identityMode = "valid";
  let tokenError: string | undefined;
  let revokeStatus = 200;
  let refreshCalls = 0;
  let tokenCount = 0;
  let jwksUnavailable = false;
  let exchangeDelayMs = 0;
  let includeRefreshIdentity = false;
  let malformedTokenResponse = false;
  let grantedScope =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
  let earliestRefreshAt: number | undefined;
  const fakeFetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/openid-configuration")) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
      });
    }
    if (url.endsWith("/jwks")) {
      if (jwksUnavailable) throw new TypeError("fixture-jwks-outage");
      return Response.json({ keys: [jwk] });
    }
    if (url.endsWith("/models")) {
      assert.ok(
        new Headers(init?.headers).get("Authorization")?.startsWith("Bearer fixture-access-"),
      );
      return Response.json({
        models: [
          {
            slug: "model-b",
            display_name: "Model B",
            visibility: "list",
            context_window: 128000,
            supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "max" }],
          },
          { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
          { slug: "model-a", display_name: "Model A", visibility: "list" },
        ],
      });
    }
    if (url.endsWith("/revoke")) {
      assert.ok(init?.body instanceof URLSearchParams);
      requests.push(new URLSearchParams(init.body));
      return new Response(null, { status: revokeStatus });
    }
    if (url.endsWith("/token")) {
      assert.ok(init?.body instanceof URLSearchParams);
      const params = new URLSearchParams(init.body);
      requests.push(params);
      if (exchangeDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, exchangeDelayMs));
      }
      if (tokenError === "network") throw new TypeError("secret-bearing fake failure");
      if (tokenError !== undefined) {
        return Response.json(
          { error: tokenError, error_description: "do not expose credentials" },
          { status: 400 },
        );
      }
      const clientId = params.get("client_id");
      assert.ok(clientId);
      const isRefresh = params.get("grant_type") === "refresh_token";
      if (malformedTokenResponse) return Response.json({ incomplete: true });
      if (isRefresh) {
        refreshCalls += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      } else {
        assert.ok(
          store.list().some((profile) => profile.clientId === clientId),
          "issued client ID persisted before exchange",
        );
        const authorization = authorizationUrls.at(-1);
        assert.ok(authorization);
        assert.equal(params.get("redirect_uri"), authorization.searchParams.get("redirect_uri"));
        assert.equal(params.get("resource"), "https://api.openai.com/v1");
        assert.ok(params.get("code_verifier"));
      }
      tokenCount += 1;
      const authorization = authorizationUrls.at(-1);
      const payload = {
        nonce: identityMode === "nonce" ? "wrong" : authorization?.searchParams.get("nonce"),
        email: "same@example.test",
      };
      const idToken = await new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .setIssuer(identityMode === "issuer" ? "https://wrong.test" : issuer)
        .setAudience(identityMode === "audience" ? "wrong-client" : clientId)
        .setSubject(identityMode === "subject" ? "different-subject" : "fixture-subject")
        .setExpirationTime(Math.floor(now / 1000) + (identityMode === "expiry" ? -100 : 3600))
        .sign(identityMode === "signature" ? wrongKeys.privateKey : keys.privateKey);
      return Response.json({
        access_token: `fixture-access-${tokenCount}`,
        refresh_token: `fixture-refresh-${tokenCount}`,
        ...(!isRefresh || includeRefreshIdentity ? { id_token: idToken } : {}),
        token_type: "Bearer",
        expires_in: 3600,
        scope: grantedScope,
        ...(earliestRefreshAt === undefined ? {} : { earliest_refresh_at: earliestRefreshAt }),
      });
    }
    throw new Error("Unexpected fixture URL");
  };
  const service = createChatGptAuthService({
    store,
    fetch: fakeFetch,
    issuer,
    now: () => now,
    openBrowser: async (url) => {
      authorizationUrls.push(new URL(url));
    },
    loginTimeoutMs: 2000,
  });
  const login = async (accountId?: string, clientId = "oaiapp_fixture") => {
    const attempt = await service.beginLogin(accountId);
    const authorization = authorizationUrls.at(-1);
    assert.ok(authorization);
    const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
    callback.searchParams.set("code", "fixture-code");
    callback.searchParams.set("client_id", clientId);
    const response = await globalThis.fetch(callback);
    await response.text();
    for (let count = 0; count < 100; count += 1) {
      const progress = service.loginStatus(attempt.id);
      if (progress.state !== "waiting" && progress.state !== "exchanging") return progress;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Login fixture did not finish");
  };
  return {
    directory,
    store,
    service,
    authorizationUrls,
    requests,
    fakeFetch,
    login,
    setIdentityMode: (mode: string) => {
      identityMode = mode;
    },
    setTokenError: (code: string | undefined) => {
      tokenError = code;
    },
    setScope: (scope: string) => {
      grantedScope = scope;
    },
    setRevokeStatus: (status: number) => {
      revokeStatus = status;
    },
    setEarliest: (time: number | undefined) => {
      earliestRefreshAt = time;
    },
    setNow: (time: number) => {
      now = time;
    },
    setJwksUnavailable: (unavailable: boolean) => {
      jwksUnavailable = unavailable;
    },
    setExchangeDelay: (delay: number) => {
      exchangeDelayMs = delay;
    },
    setIncludeRefreshIdentity: () => {
      includeRefreshIdentity = true;
    },
    setMalformedResponse: () => {
      malformedTokenResponse = true;
    },
    refreshCalls: () => refreshCalls,
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("dynamic registration, PKCE, signature validation, protected storage and sanitized models", async () => {
  const f = await fixture();
  try {
    const progress = await f.login();
    assert.equal(progress.state, "succeeded");
    assert.ok(progress.accountId);
    const first = f.authorizationUrls[0];
    assert.ok(first);
    assert.equal(first.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(first.searchParams.get("agent_name_hint"), "Roll");
    assert.equal(first.searchParams.get("code_challenge_method"), "S256");
    assert.match(first.searchParams.get("code_challenge") ?? "", /^[a-zA-Z0-9_-]{43}$/);
    const profile = f.store.read(progress.accountId);
    assert.ok(profile);
    assert.equal(profile.subject, "fixture-subject");
    assert.equal(profile.clientId, "oaiapp_fixture");
    assert.equal(await f.service.getAccessToken(), "fixture-access-1");
    assert.deepEqual(await f.service.models(), [
      {
        slug: "model-b",
        displayName: "Model B",
        contextWindow: 128000,
        reasoningEfforts: ["low", "max"],
      },
      { slug: "model-a", displayName: "Model A" },
    ]);
    const status = await f.service.status();
    assert.equal(status.accounts[0]?.authorized, true);
    assert.ok(!JSON.stringify(status).includes("fixture-access"));
    assert.ok(!JSON.stringify(status).includes("idToken"));
    if (process.platform !== "win32") {
      assert.equal(statSync(f.directory).mode & 0o777, 0o700);
      assert.equal(statSync(resolve(f.directory, "host.json")).mode & 0o777, 0o600);
      assert.equal(
        statSync(resolve(f.directory, "profiles", `${progress.accountId}.json`)).mode & 0o777,
        0o600,
      );
    }
    assert.equal(
      readdirSync(resolve(f.directory, "profiles")).filter((name) => name.endsWith(".tmp")).length,
      0,
    );
  } finally {
    f.cleanup();
  }
});

test("registrations with identical email remain isolated and reuse stable host and issued client", async () => {
  const f = await fixture();
  try {
    const first = await f.login(undefined, "oaiapp_first");
    const second = await f.login(undefined, "oaiapp_second");
    assert.ok(first.accountId);
    assert.ok(second.accountId);
    assert.notEqual(first.accountId, second.accountId);
    assert.equal((await f.service.status()).accounts.length, 2);
    assert.equal(
      f.authorizationUrls[0]?.searchParams.get("ext_agent_host_id"),
      f.authorizationUrls[1]?.searchParams.get("ext_agent_host_id"),
    );
    await f.login(first.accountId, "oaiapp_first");
    const returning = f.authorizationUrls.at(-1);
    assert.ok(returning);
    assert.equal(returning.searchParams.get("client_id"), "oaiapp_first");
    assert.equal(returning.searchParams.has("agent_name_hint"), false);
    assert.ok(returning.searchParams.get("id_token_hint"));
    assert.equal((await f.service.status()).currentAccountId, first.accountId);
    assert.equal(f.store.read(second.accountId)?.credentials?.accessToken, "fixture-access-2");
  } finally {
    f.cleanup();
  }
});

for (const mode of ["signature", "issuer", "audience", "expiry", "nonce"] as const) {
  test(`reject invalid ID token ${mode} without replacing current account`, async () => {
    const f = await fixture();
    try {
      const valid = await f.login(undefined, "oaiapp_valid");
      f.setIdentityMode(mode);
      const invalid = await f.login(undefined, "oaiapp_invalid");
      assert.equal(invalid.state, "failed");
      assert.match(invalid.message ?? "", /校验失败/);
      assert.equal((await f.service.status()).currentAccountId, valid.accountId);
      assert.equal(await f.service.getAccessToken(), "fixture-access-1");
    } finally {
      f.cleanup();
    }
  });
}

test("reject a returning different subject or client ID and retain current credentials", async () => {
  const f = await fixture();
  try {
    const valid = await f.login();
    assert.ok(valid.accountId);
    const wrongClient = await f.login(valid.accountId, "oaiapp_wrong");
    assert.equal(wrongClient.state, "failed");
    f.setIdentityMode("subject");
    const wrongSubject = await f.login(valid.accountId);
    assert.equal(wrongSubject.state, "failed");
    assert.equal(await f.service.getAccessToken(), "fixture-access-1");
  } finally {
    f.cleanup();
  }
});

test("callback validates state, then cancellation and consent denial preserve active account", async () => {
  const f = await fixture();
  try {
    const valid = await f.login();
    const attempt = await f.service.beginLogin();
    const authorization = f.authorizationUrls.at(-1);
    assert.ok(authorization);
    const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set("state", "wrong");
    callback.searchParams.set("error", "access_denied");
    assert.equal((await globalThis.fetch(callback)).status, 400);
    assert.equal(f.service.loginStatus(attempt.id).state, "waiting");
    assert.equal(f.service.cancelLogin(attempt.id).state, "cancelled");
    const declined = await f.service.beginLogin();
    const declineAuthorization = f.authorizationUrls.at(-1);
    assert.ok(declineAuthorization);
    const declineCallback = new URL(declineAuthorization.searchParams.get("redirect_uri") ?? "");
    declineCallback.searchParams.set("state", declineAuthorization.searchParams.get("state") ?? "");
    declineCallback.searchParams.set("error", "access_denied");
    await globalThis.fetch(declineCallback);
    assert.equal(f.service.loginStatus(declined.id).state, "denied");
    assert.equal((await f.service.status()).currentAccountId, valid.accountId);
  } finally {
    f.cleanup();
  }
});

test("malformed and foreign-origin callback request targets return 400 without interrupting login", async () => {
  const f = await fixture();
  let attemptId: string | undefined;
  try {
    const active = await f.login();
    const attempt = await f.service.beginLogin();
    attemptId = attempt.id;
    const authorization = f.authorizationUrls.at(-1);
    assert.ok(authorization);
    const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
    const state = authorization.searchParams.get("state");
    assert.ok(state);
    for (const target of [
      "http://[",
      `http://foreign.test/auth/callback?state=${state}&error=access_denied`,
      `https://${callback.host}/auth/callback?state=${state}&error=access_denied`,
    ]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(
          { hostname: callback.hostname, port: callback.port, path: target, method: "GET" },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          },
        );
        request.on("error", reject);
        request.end();
      });
      assert.equal(status, 400);
      assert.equal(f.service.loginStatus(attempt.id).state, "waiting");
      assert.equal((await f.service.status()).currentAccountId, active.accountId);
      assert.equal(await f.service.getAccessToken(), "fixture-access-1");
    }
  } finally {
    if (attemptId !== undefined) f.service.cancelLogin(attemptId);
    f.cleanup();
  }
});

test("OAuth identity without direct grant is retained but cannot infer", async () => {
  const f = await fixture();
  try {
    f.setScope("openid email offline_access");
    assert.equal((await f.login()).state, "succeeded");
    assert.equal((await f.service.status()).accounts[0]?.authorized, false);
    await assert.rejects(
      f.service.models(),
      (error: unknown) =>
        error instanceof ChatGptAuthError && error.code === "scope_not_authorized",
    );
  } finally {
    f.cleanup();
  }
});

test("failed code exchange retains its issued registration without activating it", async () => {
  const f = await fixture();
  try {
    const active = await f.login();
    f.setTokenError("invalid_grant");
    const failed = await f.login(undefined, "oaiapp_saved_before_failure");
    assert.equal(failed.state, "failed");
    assert.ok(
      f.store
        .list()
        .some(
          (profile) =>
            profile.clientId === "oaiapp_saved_before_failure" && profile.credentials === undefined,
        ),
    );
    assert.equal((await f.service.status()).currentAccountId, active.accountId);
  } finally {
    f.cleanup();
  }
});

test("cancel during code exchange cannot activate returned credentials; timeout also preserves active profile", async () => {
  const f = await fixture();
  try {
    const active = await f.login();
    f.setExchangeDelay(100);
    const attempt = await f.service.beginLogin();
    const authorization = f.authorizationUrls.at(-1);
    assert.ok(authorization);
    const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
    callback.searchParams.set("code", "fixture-delayed-code");
    callback.searchParams.set("client_id", "oaiapp_cancelled");
    await globalThis.fetch(callback);
    assert.equal(f.service.loginStatus(attempt.id).state, "exchanging");
    f.service.cancelLogin(attempt.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    assert.equal(f.service.loginStatus(attempt.id).state, "cancelled");
    assert.equal((await f.service.status()).currentAccountId, active.accountId);
    assert.equal(
      f.store.list().find((profile) => profile.clientId === "oaiapp_cancelled")?.credentials,
      undefined,
    );
    const timeoutService = createChatGptAuthService({
      directory: f.directory,
      issuer,
      fetch: f.fakeFetch,
      openBrowser: async () => {},
      loginTimeoutMs: 10,
    });
    const timed = await timeoutService.beginLogin();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(timeoutService.loginStatus(timed.id).state, "timed-out");
    assert.equal((await f.service.status()).currentAccountId, active.accountId);
  } finally {
    f.cleanup();
  }
});

test("JWKS network failure happens before rotation and refreshed grant removal blocks inference", async () => {
  const f = await fixture();
  try {
    await f.login();
    f.setJwksUnavailable(true);
    await assert.rejects(
      f.service.refresh(),
      (error: unknown) => error instanceof ChatGptAuthError && error.code === "jwks_unavailable",
    );
    assert.equal(f.refreshCalls(), 0);
    assert.equal(await f.service.getAccessToken(), "fixture-access-1");
    f.setJwksUnavailable(false);
    f.setScope("openid profile email offline_access");
    f.setNow(Date.now() + 3_550_000);
    await assert.rejects(
      f.service.getAccessToken(),
      (error: unknown) =>
        error instanceof ChatGptAuthError && error.code === "scope_not_authorized",
    );
    assert.equal(f.refreshCalls(), 1);
    assert.equal((await f.service.status()).accounts[0]?.authorized, false);
  } finally {
    f.cleanup();
  }
});

test("refresh obeys server earliest time and concurrent service instances reread rotating credentials", async () => {
  const f = await fixture();
  try {
    const earliest = Math.floor(Date.now() / 1000) + 120;
    f.setEarliest(earliest);
    await f.login();
    await assert.rejects(
      f.service.refresh(),
      (error: unknown) => error instanceof ChatGptAuthError && error.code === "refresh_too_early",
    );
    assert.equal(f.refreshCalls(), 0);
    f.setNow(earliest * 1000 + 1);
    const second = createChatGptAuthService({
      directory: f.directory,
      issuer,
      fetch: f.fakeFetch,
      now: () => earliest * 1000 + 1,
    });
    const results = await Promise.all([f.service.refresh(), second.refresh()]);
    assert.equal(results.filter((result) => result.refreshed).length, 1);
    assert.equal(f.refreshCalls(), 1);
    assert.equal(await second.getAccessToken(), "fixture-access-2");
    const refreshRequest = f.requests.find(
      (request) => request.get("grant_type") === "refresh_token",
    );
    assert.equal(refreshRequest?.get("client_id"), "oaiapp_fixture");
    assert.equal(refreshRequest?.get("scope"), null);
    assert.equal(refreshRequest?.get("refresh_token"), "fixture-refresh-1");
  } finally {
    f.cleanup();
  }
});

test("temporary refresh preserves credentials; terminal rotation failure clears tokens but retains mapping", async () => {
  const f = await fixture();
  try {
    const valid = await f.login();
    assert.ok(valid.accountId);
    f.setTokenError("network");
    await assert.rejects(f.service.refresh(), /现有凭证已保留/);
    assert.equal(await f.service.getAccessToken(), "fixture-access-1");
    f.setTokenError("invalid_client");
    await assert.rejects(
      f.service.refresh(),
      (error: unknown) => error instanceof ChatGptAuthError && error.code === "invalid_client",
    );
    assert.ok(f.store.read(valid.accountId)?.credentials);
    f.setTokenError("refresh_token_reused");
    await assert.rejects(f.service.refresh(), /重新登录/);
    const profile = f.store.read(valid.accountId);
    assert.ok(profile);
    assert.equal(profile.credentials, undefined);
    assert.equal(profile.clientId, "oaiapp_fixture");
    assert.equal(profile.subject, "fixture-subject");
  } finally {
    f.cleanup();
  }
});

test("pre-expiry temporary renewal failure uses the latest valid token but never an expired or revoked token", async () => {
  for (const failure of ["network", "jwks", "terminal"] as const) {
    const f = await fixture();
    try {
      const login = await f.login();
      assert.ok(login.accountId);
      const expiresAt = f.store.read(login.accountId)?.credentials?.expiresAt;
      assert.ok(expiresAt);
      f.setNow(expiresAt - 30_000);
      if (failure === "jwks") f.setJwksUnavailable(true);
      else f.setTokenError(failure === "terminal" ? "refresh_token_reused" : "network");
      if (failure === "terminal") {
        await assert.rejects(f.service.getAccessToken(), /重新登录/);
        assert.equal(f.store.read(login.accountId)?.credentials, undefined);
      } else {
        assert.equal(await f.service.getAccessToken(), "fixture-access-1");
        f.setNow(expiresAt + 1);
        await assert.rejects(f.service.getAccessToken());
      }
    } finally {
      f.cleanup();
    }
  }
});

test("revocation is discovered, clears all local tokens and preserves registration for reauthorization", async () => {
  const f = await fixture();
  try {
    const valid = await f.login();
    assert.ok(valid.accountId);
    assert.equal((await f.service.logout()).revocationConfirmed, true);
    const request = f.requests.at(-1);
    assert.equal(request?.get("token_type_hint"), "refresh_token");
    assert.equal(request?.get("client_id"), "oaiapp_fixture");
    assert.equal(request?.get("token"), "fixture-refresh-1");
    const raw = readFileSync(resolve(f.directory, "profiles", `${valid.accountId}.json`), "utf8");
    assert.ok(!raw.includes("fixture-access"));
    assert.ok(!raw.includes("fixture-refresh"));
    assert.ok(!raw.includes("idToken"));
    await f.login(valid.accountId);
    assert.equal(f.authorizationUrls.at(-1)?.searchParams.has("id_token_hint"), false);
    f.setRevokeStatus(503);
    assert.equal((await f.service.logout()).revocationConfirmed, false);
    assert.equal(f.store.read(valid.accountId)?.credentials, undefined);
  } finally {
    f.cleanup();
  }
});

for (const failure of ["identity", "malformed-response", "refresh-time"] as const) {
  test(`accepted refresh with invalid ${failure} clears consumed credentials and requires reauthorization`, async () => {
    const f = await fixture();
    try {
      const active = await f.login();
      assert.ok(active.accountId);
      if (failure === "identity") {
        f.setIncludeRefreshIdentity();
        f.setIdentityMode("signature");
      }
      if (failure === "malformed-response") f.setMalformedResponse();
      if (failure === "refresh-time") f.setEarliest(Date.now()); // Milliseconds cannot be mistaken for epoch seconds.
      await assert.rejects(f.service.refresh(), /重新登录/);
      const registration = f.store.read(active.accountId);
      assert.ok(registration);
      assert.equal(registration.credentials, undefined);
      assert.equal(registration.clientId, "oaiapp_fixture");
      assert.equal(registration.subject, "fixture-subject");
      await assert.rejects(f.service.getAccessToken(), /重新登录/);
    } finally {
      f.cleanup();
    }
  });
}

test("independent OS processes serialize rotating refresh and only one consumes old token", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "roll-chatgpt-process-"));
  const store = new ChatGptCredentialStore(directory);
  const accountId = randomUUID();
  const hostId = await store.hostId();
  store.save({
    id: accountId,
    clientId: "oaiapp_process",
    hostId,
    subject: "fixture-subject",
    credentials: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      idToken: "retained-id",
      scopes: ["chatgpt.tokens.use.direct"],
      expiresAt: Date.now() + 3600000,
      savedAt: Date.now(),
    },
  });
  await store.setCurrent(accountId);
  let exchanges = 0;
  const server = createServer((_request, response) => {
    exchanges += 1;
    setTimeout(() => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
    }, 300);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const moduleUrl = new URL("./service.ts", import.meta.url).href;
  const worker = `
    import { createChatGptAuthService } from ${JSON.stringify(moduleUrl)};
    const fetcher = async (input, init) => String(input).includes('openid-configuration')
      ? Response.json({issuer: 'https://auth.test', authorization_endpoint: 'https://auth.test/authorize', token_endpoint: 'https://auth.test/token', jwks_uri: 'https://auth.test/jwks'})
      : String(input).endsWith('/jwks') ? Response.json(${JSON.stringify({ keys: [jwk] })})
      : fetch(${JSON.stringify(endpoint)}, init);
    const service = createChatGptAuthService({directory: ${JSON.stringify(directory)}, issuer: 'https://auth.test', fetch: fetcher});
    const result = await service.refresh();
    console.log(JSON.stringify(result));
  `;
  const runWorker = () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", worker],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      let errors = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(output);
        else reject(new Error(errors));
      });
    });
  try {
    const outputs = await Promise.all([runWorker(), runWorker()]);
    assert.equal(exchanges, 1);
    assert.equal(outputs.filter((output) => output.includes('"refreshed":true')).length, 1);
    assert.equal(store.read(accountId)?.credentials?.refreshToken, "new-refresh");
  } finally {
    server.close();
    server.closeAllConnections();
    rmSync(directory, { recursive: true, force: true });
  }
});
