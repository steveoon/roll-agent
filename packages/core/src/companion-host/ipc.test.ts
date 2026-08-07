import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { COMPANION_CONTROL_PROTOCOL_VERSION, OFFICIAL_RELAY_PROFILE } from "./constants.ts";
import {
  CompanionControlServer,
  createControlListenOptions,
  sendCompanionControlRequest,
} from "./ipc.ts";
import type { CompanionHostStatus } from "./schema.ts";

const RUNNING_STATUS: CompanionHostStatus = {
  phase: "running",
  enabled: true,
  enrolled: true,
  runtimeOnline: true,
  relayProfile: OFFICIAL_RELAY_PROFILE.id,
};

test("control service uses a private Unix socket and handles status/stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "roll-companion-ipc-"));
  const endpoint = join(root, "control.sock");
  let stopped = false;
  const status = RUNNING_STATUS;
  const server = new CompanionControlServer({
    endpoint,
    platform: "linux",
    handlers: {
      getStatus: () => status,
      stop: () => {
        stopped = true;
      },
    },
  });
  try {
    await server.start();
    assert.equal((await stat(endpoint)).mode & 0o777, 0o600);
    const response = await sendCompanionControlRequest(endpoint, {
      version: COMPANION_CONTROL_PROTOCOL_VERSION,
      type: "status",
    });
    assert.equal(response.ok, true);
    const stopResponse = await sendCompanionControlRequest(endpoint, {
      version: COMPANION_CONTROL_PROTOCOL_VERSION,
      type: "stop",
    });
    assert.equal(stopResponse.ok, true);
    assert.equal(stopped, true);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a slow stop handler keeps the connection alive past the idle timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "roll-companion-ipc-slow-"));
  const endpoint = join(root, "control.sock");
  let stopped = false;
  const server = new CompanionControlServer({
    endpoint,
    platform: "linux",
    idleTimeoutMs: 80,
    handlers: {
      getStatus: () => RUNNING_STATUS,
      stop: async () => {
        await delay(150);
        stopped = true;
      },
    },
  });
  try {
    await server.start();
    const response = await sendCompanionControlRequest(
      endpoint,
      { version: COMPANION_CONTROL_PROTOCOL_VERSION, type: "stop" },
      { timeoutMs: 5_000 },
    );
    assert.equal(response.ok, true);
    assert.equal(stopped, true);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a connection that never sends a request is dropped by the idle timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "roll-companion-ipc-idle-"));
  const endpoint = join(root, "control.sock");
  const server = new CompanionControlServer({
    endpoint,
    platform: "linux",
    idleTimeoutMs: 80,
    handlers: { getStatus: () => RUNNING_STATUS, stop: () => undefined },
  });
  try {
    await server.start();
    const socket = createConnection(endpoint);
    socket.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const startedAt = Date.now();
    const closed = await Promise.race([
      new Promise<boolean>((resolve) => socket.once("close", () => resolve(true))),
      delay(3_000, false, { ref: false }),
    ]);
    socket.destroy();
    assert.equal(closed, true);
    assert.ok(Date.now() - startedAt >= 50);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows named pipe never opts into cross-user read or write access", () => {
  assert.deepEqual(createControlListenOptions("\\\\.\\pipe\\roll-test"), {
    path: "\\\\.\\pipe\\roll-test",
    readableAll: false,
    writableAll: false,
  });
});
