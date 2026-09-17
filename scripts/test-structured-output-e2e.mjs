import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { RollNodeClient } from "../packages/client-node/src/index.ts";
import { CompanionWorkspace } from "../packages/companion/src/companion-workspace.ts";
import {
  CompanionInteractionBroker,
  createRuntimeServerRequestHandlers,
} from "../packages/companion/src/interaction-broker.ts";
import {
  CompanionRelayBridgeV11,
  createWebSocketRelayTransportV11,
} from "../packages/companion/src/relay-bridge-v11.ts";
import { createRelayClientWithRuntime } from "../packages/relay-client/src/client.ts";

const root = resolve(import.meta.dirname, "..");
const serve = process.argv.includes("--serve");
const relayPort = serve ? Number(process.env.ROLL_TEST_RELAY_PORT ?? 9440) : 0;
const demoPort = Number(process.env.DEMO_PORT ?? 9441);
const relayRoot =
  process.env.ROLL_TEST_RELAY_REPO ??
  [resolve(root, "../roll-cloud-relay"), resolve(root, "../relay")].find((path) =>
    existsSync(join(path, "src/app.ts")),
  );
if (!relayRoot) throw new Error("Set ROLL_TEST_RELAY_REPO to the updated Cloud Relay checkout");
const { buildApp } = await import(pathToFileURL(join(relayRoot, "src/app.ts")));
const { loadConfig } = await import(pathToFileURL(join(relayRoot, "src/config.ts")));
const { createInMemoryEnrollmentStore } = await import(
  pathToFileURL(join(relayRoot, "src/relay/enrollment-store.ts"))
);
const { createSessionTicketService } = await import(
  pathToFileURL(join(relayRoot, "src/relay/session-ticket.ts"))
);
const require = createRequire(join(relayRoot, "package.json"));
const wsRequire = createRequire(require.resolve("@fastify/websocket"));
const Ws = wsRequire("ws");
const dir = mkdtempSync(join(tmpdir(), "roll-structured-output-e2e-"));
const apiKey = randomBytes(32).toString("hex");
const origin = "https://structured-output.example.test";
const config = loadConfig({
  RELAY_LOG_LEVEL: "fatal",
  RELAY_BUILD_VERSION: "structured-output-test",
  RELAY_PUBLIC_WSS_ORIGIN: serve
    ? `wss://127.0.0.1:${relayPort}`
    : "wss://structured-output.example.test",
  RELAY_ALLOWED_ORIGINS: serve ? `${origin},http://127.0.0.1:${demoPort}` : origin,
  RELAY_SESSION_TICKET_SECRET: randomBytes(32).toString("hex"),
  RELAY_BROWSER_SESSION_API_KEY: apiKey,
});
const built = buildApp({
  config,
  logger: false,
  enrollments: createInMemoryEnrollmentStore({ codeTtlMs: 600000 }),
  tickets: createSessionTicketService({
    secret: config.RELAY_SESSION_TICKET_SECRET,
    ttlMs: config.RELAY_SESSION_TICKET_TTL_MS,
  }),
});
let nodeClient, workspace, bridge, relayClient, companionSocket, demoServer;
async function settle(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}
try {
  const address = await built.app.listen({ host: "127.0.0.1", port: relayPort });
  async function post(path, body, authenticated = false) {
    const response = await fetch(new URL(path, address), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    assert.ok(response.ok, `POST ${path}: ${response.status} ${await response.clone().text()}`);
    return response.json();
  }
  const issued = await post("/v1/device-enrollments", {}, true);
  const device = await post("/v1/device-enrollments/redeem", { code: issued.code });
  const broker = new CompanionInteractionBroker();
  nodeClient = await RollNodeClient.start({
    command: process.execPath,
    args: [
      "--experimental-strip-types",
      "--experimental-sqlite",
      join(root, "tests/structured-output/runtime.mjs"),
    ],
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      ROLL_TEST_STORE: join(dir, "threads"),
      ROLL_TEST_EFFECT_COUNT: join(dir, "effects.txt"),
    },
    serverRequestHandlers: createRuntimeServerRequestHandlers(broker),
    onStderr: (line) => {
      if (line.includes("Error")) process.stderr.write(`${line}\n`);
    },
  });
  assert.equal(nodeClient.getInitializationResult().protocolVersion, "1.5");
  let allowed = true;
  const grantFile = join(dir, "remote-grant.json");
  writeFileSync(grantFile, JSON.stringify({ allowed: true }));
  workspace = new CompanionWorkspace({
    client: nodeClient,
    workspaceId: device.workspaceId,
    interactionBroker: broker,
    localApprovalPolicy: () => "deny",
    remoteAppOutputPolicy: (agent, tool) =>
      allowed &&
      JSON.parse(readFileSync(grantFile, "utf8")).allowed === true &&
      agent === "structured-output-demo" &&
      tool === "list_candidates",
  });
  bridge = new CompanionRelayBridgeV11({
    deviceId: device.deviceId,
    pairingToken: device.deviceCredential,
    workspaces: new Map([[device.workspaceId, workspace]]),
    protocolVersion: "1.2",
  });
  companionSocket = new WebSocket(address.replace("http:", "ws:") + "/v1/companion");
  await new Promise((resolve, reject) => {
    companionSocket.onopen = resolve;
    companionSocket.onerror = reject;
  });
  bridge.connect(createWebSocketRelayTransportV11(companionSocket), {
    requestPolicy: () => true,
    responderPolicy: () => true,
    responderContext: { fixture: "isolated" },
  });
  await settle(() => built.registry.isOnline(device.workspaceId), "Companion enrollment");
  const runtime = {
    createUuid: randomUUID,
    scheduler: { now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout },
    reconnectDelayMs: () => 25,
    createWebSocket(url) {
      const remote = new URL(url);
      const local = new URL(address.replace("http:", "ws:"));
      remote.protocol = local.protocol;
      remote.host = local.host;
      const socket = new Ws(remote, { origin });
      return {
        get readyState() {
          return socket.readyState;
        },
        setHandlers(handlers) {
          socket.on("open", handlers.onOpen);
          socket.on("message", (data) => handlers.onMessage(String(data)));
          socket.on("error", handlers.onError);
          socket.on("close", (code, reason) =>
            handlers.onClose({ code, reason: String(reason), wasClean: true }),
          );
        },
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
      };
    },
  };
  const options = {
    getSession: ({ supportedRelayProtocolVersions }) =>
      post(
        "/v1/browser-sessions",
        { workspaceId: device.workspaceId, supportedRelayProtocolVersions },
        true,
      ),
  };
  relayClient = createRelayClientWithRuntime(options, runtime);
  await relayClient.connect();
  const thread = await relayClient.createThread({ title: "Structured output isolated E2E" });
  await thread.send("List synthetic candidates");
  await settle(() => thread.getSnapshot().snapshot?.operations.items.length > 0, "tool completion");
  const snapshot = await thread.refresh();
  const operation = snapshot.operations.items[0];
  assert.ok(operation);
  const result = await thread.getResult(operation.id);
  assert.equal(result.result?.output.status, "available");
  assert.deepEqual(result.result.output.data, {
    candidates: [
      { id: "candidate-1", name: "李明", score: 0.9, skills: ["TypeScript", "Node.js"] },
    ],
  });
  assert.equal(Number(readFileSync(join(dir, "effects.txt"), "utf8")), 1);
  allowed = false;
  assert.equal((await thread.getResult(operation.id)).result?.output.status, "denied");
  allowed = true;
  const threadId = thread.id;
  relayClient.close();
  await settle(() => !built.registry.hasController(device.workspaceId), "browser close");
  relayClient = createRelayClientWithRuntime(options, runtime);
  await relayClient.connect();
  const reopened = await relayClient.openThread(threadId);
  assert.deepEqual((await reopened.getResult(operation.id)).result?.output, result.result.output);
  assert.equal(Number(readFileSync(join(dir, "effects.txt"), "utf8")), 1);
  console.log(
    JSON.stringify(
      {
        passed: true,
        chain:
          "SDK stdio child → RuntimeService stdio child → NodeClient → Companion → actual Cloud Relay WebSocket → RelayClient",
        checks: [
          "structured result",
          "explicit grant",
          "revocation",
          "history after reconnect",
          "effect count remains one",
        ],
        transport: "isolated loopback ws; production WSS URL rewritten only by test transport",
      },
      null,
      2,
    ),
  );
  if (serve) {
    relayClient.close();
    await settle(
      () => !built.registry.hasController(device.workspaceId),
      "browser controller detached for GUI",
    );
    execFileSync(
      process.execPath,
      [join(root, "examples/structured-output/build.mjs"), "--loopback-qa"],
      { cwd: root, stdio: "inherit" },
    );
    const demoPassword = "roll-structured-qa";
    demoServer = spawn(process.execPath, [join(root, "examples/structured-output/server.mjs")], {
      cwd: dir,
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        PATH: process.env.PATH,
        DEMO_RELAY_URL: address,
        DEMO_WORKSPACE_ID: device.workspaceId,
        DEMO_RELAY_APP_KEY: apiKey,
        DEMO_PASSWORD: demoPassword,
        DEMO_PORT: String(demoPort),
      },
    });
    console.log(
      JSON.stringify(
        {
          guiReady: true,
          url: `http://127.0.0.1:${demoPort}`,
          username: "demo",
          demoPassword,
          dataDir: dir,
          grantFile,
          threadId,
          workspaceId: device.workspaceId,
          runtimeEntry: join(root, "tests/structured-output/runtime.mjs"),
          runtimeEnv: {
            ROLL_TEST_STORE: join(dir, "threads"),
            ROLL_TEST_EFFECT_COUNT: join(dir, "effects.txt"),
          },
          transport:
            "Explicit test-only loopback WS adapter. Does not validate production WSS or TLS.",
        },
        null,
        2,
      ),
    );
    await new Promise((resolve, reject) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
      demoServer.once("error", reject);
      demoServer.once("exit", (code) => {
        if (code !== null && code !== 0) reject(new Error(`Demo exited ${code}`));
      });
    });
  }
} finally {
  demoServer?.kill("SIGTERM");
  relayClient?.close();
  bridge?.close();
  companionSocket?.close();
  await workspace?.closeIfIdle();
  await nodeClient?.shutdown();
  await built.app.close();
  rmSync(dir, { recursive: true, force: true });
}
