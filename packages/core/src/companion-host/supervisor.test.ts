import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeClientExit } from "@roll-agent/client-node";
import { deviceIdSchema, workspaceIdSchema } from "@roll-agent/relay-protocol";
import type { CompanionCredentialStore } from "./credentials.ts";
import type { CompanionSessionFactory, ManagedCompanionSession } from "./host-session.ts";
import { stopRelayBeforeRuntime } from "./host-session.ts";
import type { CompanionLogger } from "./logger.ts";
import { credentialReferenceSchema, type CompanionConfig } from "./schema.ts";
import { CompanionHostSupervisor } from "./supervisor.ts";

const config: CompanionConfig = {
  version: 1,
  deviceId: deviceIdSchema.parse("11111111-1111-4111-8111-111111111111"),
  workspaceId: workspaceIdSchema.parse("22222222-2222-4222-8222-222222222222"),
  cwd: "/workspace",
  enabled: true,
  credentialRef: credentialReferenceSchema.parse("keychain:test-device"),
};

class FakeCredentialStore implements CompanionCredentialStore {
  async put(): Promise<never> {
    throw new Error("not used");
  }

  async get(): Promise<string> {
    return "credential-at-least-sixteen";
  }

  async delete(): Promise<void> {}
}

class RecordingLogger implements CompanionLogger {
  readonly entries: string[] = [];
  info(message: string): void {
    this.entries.push(message);
  }
  error(message: string): void {
    this.entries.push(message);
  }
}

test("supervisor keeps Runtime through Relay reconnects and replaces a crashed Runtime", async () => {
  const exits: Array<ReturnType<typeof Promise.withResolvers<RuntimeClientExit>>> = [];
  let stops = 0;
  const factory: CompanionSessionFactory = {
    async create(): Promise<ManagedCompanionSession> {
      const exit = Promise.withResolvers<RuntimeClientExit>();
      exits.push(exit);
      return {
        runtimeExit: exit.promise,
        async stop() {
          stops += 1;
        },
      };
    },
  };
  const supervisor = new CompanionHostSupervisor({
    config,
    credentialStore: new FakeCredentialStore(),
    sessionFactory: factory,
    logger: new RecordingLogger(),
  });
  const running = supervisor.run();
  await waitUntil(() => exits.length === 1);
  assert.equal(supervisor.getStatus().runtimeOnline, true);
  exits[0]?.resolve({ code: 1, signal: null, error: new Error("crashed") });
  await waitUntil(() => exits.length === 2, 1_500);
  assert.equal(stops, 1);
  assert.equal(supervisor.getStatus().runtimeOnline, true);
  await supervisor.stop();
  await running;
  assert.equal(stops, 2);
  assert.equal(supervisor.getStatus().phase, "stopped");
});

test("session shutdown detaches Relay before shutting down Runtime", async () => {
  const order: string[] = [];
  await stopRelayBeforeRuntime(
    { stop: () => order.push("relay") },
    {
      async shutdown() {
        order.push("runtime");
      },
    },
  );
  assert.deepEqual(order, ["relay", "runtime"]);
});

test("supervisor memoizes a session shutdown failure instead of hiding it with a second no-op", async () => {
  let creates = 0;
  let stopAttempts = 0;
  const neverExits = Promise.withResolvers<RuntimeClientExit>();
  const supervisor = new CompanionHostSupervisor({
    config,
    credentialStore: new FakeCredentialStore(),
    sessionFactory: {
      async create() {
        creates += 1;
        return {
          runtimeExit: neverExits.promise,
          async stop() {
            stopAttempts += 1;
            if (stopAttempts === 1) {
              throw new Error("session shutdown failed");
            }
          },
        };
      },
    },
    logger: new RecordingLogger(),
  });
  const running = supervisor.run();
  await waitUntil(() => creates === 1);
  await assert.rejects(supervisor.stop(), /session shutdown failed/u);
  await assert.rejects(running, /session shutdown failed/u);
  assert.equal(stopAttempts, 1);
  assert.notEqual(supervisor.getStatus().phase, "stopped");
});

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for test condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
