import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rollbackStartedManagedAgentOrThrow } from "./managed-runtime-rollback.ts";
import { isProcessStartToken, type ProcessStartToken } from "./process-identity.ts";
import type { AgentLifecycleLock, ManagedAgentRuntimeIdentity } from "./process-manager.ts";

describe("rollbackStartedManagedAgentOrThrow", () => {
  it("does not issue an unscoped stop when startup produced no verified identity", async () => {
    const cause = new Error("startup failed");
    let stopCalls = 0;

    await assert.rejects(
      rollbackStartedManagedAgentOrThrow({
        agentName: "browser-use-agent",
        dataDir: "/tmp/roll-agent-start-rollback-test",
        expectedIdentity: undefined,
        lifecycleLock: createLifecycleLock(),
        cause,
        rollbackFailureMessage: "rollback failed",
        stopGracefully: async () => {
          stopCalls += 1;
          return true;
        },
      }),
      cause,
    );

    assert.equal(stopCalls, 0);
  });

  it("stops only the verified runtime and rethrows the startup failure", async () => {
    const cause = new Error("startup failed");
    const identity = createRuntimeIdentity(321);
    let stoppedIdentity: ManagedAgentRuntimeIdentity | undefined;

    await assert.rejects(
      rollbackStartedManagedAgentOrThrow({
        agentName: "browser-use-agent",
        dataDir: "/tmp/roll-agent-start-rollback-test",
        expectedIdentity: identity,
        lifecycleLock: createLifecycleLock(),
        cause,
        rollbackFailureMessage: "rollback failed",
        stopGracefully: async (_dataDir, _agentName, options) => {
          stoppedIdentity = options?.expectedIdentity;
          return true;
        },
      }),
      cause,
    );

    assert.deepEqual(stoppedIdentity, identity);
  });

  it("keeps the startup failure when the scoped target has already disappeared", async () => {
    const cause = new Error("startup failed");

    await assert.rejects(
      rollbackStartedManagedAgentOrThrow({
        agentName: "browser-use-agent",
        dataDir: "/tmp/roll-agent-start-rollback-test",
        expectedIdentity: createRuntimeIdentity(432),
        lifecycleLock: createLifecycleLock(),
        cause,
        rollbackFailureMessage: "rollback failed",
        stopGracefully: async () => false,
      }),
      cause,
    );
  });

  it("keeps both startup and rollback failures when the scoped stop throws", async () => {
    const cause = new Error("startup failed");
    const cleanupError = new Error("stop failed");

    await assert.rejects(
      rollbackStartedManagedAgentOrThrow({
        agentName: "browser-use-agent",
        dataDir: "/tmp/roll-agent-start-rollback-test",
        expectedIdentity: createRuntimeIdentity(654),
        lifecycleLock: createLifecycleLock(),
        cause,
        rollbackFailureMessage: "rollback failed",
        stopGracefully: async () => {
          throw cleanupError;
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.message, "rollback failed");
        assert.deepEqual(error.errors, [cause, cleanupError]);
        return true;
      },
    );
  });
});

function createLifecycleLock(): AgentLifecycleLock {
  return {
    release: () => {},
  };
}

function createRuntimeIdentity(pid: number): ManagedAgentRuntimeIdentity {
  return {
    pid,
    processStartToken: createProcessStartToken(),
    startedAt: "2026-07-24T00:00:00.000Z",
  };
}

function createProcessStartToken(): ProcessStartToken {
  const token = `pst-v2:${"0".repeat(64)}`;
  if (!isProcessStartToken(token)) {
    throw new Error("invalid test process-start token");
  }
  return token;
}
