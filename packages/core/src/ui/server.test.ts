import assert from "node:assert/strict";
import { request as requestHttp, type IncomingHttpHeaders } from "node:http";
import { describe, it } from "node:test";
import { companionConfigSchema } from "../companion-host/schema.ts";
import { ConfigApplicationValidationError } from "../config/application-service.ts";
import {
  ConfigRevisionConflictError,
  ConfigWriteLockError,
  createConfigRevision,
} from "../config/document-store.ts";
import {
  createRollUiCompanionController,
  RollUiCompanionBusyError,
  type CompanionApplicationPort,
} from "./companion-controller.ts";
import type {
  RollUiCompanionController,
  RollUiController,
  RollUiStaticAssetProvider,
} from "./contracts.ts";
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

describe("startRollUiServer companion routes", () => {
  it("hides the companion API when no companion controller is injected", async (t) => {
    const server = await startRollUiServer({
      controller: createController(),
      staticAssets: STATIC_ASSETS,
    });
    t.after(() => server.close());
    const session = await bootstrapSession(server, readLaunchToken(server));

    const unauthenticated = await fetch(appUrl(server, "/api/companion/status"));
    assert.equal(unauthenticated.status, 401);
    assert.equal((await readError(unauthenticated)).code, "authentication_required");

    const status = await apiFetch(server, "/api/companion/status", session.cookie);
    assert.equal(status.status, 404);
    assert.equal((await readError(status)).code, "companion_unavailable");

    const mutation = await mutate(
      server,
      "/api/companion/start",
      session.cookie,
      session.csrfToken,
      undefined,
    );
    assert.equal(mutation.status, 404);
    assert.equal((await readError(mutation)).code, "companion_unavailable");
  });

  it("requires a session and CSRF before reaching the companion controller", async (t) => {
    const companion = createFakeCompanionController();
    const server = await startRollUiServer({
      controller: createController(),
      staticAssets: STATIC_ASSETS,
      companionController: companion.controller,
    });
    t.after(() => server.close());
    const session = await bootstrapSession(server, readLaunchToken(server));

    const unauthenticated = await fetch(appUrl(server, "/api/companion/status"));
    assert.equal(unauthenticated.status, 401);

    const missingCsrf = await mutate(
      server,
      "/api/companion/stop",
      session.cookie,
      undefined,
      undefined,
    );
    assert.equal(missingCsrf.status, 403);

    const wrongMethod = await apiFetch(server, "/api/companion/stop", session.cookie);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");

    const unknownRoute = await apiFetch(server, "/api/companion/nope", session.cookie);
    assert.equal(unknownRoute.status, 404);
    assert.equal((await readError(unknownRoute)).code, "not_found");
    assert.deepEqual(companion.calls, []);
  });

  it("forwards every companion read and mutation route", async (t) => {
    const companion = createFakeCompanionController();
    const server = await startRollUiServer({
      controller: createController(),
      staticAssets: STATIC_ASSETS,
      companionController: companion.controller,
    });
    t.after(() => server.close());
    const session = await bootstrapSession(server, readLaunchToken(server));

    const status = await apiFetch(server, "/api/companion/status", session.cookie);
    assert.equal(status.status, 200);
    assert.deepEqual(await readData(status), { phase: "stopped", enrolled: false });

    const doctor = await apiFetch(server, "/api/companion/doctor", session.cookie);
    assert.deepEqual(await readData(doctor), { ok: true, checks: [] });

    const logs = await apiFetch(server, "/api/companion/logs", session.cookie);
    assert.deepEqual(await readData(logs), { text: "companion log\n" });

    const enroll = await mutate(
      server,
      "/api/companion/enroll",
      session.cookie,
      session.csrfToken,
      { pairingCode: "PAIR-1234", workspace: "/tmp/workspace" },
    );
    assert.equal(enroll.status, 200);
    assert.deepEqual(await readData(enroll), { ok: true });

    const workspace = await mutate(
      server,
      "/api/companion/workspace",
      session.cookie,
      session.csrfToken,
      { workspace: "/tmp/workspace" },
    );
    assert.equal(workspace.status, 200);

    for (const pathname of [
      "/api/companion/unenroll",
      "/api/companion/enable",
      "/api/companion/disable",
      "/api/companion/service/install",
      "/api/companion/service/uninstall",
      "/api/companion/start",
      "/api/companion/stop",
      "/api/companion/restart",
    ]) {
      const response = await mutate(server, pathname, session.cookie, session.csrfToken, undefined);
      assert.equal(response.status, 200, pathname);
    }

    assert.deepEqual(companion.calls, [
      "getStatus",
      "getDoctor",
      "readLogs",
      "enroll",
      "setWorkspace",
      "unenroll",
      "enable",
      "disable",
      "installService",
      "uninstallService",
      "start",
      "stop",
      "restart",
    ]);
    assert.deepEqual(companion.requests, [
      { pairingCode: "PAIR-1234", workspace: "/tmp/workspace" },
      { workspace: "/tmp/workspace" },
    ]);
  });

  it("maps companion contention to 409 and operation failures to a readable 422", async (t) => {
    const loggedErrors: unknown[] = [];
    const companion = createFakeCompanionController({
      start: () => {
        throw new RollUiCompanionBusyError();
      },
      stop: () => {
        throw new Error("Roll Companion is not enrolled");
      },
    });
    const server = await startRollUiServer({
      controller: createController(),
      staticAssets: STATIC_ASSETS,
      companionController: companion.controller,
      onError: (error) => loggedErrors.push(error),
    });
    t.after(() => server.close());
    const session = await bootstrapSession(server, readLaunchToken(server));

    const busy = await mutate(
      server,
      "/api/companion/start",
      session.cookie,
      session.csrfToken,
      undefined,
    );
    assert.equal(busy.status, 409);
    assert.equal((await readError(busy)).code, "companion_busy");

    const failed = await mutate(
      server,
      "/api/companion/stop",
      session.cookie,
      session.csrfToken,
      undefined,
    );
    assert.equal(failed.status, 422);
    const failure = await readError(failed);
    assert.equal(failure.code, "companion_operation_failed");
    assert.equal(failure.message, "Roll Companion is not enrolled");
    assert.deepEqual(loggedErrors, []);
  });

  it("streams companion logs and aborts the follow when the browser disconnects", async (t) => {
    const companion = createFakeCompanionController();
    const server = await startRollUiServer({
      controller: createController(),
      staticAssets: STATIC_ASSETS,
      companionController: companion.controller,
    });
    t.after(() => server.close());
    const session = await bootstrapSession(server, readLaunchToken(server));

    const stream = openLogStream(server, session.cookie);
    const head = await stream.head;
    assert.equal(head.statusCode, 200);
    assert.match(String(head.headers["content-type"]), /^text\/event-stream/u);
    assert.equal(head.headers["cache-control"], "no-store");
    assert.equal(head.headers["content-length"], undefined);

    await waitUntil(() => companion.emitters.length === 1);
    companion.emit("first line\nsecond line\n");
    const frames = await stream.waitFor(/second line/u);

    assert.match(frames, /retry: 3000/u);
    assert.match(frames, /event: log\ndata: first line\ndata: second line\ndata: \n\n/u);

    stream.disconnect();
    await waitUntil(() => companion.aborted === 1);
    assert.equal(companion.aborted, 1);
  });

  it("terminates in-flight log streams when the server closes", async () => {
    const companion = createFakeCompanionController();
    const server = await startRollUiServer({
      controller: createController(),
      staticAssets: STATIC_ASSETS,
      companionController: companion.controller,
    });
    const session = await bootstrapSession(server, readLaunchToken(server));

    const stream = openLogStream(server, session.cookie);
    assert.equal((await stream.head).statusCode, 200);
    await waitUntil(() => companion.emitters.length === 1);

    await server.close();

    assert.equal(companion.aborted, 1);
    stream.disconnect();
  });

  it("keeps the pairing code out of responses, onError and stderr", async (t) => {
    const pairingCode = "PAIR-SECRET-9Z7Q";
    const loggedErrors: unknown[] = [];
    const stderrChunks: string[] = [];
    const restoreStderr = captureStderr(stderrChunks);
    t.after(restoreStderr);
    const application = createFakeCompanionApplication();
    const server = await startRollUiServer({
      controller: createController(),
      staticAssets: STATIC_ASSETS,
      companionController: createRollUiCompanionController({ application }),
      onError: (error) => {
        loggedErrors.push(error);
        process.stderr.write(
          `roll ui error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    });
    t.after(() => server.close());
    const session = await bootstrapSession(server, readLaunchToken(server));

    const rejected = await mutate(
      server,
      "/api/companion/enroll",
      session.cookie,
      session.csrfToken,
      { pairingCode },
    );
    assert.equal(rejected.status, 400);
    const rejectedBody = await rejected.text();
    assert.equal(JSON.parse(rejectedBody).error.code, "invalid_request");

    application.failure = new Error("Official Relay rejected device enrollment (HTTP 401)");
    const failed = await mutate(
      server,
      "/api/companion/enroll",
      session.cookie,
      session.csrfToken,
      { pairingCode, workspace: "/tmp/workspace" },
    );
    assert.equal(failed.status, 422);
    const failedBody = await failed.text();

    application.failure = undefined;
    const accepted = await mutate(
      server,
      "/api/companion/enroll",
      session.cookie,
      session.csrfToken,
      { pairingCode, workspace: "/tmp/workspace" },
    );
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.text();
    assert.deepEqual(application.enrollments, [
      { pairingCode, workspace: "/tmp/workspace" },
      { pairingCode, workspace: "/tmp/workspace" },
    ]);

    restoreStderr();
    const observed = [
      rejectedBody,
      failedBody,
      acceptedBody,
      stderrChunks.join(""),
      loggedErrors.map((error) => (error instanceof Error ? error.stack : String(error))).join(""),
    ].join("\n");
    assert.equal(observed.includes(pairingCode), false);
    assert.deepEqual(loggedErrors, []);
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

interface FakeCompanionController {
  readonly controller: RollUiCompanionController;
  readonly calls: string[];
  readonly requests: unknown[];
  readonly emitters: Array<(text: string) => void>;
  readonly emit: (text: string) => void;
  readonly aborted: number;
}

function createFakeCompanionController(
  overrides: Partial<RollUiCompanionController> = {},
): FakeCompanionController {
  const calls: string[] = [];
  const requests: unknown[] = [];
  const emitters: Array<(text: string) => void> = [];
  const state = { aborted: 0 };
  const record = <T>(name: string, value: T): T => {
    calls.push(name);
    return value;
  };
  const base: RollUiCompanionController = {
    getStatus: () => record("getStatus", { phase: "stopped", enrolled: false }),
    getDoctor: () => record("getDoctor", { ok: true, checks: [] }),
    readLogs: () => record("readLogs", { text: "companion log\n" }),
    followLogs: (onText, signal) => {
      calls.push("followLogs");
      emitters.push(onText);
      return new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            state.aborted += 1;
            resolve();
          },
          { once: true },
        );
      });
    },
    enroll: (request) => {
      requests.push(request);
      return record("enroll", { ok: true });
    },
    setWorkspace: (request) => {
      requests.push(request);
      return record("setWorkspace", { ok: true });
    },
    unenroll: () => record("unenroll", { ok: true }),
    enable: () => record("enable", { ok: true }),
    disable: () => record("disable", { ok: true }),
    installService: () => record("installService", { ok: true }),
    uninstallService: () => record("uninstallService", { ok: true }),
    start: () => record("start", { ok: true }),
    stop: () => record("stop", { ok: true }),
    restart: () => record("restart", { ok: true }),
  };
  return {
    controller: { ...base, ...overrides },
    calls,
    requests,
    emitters,
    emit: (text) => {
      for (const emitter of emitters) emitter(text);
    },
    get aborted() {
      return state.aborted;
    },
  };
}

interface FakeCompanionApplication extends CompanionApplicationPort {
  readonly enrollments: Array<{ readonly pairingCode: string; readonly workspace: string }>;
  failure: Error | undefined;
}

function createFakeCompanionApplication(): FakeCompanionApplication {
  const config = companionConfigSchema.parse({
    version: 1,
    deviceId: "6e6d9a6f-6c1b-4a3e-9b5c-2f4d8a1e7c30",
    workspaceId: "0f0f9a6f-6c1b-4a3e-9b5c-2f4d8a1e7c31",
    cwd: "/tmp/workspace",
    enabled: true,
    credentialRef: "keychain:6e6d9a6f-6c1b-4a3e-9b5c-2f4d8a1e7c30",
  });
  const enrollments: Array<{ readonly pairingCode: string; readonly workspace: string }> = [];
  const fake: FakeCompanionApplication = {
    enrollments,
    failure: undefined,
    getStatus: async () => ({
      phase: "stopped",
      enabled: false,
      enrolled: false,
      runtimeOnline: false,
      relayProfile: "roll-cloud-v1",
    }),
    doctor: async () => ({ ok: true, checks: [] }),
    readLogs: async () => "",
    followLogs: async () => undefined,
    enroll: async (input) => {
      enrollments.push({ pairingCode: input.pairingCode, workspace: input.workspace });
      if (fake.failure !== undefined) throw fake.failure;
      return config;
    },
    unenroll: async () => true,
    enable: async () => config,
    disable: async () => config,
    setWorkspace: async () => config,
    installService: async () => undefined,
    uninstallService: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    restart: async () => undefined,
  };
  return fake;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface LogStreamClient {
  readonly head: Promise<{
    readonly statusCode: number;
    readonly headers: IncomingHttpHeaders;
  }>;
  readonly waitFor: (pattern: RegExp) => Promise<string>;
  readonly disconnect: () => void;
}

function openLogStream(server: RollUiServerHandle, cookie: string): LogStreamClient {
  const head = Promise.withResolvers<{ statusCode: number; headers: IncomingHttpHeaders }>();
  const waiters: Array<{ readonly pattern: RegExp; readonly resolve: (text: string) => void }> = [];
  let text = "";
  const request = requestHttp({
    hostname: server.host,
    port: server.port,
    path: `${server.basePath}/api/companion/logs/stream`,
    headers: { Cookie: cookie },
  });
  request.on("error", () => undefined);
  request.on("response", (response) => {
    head.resolve({ statusCode: response.statusCode ?? 0, headers: response.headers });
    response.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      for (const waiter of [...waiters]) {
        if (!waiter.pattern.test(text)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(text);
      }
    });
  });
  request.end();
  return {
    head: head.promise,
    waitFor: (pattern) =>
      pattern.test(text)
        ? Promise.resolve(text)
        : new Promise<string>((resolve) => waiters.push({ pattern, resolve })),
    disconnect: () => request.destroy(),
  };
}

function captureStderr(sink: string[]): () => void {
  const original = process.stderr.write.bind(process.stderr);
  const capture = (chunk: string | Uint8Array): boolean => {
    sink.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  process.stderr.write = capture as typeof process.stderr.write;
  return () => {
    process.stderr.write = original;
  };
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
