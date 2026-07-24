import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isProcessStartToken, type ProcessStartToken } from "./process-identity.ts";
import { AgentUsageBusyError } from "./agent-usage-lease.ts";
import { AgentRegistryBusyError } from "./agent-registry-lock.ts";
import { MANAGED_AGENT_RUNTIME_RETENTIONS } from "./process-manager.ts";
import type { AgentLifecycleLock, ManagedAgentRuntimeIdentity } from "./process-manager.ts";
import type { AgentRegistryLock } from "./agent-registry-lock.ts";
import type { RegisteredAgent } from "../types/agent.ts";
import {
  cleanupFailedAgentStartAttempt,
  finalizeAgentStartAttempt,
  finalizeAgentStartForCommand,
  prepareAgentStartAttempt,
  prepareAgentStartForCommand,
  type AgentStartAttempt,
  type AgentStartStore,
} from "./managed-agent-start.ts";

describe("agent start preparation", () => {
  it("rejects an active lease when runtime metadata is missing without status or spawn", async () => {
    const fixture = createStoreFixture(AGENT);
    let startCalls = 0;

    await assert.rejects(
      prepareAgentStartAttempt(
        AGENT,
        fixture.store,
        "/tmp/roll-agent-start-test",
        undefined,
        createLifecycleLock(),
        {
          collaborators: {
            readRuntime: () => undefined,
            inspectUsage: async () => ({
              agentName: AGENT.skill.name,
              runtime: undefined,
              blockers: [
                {
                  kind: "active",
                  leaseId: "00000000-0000-4000-8000-000000000001",
                  holderKind: "chat",
                  pid: 123,
                  acquiredAt: "2026-07-24T00:00:00.000Z",
                },
              ],
            }),
            promoteRuntime: () => false,
            start: () => {
              startCalls += 1;
              return 456;
            },
            stopGracefully: async () => false,
          },
        },
      ),
      /正被其他 Roll 进程使用/u,
    );

    assert.equal(startCalls, 0);
    assert.deepEqual(fixture.statusUpdates, []);
    assert.deepEqual(fixture.state.current, AGENT);
  });

  it("promotes a verified lease-bound runtime without inspecting blockers or spawning", async () => {
    const fixture = createStoreFixture(AGENT);
    const identity = createRuntimeIdentity(321);
    let inspectCalls = 0;
    let promoteCalls = 0;
    let startCalls = 0;

    const attempt = await prepareAgentStartAttempt(
      AGENT,
      fixture.store,
      "/tmp/roll-agent-start-test",
      undefined,
      createLifecycleLock(),
      {
        collaborators: {
          readRuntime: () => ({
            identity,
            retention: MANAGED_AGENT_RUNTIME_RETENTIONS.leaseBound,
          }),
          inspectUsage: async () => {
            inspectCalls += 1;
            return { agentName: AGENT.skill.name, runtime: undefined, blockers: [] };
          },
          promoteRuntime: () => {
            promoteCalls += 1;
            return true;
          },
          start: () => {
            startCalls += 1;
            return 456;
          },
          stopGracefully: async () => false,
        },
      },
    );

    assert.equal(attempt.started, false);
    assert.deepEqual(attempt.runtimeIdentity, identity);
    assert.equal(inspectCalls, 0);
    assert.equal(promoteCalls, 1);
    assert.equal(startCalls, 0);
    assert.deepEqual(fixture.statusUpdates, []);
  });

  it("does not stop an unbound replacement when post-spawn runtime verification fails", async () => {
    const fixture = createStoreFixture(AGENT);
    let runtimeReads = 0;
    let stopCalls = 0;

    await assert.rejects(
      prepareAgentStartAttempt(
        AGENT,
        fixture.store,
        "/tmp/roll-agent-start-test",
        undefined,
        createLifecycleLock(),
        {
          collaborators: {
            readRuntime: () => {
              runtimeReads += 1;
              return runtimeReads === 1
                ? undefined
                : {
                    identity: createRuntimeIdentity(999),
                    retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
                  };
            },
            inspectUsage: async () => ({
              agentName: AGENT.skill.name,
              runtime: undefined,
              blockers: [],
            }),
            promoteRuntime: () => false,
            start: () => 456,
            stopGracefully: async () => {
              stopCalls += 1;
              return true;
            },
          },
        },
      ),
      /启动后缺少与新进程匹配的可验证 runtime/u,
    );

    assert.equal(stopCalls, 0);
    assert.deepEqual(fixture.statusUpdates, ["starting"]);
  });

  it("uses the verified spawned identity when a later preparation failure needs rollback", async () => {
    const identity = createRuntimeIdentity(456);
    let runtimeReads = 0;
    let expectedIdentity: ManagedAgentRuntimeIdentity | undefined;
    const store: AgentStartStore = {
      findByName: () => undefined,
      updateStatus: () => {},
    };

    await assert.rejects(
      prepareAgentStartAttempt(
        AGENT,
        store,
        "/tmp/roll-agent-start-test",
        undefined,
        createLifecycleLock(),
        {
          collaborators: {
            readRuntime: () => {
              runtimeReads += 1;
              return runtimeReads === 1
                ? undefined
                : {
                    identity,
                    retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
                  };
            },
            inspectUsage: async () => ({
              agentName: AGENT.skill.name,
              runtime: undefined,
              blockers: [],
            }),
            promoteRuntime: () => false,
            start: () => identity.pid,
            stopGracefully: async (_dataDir, _agentName, options) => {
              expectedIdentity = options?.expectedIdentity;
              return true;
            },
          },
        },
      ),
      /在启动准备期间已从注册表消失/u,
    );

    assert.deepEqual(expectedIdentity, identity);
  });
});

describe("agent start command preparation", () => {
  it("turns env and lifecycle-lock failures into status-safe command results", async () => {
    for (const failurePoint of ["env", "lifecycle-lock"] as const) {
      const fixture = createStoreFixture(AGENT);
      const failure = new Error(`${failurePoint} failure`);
      const result = await prepareAgentStartForCommand(
        AGENT,
        fixture.store,
        "/tmp/roll-agent-start-test",
        () => {
          if (failurePoint === "env") throw failure;
          return undefined;
        },
        {
          collaborators: {
            acquireLifecycleLock: async () => {
              throw failure;
            },
            prepareAttempt: async () => {
              throw new Error("prepare should not run");
            },
          },
        },
      );

      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, failure);
      assert.deepEqual(fixture.statusUpdates, ["error"]);
    }
  });

  it("preserves status when preparation reports active usage blockers", async () => {
    const fixture = createStoreFixture(AGENT);
    const blocker = {
      kind: "active" as const,
      leaseId: "00000000-0000-4000-8000-000000000001",
      holderKind: "chat" as const,
      pid: 123,
      acquiredAt: "2026-07-24T00:00:00.000Z",
    };

    const result = await prepareAgentStartForCommand(
      AGENT,
      fixture.store,
      "/tmp/roll-agent-start-test",
      () => undefined,
      {
        collaborators: {
          acquireLifecycleLock: async () => createLifecycleLock(),
          prepareAttempt: async () => {
            throw new AgentUsageBusyError(AGENT.skill.name, [blocker]);
          },
        },
      },
    );

    assert.equal(result.ok, false);
    assert.deepEqual(fixture.statusUpdates, []);
  });

  it("keeps the preparation error when writing the error status also fails", async () => {
    const preparationError = new Error("env-primary");
    const statusError = new Error("status-write");
    const store: AgentStartStore = {
      findByName: () => AGENT,
      updateStatus: () => {
        throw statusError;
      },
    };

    const result = await prepareAgentStartForCommand(
      AGENT,
      store,
      "/tmp/roll-agent-start-test",
      () => {
        throw preparationError;
      },
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error instanceof AggregateError);
      assert.deepEqual(result.error.errors, [preparationError, statusError]);
    }
  });
});

describe("agent start finalization", () => {
  it("commits online only after registry then lifecycle identity revalidation", async () => {
    const identity = createRuntimeIdentity(401);
    const attempt = createAttempt(identity);
    const fixture = createStoreFixture(attempt.agent);
    const order: string[] = [];

    const committed = await finalizeAgentStartAttempt(
      attempt,
      "/tmp/roll-agent-start-test",
      "online",
      {
        collaborators: {
          acquireRegistryLock: async () => {
            order.push("registry:acquire");
            return createRegistryLock(() => order.push("registry:release"));
          },
          acquireLifecycleLock: async () => {
            order.push("lifecycle:acquire");
            return createLifecycleLock(() => order.push("lifecycle:release"));
          },
          createStore: () => fixture.store,
          readRuntime: () => {
            order.push("runtime:read");
            return {
              identity,
              retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
            };
          },
          stopGracefully: async () => false,
        },
      },
    );

    assert.deepEqual(committed, { kind: "committed" });
    assert.deepEqual(fixture.statusUpdates, ["online"]);
    assert.deepEqual(order, [
      "registry:acquire",
      "lifecycle:acquire",
      "runtime:read",
      "lifecycle:release",
      "registry:release",
    ]);
  });

  it("does not overwrite a concurrent stop whose runtime was removed", async () => {
    const identity = createRuntimeIdentity(402);
    const attempt = createAttempt(identity);
    const fixture = createStoreFixture({ ...attempt.agent, status: "stopped" });
    let lifecycleAcquisitions = 0;

    const committed = await finalizeAgentStartAttempt(
      attempt,
      "/tmp/roll-agent-start-test",
      "online",
      {
        collaborators: {
          acquireRegistryLock: async () => createRegistryLock(),
          acquireLifecycleLock: async () => {
            lifecycleAcquisitions += 1;
            return createLifecycleLock();
          },
          createStore: () => fixture.store,
          readRuntime: () => undefined,
          stopGracefully: async () => false,
        },
      },
    );

    assert.deepEqual(committed, { kind: "stale" });
    assert.equal(lifecycleAcquisitions, 1);
    assert.deepEqual(fixture.statusUpdates, []);
    assert.equal(fixture.state.current?.status, "stopped");
  });

  it("ignores a concurrent health status update when registration and runtime are unchanged", async () => {
    const identity = createRuntimeIdentity(405);
    const attempt = createAttempt(identity);
    const fixture = createStoreFixture({ ...attempt.agent, status: "online" });

    const committed = await finalizeAgentStartAttempt(
      attempt,
      "/tmp/roll-agent-start-test",
      "online",
      {
        collaborators: {
          acquireRegistryLock: async () => createRegistryLock(),
          acquireLifecycleLock: async () => createLifecycleLock(),
          createStore: () => fixture.store,
          readRuntime: () => ({
            identity,
            retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
          }),
          stopGracefully: async () => false,
        },
      },
    );

    assert.deepEqual(committed, { kind: "committed" });
    assert.deepEqual(fixture.statusUpdates, ["online"]);
  });

  it("does not overwrite a concurrent same-name registration replacement", async () => {
    const identity = createRuntimeIdentity(403);
    const attempt = createAttempt(identity);
    const replacement: RegisteredAgent = {
      ...attempt.agent,
      skill: {
        ...attempt.agent.skill,
        description: "replacement registration",
      },
    };
    const fixture = createStoreFixture(replacement);

    const committed = await finalizeAgentStartAttempt(
      attempt,
      "/tmp/roll-agent-start-test",
      "error",
      {
        collaborators: {
          acquireRegistryLock: async () => createRegistryLock(),
          acquireLifecycleLock: async () => createLifecycleLock(),
          createStore: () => fixture.store,
          readRuntime: () => ({
            identity,
            retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
          }),
          stopGracefully: async () => true,
        },
      },
    );

    assert.deepEqual(committed, { kind: "stale" });
    assert.deepEqual(fixture.statusUpdates, []);
    assert.deepEqual(fixture.state.current, replacement);
  });

  it("does not overwrite status when the runtime identity was replaced", async () => {
    const identity = createRuntimeIdentity(404);
    const attempt = createAttempt(identity);
    const fixture = createStoreFixture(attempt.agent);

    const committed = await finalizeAgentStartAttempt(
      attempt,
      "/tmp/roll-agent-start-test",
      "online",
      {
        collaborators: {
          acquireRegistryLock: async () => createRegistryLock(),
          acquireLifecycleLock: async () => createLifecycleLock(),
          createStore: () => fixture.store,
          readRuntime: () => ({
            identity: createRuntimeIdentity(405),
            retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
          }),
          stopGracefully: async () => false,
        },
      },
    );

    assert.deepEqual(committed, { kind: "stale" });
    assert.deepEqual(fixture.statusUpdates, []);
  });

  it("stops only the expected started runtime before committing error", async () => {
    const identity = createRuntimeIdentity(406);
    const attempt = createAttempt(identity);
    const fixture = createStoreFixture(attempt.agent);
    let expectedIdentity: ManagedAgentRuntimeIdentity | undefined;

    const committed = await finalizeAgentStartAttempt(
      attempt,
      "/tmp/roll-agent-start-test",
      "error",
      {
        collaborators: {
          acquireRegistryLock: async () => createRegistryLock(),
          acquireLifecycleLock: async () => createLifecycleLock(),
          createStore: () => fixture.store,
          readRuntime: () => ({
            identity,
            retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
          }),
          inspectUsage: async () => ({
            agentName: attempt.agent.skill.name,
            runtime: {
              identity,
              retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
            },
            blockers: [],
          }),
          stopGracefully: async (_dataDir, _agentName, options) => {
            expectedIdentity = options?.expectedIdentity;
            return true;
          },
        },
      },
    );

    assert.deepEqual(committed, { kind: "committed" });
    assert.deepEqual(expectedIdentity, identity);
    assert.deepEqual(fixture.statusUpdates, ["error"]);
  });

  it("keeps a failed started runtime when another Roll holds a usage lease", async () => {
    const identity = createRuntimeIdentity(407);
    const attempt = createAttempt(identity);
    const fixture = createStoreFixture(attempt.agent);
    const blocker = {
      kind: "active" as const,
      leaseId: "00000000-0000-4000-8000-000000000007",
      holderKind: "chat" as const,
      pid: 700,
      acquiredAt: "2026-07-24T00:00:00.000Z",
    };
    let stopCalls = 0;

    const result = await finalizeAgentStartAttempt(attempt, "/tmp/roll-agent-start-test", "error", {
      collaborators: {
        acquireRegistryLock: async () => createRegistryLock(),
        acquireLifecycleLock: async () => createLifecycleLock(),
        createStore: () => fixture.store,
        readRuntime: () => ({
          identity,
          retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
        }),
        inspectUsage: async () => ({
          agentName: attempt.agent.skill.name,
          runtime: {
            identity,
            retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
          },
          blockers: [blocker],
        }),
        stopGracefully: async () => {
          stopCalls += 1;
          return true;
        },
      },
    });

    assert.deepEqual(result, { kind: "in-use", blockers: [blocker] });
    assert.equal(stopCalls, 0);
    assert.deepEqual(fixture.statusUpdates, ["error"]);
  });

  it("does not roll back a failed start after a concurrent online status update", async () => {
    const identity = createRuntimeIdentity(408);
    const attempt = createAttempt(identity);
    const fixture = createStoreFixture({ ...attempt.agent, status: "online" });
    let inspectCalls = 0;
    let stopCalls = 0;

    const result = await finalizeAgentStartAttempt(attempt, "/tmp/roll-agent-start-test", "error", {
      collaborators: {
        acquireRegistryLock: async () => createRegistryLock(),
        acquireLifecycleLock: async () => createLifecycleLock(),
        createStore: () => fixture.store,
        readRuntime: () => ({
          identity,
          retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
        }),
        inspectUsage: async () => {
          inspectCalls += 1;
          return {
            agentName: attempt.agent.skill.name,
            runtime: {
              identity,
              retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
            },
            blockers: [],
          };
        },
        stopGracefully: async () => {
          stopCalls += 1;
          return true;
        },
      },
    });

    assert.deepEqual(result, { kind: "stale" });
    assert.equal(inspectCalls, 0);
    assert.equal(stopCalls, 0);
    assert.deepEqual(fixture.statusUpdates, []);
  });

  it("still rolls back an unused failed runtime after health writes error", async () => {
    const identity = createRuntimeIdentity(412);
    const attempt = createAttempt(identity);
    const fixture = createStoreFixture({ ...attempt.agent, status: "error" });
    let expectedIdentity: ManagedAgentRuntimeIdentity | undefined;

    const result = await finalizeAgentStartAttempt(attempt, "/tmp/roll-agent-start-test", "error", {
      collaborators: {
        acquireRegistryLock: async () => createRegistryLock(),
        acquireLifecycleLock: async () => createLifecycleLock(),
        createStore: () => fixture.store,
        readRuntime: () => ({
          identity,
          retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
        }),
        inspectUsage: async () => ({
          agentName: attempt.agent.skill.name,
          runtime: {
            identity,
            retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
          },
          blockers: [],
        }),
        stopGracefully: async (_dataDir, _agentName, options) => {
          expectedIdentity = options?.expectedIdentity;
          return true;
        },
      },
    });

    assert.deepEqual(result, { kind: "committed" });
    assert.deepEqual(expectedIdentity, identity);
    assert.deepEqual(fixture.statusUpdates, []);
    assert.equal(fixture.state.current?.status, "error");
  });
});

describe("failed agent start cleanup", () => {
  it("stops the exact unused runtime without acquiring the registry lock", async () => {
    const identity = createRuntimeIdentity(409);
    const attempt = createAttempt(identity);
    const order: string[] = [];
    let expectedIdentity: ManagedAgentRuntimeIdentity | undefined;

    const result = await cleanupFailedAgentStartAttempt(attempt, "/tmp/roll-agent-start-test", {
      collaborators: {
        acquireLifecycleLock: async () => {
          order.push("lifecycle:acquire");
          return createLifecycleLock(() => order.push("lifecycle:release"));
        },
        inspectUsage: async () => {
          order.push("usage:inspect");
          return {
            agentName: attempt.agent.skill.name,
            runtime: {
              identity,
              retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
            },
            blockers: [],
          };
        },
        stopGracefully: async (_dataDir, _agentName, options) => {
          order.push("runtime:stop");
          expectedIdentity = options?.expectedIdentity;
          return true;
        },
      },
    });

    assert.deepEqual(result, { kind: "stopped" });
    assert.deepEqual(expectedIdentity, identity);
    assert.deepEqual(order, [
      "lifecycle:acquire",
      "usage:inspect",
      "runtime:stop",
      "lifecycle:release",
    ]);
  });

  it("keeps the exact runtime when fallback cleanup finds an active lease", async () => {
    const identity = createRuntimeIdentity(410);
    const attempt = createAttempt(identity);
    const blocker = {
      kind: "active" as const,
      leaseId: "00000000-0000-4000-8000-000000000010",
      holderKind: "chat" as const,
      pid: 710,
      acquiredAt: "2026-07-24T00:00:00.000Z",
    };
    let stopCalls = 0;

    const result = await cleanupFailedAgentStartAttempt(attempt, "/tmp/roll-agent-start-test", {
      collaborators: {
        acquireLifecycleLock: async () => createLifecycleLock(),
        inspectUsage: async () => ({
          agentName: attempt.agent.skill.name,
          runtime: {
            identity,
            retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
          },
          blockers: [blocker],
        }),
        stopGracefully: async () => {
          stopCalls += 1;
          return true;
        },
      },
    });

    assert.deepEqual(result, { kind: "in-use", blockers: [blocker] });
    assert.equal(stopCalls, 0);
  });

  it("invokes lifecycle-only cleanup when finalization cannot acquire the registry lock", async () => {
    const attempt = createAttempt(createRuntimeIdentity(411));
    const registryError = new AgentRegistryBusyError();
    let cleanupCalls = 0;

    const result = await finalizeAgentStartForCommand(
      attempt,
      "/tmp/roll-agent-start-test",
      "error",
      {
        collaborators: {
          finalizeAttempt: async () => {
            throw registryError;
          },
          cleanupFailedAttempt: async () => {
            cleanupCalls += 1;
            return { kind: "stopped" };
          },
        },
      },
    );

    assert.equal(result.finalization, undefined);
    assert.equal(result.finalizationError, registryError);
    assert.deepEqual(result.fallbackCleanup, { kind: "stopped" });
    assert.equal(result.fallbackCleanupError, undefined);
    assert.equal(cleanupCalls, 1);
  });
});

interface StoreFixture {
  readonly store: AgentStartStore;
  readonly state: { current: RegisteredAgent | undefined };
  readonly statusUpdates: RegisteredAgent["status"][];
}

function createStoreFixture(initial: RegisteredAgent): StoreFixture {
  const state: { current: RegisteredAgent | undefined } = { current: initial };
  const statusUpdates: RegisteredAgent["status"][] = [];
  const store: AgentStartStore = {
    findByName: (name) => (state.current?.skill.name === name ? state.current : undefined),
    updateStatus: (name, status) => {
      if (state.current?.skill.name !== name) return;
      statusUpdates.push(status);
      state.current = { ...state.current, status };
    },
  };
  return { store, state, statusUpdates };
}

function createAttempt(runtimeIdentity: ManagedAgentRuntimeIdentity): AgentStartAttempt {
  return {
    agent: { ...AGENT, status: "starting" },
    runtimeIdentity,
    started: true,
  };
}

function createRuntimeIdentity(pid: number): ManagedAgentRuntimeIdentity {
  const processStartToken = createProcessStartToken(pid);
  return {
    pid,
    processStartToken,
    startedAt: "2026-07-24T00:00:00.000Z",
  };
}

function createProcessStartToken(seed: number): ProcessStartToken {
  const processStartToken = `pst-v1:${seed.toString(16).padStart(64, "0")}`;
  assert.ok(processStartToken);
  assert.ok(isProcessStartToken(processStartToken));
  return processStartToken;
}

function createLifecycleLock(onRelease: () => void = () => {}): AgentLifecycleLock {
  return { release: onRelease };
}

function createRegistryLock(onRelease: () => void = () => {}): AgentRegistryLock {
  return { release: onRelease };
}

const AGENT: RegisteredAgent = {
  skill: {
    name: "browser-use-agent",
    description: "Browser use agent",
    metadata: {},
  },
  transport: { type: "streamable-http", endpoint: "http://127.0.0.1:4321/mcp" },
  runtime: {
    ownership: "core-managed",
    start: { command: "node", args: ["dist/index.js"] },
    endpoint: { path: "/mcp", port: 4_321 },
  },
  installPath: "/tmp/browser-use-agent",
  registeredAt: "2026-07-24T00:00:00.000Z",
  status: "online",
};
