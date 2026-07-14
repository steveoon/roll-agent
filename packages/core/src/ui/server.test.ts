import assert from "node:assert/strict";
import { request as requestHttp } from "node:http";
import { describe, it } from "node:test";
import { ConfigApplicationValidationError } from "../config/application-service.ts";
import {
  ConfigRevisionConflictError,
  ConfigWriteLockError,
  createConfigRevision,
} from "../config/document-store.ts";
import type { RollUiController, RollUiStaticAssetProvider } from "./contracts.ts";
import {
  ROLL_UI_HOST,
  ROLL_UI_SESSION_COOKIE,
  startRollUiServer,
  type RollUiServerHandle,
} from "./server.ts";
import { RollUiActivationInProgressError } from "./runtime-controller.ts";

const STATIC_ASSETS: RollUiStaticAssetProvider = {
  getAsset: (pathname) =>
    pathname === "/index.html"
      ? { body: "<!doctype html><title>Roll UI</title>", contentType: "text/html; charset=utf-8" }
      : null,
};

describe("startRollUiServer", () => {
  it("binds only to an ephemeral IPv4 loopback port and serves hardened static assets", async (t) => {
    const server = await startRollUiServer({
      controller: createController(),
      staticAssets: STATIC_ASSETS,
    });
    t.after(() => server.close());

    const launchUrl = new URL(server.url);
    assert.equal(server.host, ROLL_UI_HOST);
    assert.equal(launchUrl.hostname, ROLL_UI_HOST);
    assert.equal(launchUrl.port, String(server.port));
    assert.equal(launchUrl.pathname, `${server.basePath}/`);
    assert.match(server.basePath, /^\/__roll_ui\/[A-Za-z0-9_-]{32}$/u);
    assert.match(launchUrl.hash, /^#token=[A-Za-z0-9_-]{43}$/u);
    assert.ok(server.port > 0);

    const response = await fetch(appUrl(server, "/"));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<!doctype html><title>Roll UI</title>");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
    assert.equal(response.headers.get("access-control-allow-origin"), null);

    const spoofedHost = await rawRequest(server, "/", { Host: "localhost" });
    assert.equal(spoofedHost.statusCode, 421);
    assert.match(spoofedHost.body, /invalid_host/u);
  });

  it("exchanges the URL-fragment token once for an HttpOnly strict session", async (t) => {
    const server = await startRollUiServer({
      controller: createController(),
      staticAssets: STATIC_ASSETS,
    });
    t.after(() => server.close());
    const token = readLaunchToken(server);

    const missingOrigin = await fetch(appUrl(server, "/api/bootstrap"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(missingOrigin.status, 403);

    const bootstrap = await bootstrapSession(server, token);
    assert.match(bootstrap.cookie, new RegExp(`^${ROLL_UI_SESSION_COOKIE}_[A-Za-z0-9_-]+=`));
    assert.ok(bootstrap.setCookie.includes(`; Path=${server.basePath}/;`));
    assert.match(bootstrap.setCookie, /; HttpOnly/u);
    assert.match(bootstrap.setCookie, /; SameSite=Strict/u);
    assert.doesNotMatch(JSON.stringify(bootstrap.payload), new RegExp(token, "u"));
    assert.equal(bootstrap.response.headers.get("access-control-allow-origin"), null);

    const repeated = await fetch(appUrl(server, "/api/bootstrap"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.origin,
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(repeated.status, 401);

    const restored = await apiFetch(server, "/api/bootstrap", bootstrap.cookie);
    assert.equal(restored.status, 200);
    const restoredPayload = await readData(restored);
    assert.equal(restoredPayload.csrfToken, bootstrap.csrfToken);

    const config = await apiFetch(server, "/api/config", bootstrap.cookie);
    assert.equal(config.status, 200);
    assert.deepEqual(await readData(config), { config: true });

    const unauthenticated = await fetch(appUrl(server, "/api/config"));
    assert.equal(unauthenticated.status, 401);
    const wrongOrigin = await apiFetch(server, "/api/config", bootstrap.cookie, {
      origin: "https://attacker.example",
    });
    assert.equal(wrongOrigin.status, 403);
    const crossSite = await apiFetch(server, "/api/config", bootstrap.cookie, {
      "sec-fetch-site": "cross-site",
    });
    assert.equal(crossSite.status, 403);
  });

  it("isolates concurrent localhost sessions with a high-entropy cookie path", async (t) => {
    const first = await startRollUiServer({
      controller: createController(),
      staticAssets: STATIC_ASSETS,
    });
    const second = await startRollUiServer({
      controller: createController(),
      staticAssets: STATIC_ASSETS,
    });
    t.after(() => Promise.all([first.close(), second.close()]));

    assert.notEqual(first.basePath, second.basePath);
    const firstSession = await bootstrapSession(first, readLaunchToken(first));
    const secondSession = await bootstrapSession(second, readLaunchToken(second));
    assert.notEqual(firstSession.cookie.split("=", 1)[0], secondSession.cookie.split("=", 1)[0]);
    assert.ok(firstSession.setCookie.includes(`Path=${first.basePath}/`));
    assert.ok(secondSession.setCookie.includes(`Path=${second.basePath}/`));

    assert.equal((await apiFetch(first, "/api/config", firstSession.cookie)).status, 200);
    assert.equal((await apiFetch(second, "/api/config", secondSession.cookie)).status, 200);
    assert.equal((await apiFetch(first, "/api/config", secondSession.cookie)).status, 401);
    assert.equal(
      (await fetch(`${first.origin}/`, { headers: { cookie: firstSession.cookie } })).status,
      404,
    );
  });

  it("requires CSRF for mutations and validates the React API request contracts", async (t) => {
    const previewRequests: unknown[] = [];
    const saveRequests: unknown[] = [];
    const applyRequests: unknown[] = [];
    const controller = createController({
      previewConfig: (request) => {
        previewRequests.push(request);
        return { preview: true };
      },
      saveConfig: (request) => {
        saveRequests.push(request);
        return { saved: true };
      },
      applyAgentEffects: (request) => {
        applyRequests.push(request);
        return { applied: true };
      },
    });
    const server = await startRollUiServer({ controller, staticAssets: STATIC_ASSETS });
    t.after(() => server.close());
    const session = await bootstrapSession(server, readLaunchToken(server));
    const revision = createConfigRevision("current");

    const missingCsrf = await mutate(server, "/api/config/preview", session.cookie, undefined, {
      mode: "structured",
      persisted: {},
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal(previewRequests.length, 0);

    const preview = await mutate(server, "/api/config/preview", session.cookie, session.csrfToken, {
      mode: "structured",
      persisted: { runtime: {} },
      expectedRevision: revision,
    });
    assert.equal(preview.status, 200);
    assert.deepEqual(await readData(preview), { preview: true });
    assert.deepEqual(previewRequests, [
      { mode: "structured", persisted: { runtime: {} }, expectedRevision: revision },
    ]);

    const save = await mutate(server, "/api/config/save", session.cookie, session.csrfToken, {
      mode: "yaml",
      yaml: "runtime: {}\n",
      expectedRevision: revision,
    });
    assert.equal(save.status, 200);
    assert.deepEqual(saveRequests, [
      { mode: "yaml", yaml: "runtime: {}\n", expectedRevision: revision },
    ]);

    const missingRevision = await mutate(
      server,
      "/api/config/save",
      session.cookie,
      session.csrfToken,
      { mode: "yaml", yaml: "runtime: {}\n" },
    );
    assert.equal(missingRevision.status, 400);
    assert.equal((await readError(missingRevision)).code, "config_revision_required");
    assert.equal(saveRequests.length, 1);

    const effect = {
      kind: "restart-agent",
      paths: [["agents", "env", "browser-use-agent", "TOKEN"]],
      title: "Restart browser-use-agent",
      description: "Restart only when it was running before save.",
      agentName: "browser-use-agent",
      requiresConfirmation: true,
    };
    const apply = await mutate(server, "/api/agents/apply", session.cookie, session.csrfToken, {
      effects: [effect],
    });
    assert.equal(apply.status, 200);
    assert.deepEqual(applyRequests, [{ effects: [effect] }]);

    const manyEffects = Array.from({ length: 101 }, (_, index) => ({
      ...effect,
      paths: [["agents", "env", `agent-${String(index)}`, "TOKEN"]],
      title: `Restart agent-${String(index)}`,
      agentName: `agent-${String(index)}`,
    }));
    const applyMany = await mutate(server, "/api/agents/apply", session.cookie, session.csrfToken, {
      effects: manyEffects,
    });
    assert.equal(applyMany.status, 200);
    assert.deepEqual(applyRequests[1], { effects: manyEffects });

    const invalidRevision = await mutate(
      server,
      "/api/config/save",
      session.cookie,
      session.csrfToken,
      { mode: "yaml", yaml: "runtime: {}\n", expectedRevision: "stale" },
    );
    assert.equal(invalidRevision.status, 400);
    assert.equal(saveRequests.length, 1);
  });

  it("rejects oversized, compressed, and incorrectly typed bodies", async (t) => {
    const server = await startRollUiServer({
      controller: createController(),
      staticAssets: STATIC_ASSETS,
      bodyLimitBytes: 128,
    });
    t.after(() => server.close());
    const session = await bootstrapSession(server, readLaunchToken(server));

    const oversized = await mutate(server, "/api/config/save", session.cookie, session.csrfToken, {
      mode: "yaml",
      yaml: "x".repeat(256),
    });
    assert.equal(oversized.status, 413);

    const chunkedOversized = await rawRequest(
      server,
      "/api/config/save",
      {
        Cookie: session.cookie,
        Origin: server.origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrfToken,
      },
      "POST",
      JSON.stringify({ mode: "yaml", yaml: "x".repeat(256) }),
    );
    assert.equal(chunkedOversized.statusCode, 413);

    const wrongType = await fetch(appUrl(server, "/api/config/save"), {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: server.origin,
        "x-csrf-token": session.csrfToken,
        "content-type": "text/plain",
      },
      body: "{}",
    });
    assert.equal(wrongType.status, 415);

    const compressed = await fetch(appUrl(server, "/api/config/save"), {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: server.origin,
        "x-csrf-token": session.csrfToken,
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: "{}",
    });
    assert.equal(compressed.status, 415);
  });

  it("maps config errors and hides unexpected internal errors", async (t) => {
    const loggedErrors: unknown[] = [];
    const expectedRevision = createConfigRevision("expected");
    const actualRevision = createConfigRevision("actual");
    const controller = createController({
      previewConfig: () => {
        throw new ConfigApplicationValidationError(new Error("invalid config"));
      },
      saveConfig: () => {
        throw new ConfigRevisionConflictError(expectedRevision, actualRevision);
      },
      applyAgentEffects: () => {
        throw new Error("sensitive internal detail");
      },
    });
    const server = await startRollUiServer({
      controller,
      staticAssets: STATIC_ASSETS,
      onError: (error) => loggedErrors.push(error),
    });
    t.after(() => server.close());
    const session = await bootstrapSession(server, readLaunchToken(server));

    const validation = await mutate(
      server,
      "/api/config/preview",
      session.cookie,
      session.csrfToken,
      { mode: "yaml", yaml: "invalid: true\n" },
    );
    assert.equal(validation.status, 422);
    assert.equal((await readError(validation)).code, "config_validation_failed");

    const conflict = await mutate(server, "/api/config/save", session.cookie, session.csrfToken, {
      mode: "yaml",
      yaml: "runtime: {}\n",
      expectedRevision,
    });
    assert.equal(conflict.status, 409);
    assert.equal((await readError(conflict)).code, "config_revision_conflict");

    const internal = await mutate(server, "/api/agents/apply", session.cookie, session.csrfToken, {
      effects: [],
    });
    assert.equal(internal.status, 500);
    const internalText = await internal.text();
    assert.match(internalText, /internal_error/u);
    assert.doesNotMatch(internalText, /sensitive internal detail/u);
    assert.equal(loggedErrors.length, 1);
  });

  it("maps config writer and activation contention to stable 409 responses", async (t) => {
    const controller = createController({
      saveConfig: () => {
        throw new ConfigWriteLockError();
      },
      applyAgentEffects: () => {
        throw new RollUiActivationInProgressError();
      },
    });
    const server = await startRollUiServer({ controller, staticAssets: STATIC_ASSETS });
    t.after(() => server.close());
    const session = await bootstrapSession(server, readLaunchToken(server));
    const revision = createConfigRevision("current");

    const lockedSave = await mutate(server, "/api/config/save", session.cookie, session.csrfToken, {
      mode: "yaml",
      yaml: "runtime: {}\n",
      expectedRevision: revision,
    });
    assert.equal(lockedSave.status, 409);
    assert.equal((await readError(lockedSave)).code, "config_write_locked");

    const applying = await mutate(server, "/api/agents/apply", session.cookie, session.csrfToken, {
      effects: [],
    });
    assert.equal(applying.status, 409);
    assert.equal((await readError(applying)).code, "activation_in_progress");
  });
});

interface BootstrapResult {
  readonly response: Response;
  readonly cookie: string;
  readonly setCookie: string;
  readonly csrfToken: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

async function bootstrapSession(
  server: RollUiServerHandle,
  token: string,
): Promise<BootstrapResult> {
  const response = await fetch(appUrl(server, "/api/bootstrap"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: server.origin,
    },
    body: JSON.stringify({ token }),
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie !== null);
  const cookie = setCookie.split(";", 1)[0];
  assert.ok(cookie !== undefined);
  const payload = await readData(response);
  const csrfToken = payload.csrfToken;
  assert.ok(typeof csrfToken === "string");
  return {
    response,
    cookie,
    setCookie,
    csrfToken,
    payload,
  };
}

function readLaunchToken(server: RollUiServerHandle): string {
  const hash = new URL(server.url).hash;
  const parameters = new URLSearchParams(hash.slice(1));
  const token = parameters.get("token");
  assert.ok(token !== null);
  return token;
}

async function apiFetch(
  server: RollUiServerHandle,
  pathname: string,
  cookie: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetch(appUrl(server, pathname), {
    headers: { cookie, ...headers },
  });
}

async function mutate(
  server: RollUiServerHandle,
  pathname: string,
  cookie: string,
  csrfToken: string | undefined,
  body: unknown,
): Promise<Response> {
  return fetch(appUrl(server, pathname), {
    method: "POST",
    headers: {
      cookie,
      origin: server.origin,
      "content-type": "application/json",
      ...(csrfToken !== undefined ? { "x-csrf-token": csrfToken } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function readData(response: Response): Promise<Readonly<Record<string, unknown>>> {
  const payload: unknown = await response.json();
  assert.ok(isRecord(payload));
  assert.ok(isRecord(payload.data));
  return payload.data;
}

async function readError(response: Response): Promise<Readonly<Record<string, unknown>>> {
  const payload: unknown = await response.json();
  assert.ok(isRecord(payload));
  assert.ok(isRecord(payload.error));
  return payload.error;
}

function createController(overrides: Partial<RollUiController> = {}): RollUiController {
  return {
    getConfig: () => ({ config: true }),
    getCatalog: () => ({ catalog: true }),
    getAgentStatus: () => ({ agents: [] }),
    previewConfig: () => ({ preview: true }),
    saveConfig: () => ({ saved: true }),
    applyAgentEffects: () => ({ applied: true }),
    ...overrides,
  };
}

function rawRequest(
  server: RollUiServerHandle,
  pathname: string,
  headers: Readonly<Record<string, string>>,
  method = "GET",
  body?: string,
): Promise<{ readonly statusCode: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = requestHttp(
      {
        hostname: server.host,
        port: server.port,
        path: `${server.basePath}${pathname}`,
        headers,
        method,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    if (body === undefined) request.end();
    else {
      const middle = Math.ceil(body.length / 2);
      request.write(body.slice(0, middle));
      request.end(body.slice(middle));
    }
  });
}

function appUrl(server: RollUiServerHandle, pathname: string): string {
  return `${server.origin}${server.basePath}${pathname}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
