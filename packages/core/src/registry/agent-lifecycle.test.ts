import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ConfigActivationEffect } from "../config/application-service.ts";
import { DEFAULT_CONFIG } from "../config/defaults.ts";
import type { RollConfig } from "../config/schema.ts";
import type { AgentRuntimeOwnership, AgentStatus, RegisteredAgent } from "../types/agent.ts";
import {
  AgentLifecycleService,
  type AgentLifecycleCollaborators,
  type AgentLifecycleRuntimeIdentity,
} from "./agent-lifecycle.ts";
import { isProcessStartToken, type ProcessStartToken } from "./process-identity.ts";
import { getRollCoreVersion } from "./process-manager.ts";

describe("AgentLifecycleService.inspectAll", () => {
  it("distinguishes on-demand, core-managed, and external-managed status without starting agents", async () => {
    const agents = [
      createAgent("smart-reply-agent", "on-demand"),
      createAgent("browser-use-agent", "core-managed"),
      createAgent("offline-core-agent", "core-managed"),
      createAgent("stopped-agent", "core-managed"),
      createAgent(
        "external-agent",
        "external-managed",
        "https://user:secret@example.com/mcp?token=private#fragment",
      ),
      createAgent("offline-external-agent", "external-managed"),
    ];
    const harness = createHarness(agents, {
      "browser-use-agent": 101,
      "offline-core-agent": 202,
    });
    harness.probeFailures.add("offline-external-agent");
    harness.probeFailures.add("offline-core-agent");
    const service = new AgentLifecycleService("/roll-data", harness.collaborators);

    const inspections = await service.inspectAll({ probeTimeoutMs: 321 });

    assert.equal(findInspection(inspections, "smart-reply-agent").state, "ready-on-demand");
    assert.equal(findInspection(inspections, "stopped-agent").state, "stopped");
    assert.equal(findInspection(inspections, "external-agent").state, "external-online");
    assert.equal(
      findInspection(inspections, "offline-external-agent").state,
      "external-unreachable",
    );
    assert.equal(findInspection(inspections, "offline-core-agent").state, "unreachable");

    const browser = findInspection(inspections, "browser-use-agent");
    assert.equal(browser.state, "running");
    assert.equal(browser.pid, 101);
    assert.equal(browser.browserRuntime?.state, "not-inspected");
    assert.match(browser.message, /不代表 Chrome 已启动/);
    assert.match(browser.browserRuntime?.message ?? "", /首次浏览器工具调用/);

    assert.equal(findInspection(inspections, "external-agent").endpoint, "https://example.com/mcp");
    assert.doesNotMatch(
      findInspection(inspections, "offline-external-agent").message,
      /probe-secret/u,
    );
    assert.doesNotMatch(findInspection(inspections, "offline-core-agent").message, /probe-secret/u);

    assert.deepEqual(harness.probeCalls.map((call) => call.agentName).sort(), [
      "browser-use-agent",
      "external-agent",
      "offline-core-agent",
      "offline-external-agent",
    ]);
    assert.ok(harness.probeCalls.every((call) => call.timeoutMs === 321));
    assert.equal(harness.startCalls.length, 0);
    assert.equal(harness.stopCalls.length, 0);
  });

  it("marks an unverifiable core-managed runtime as unsafe for automatic restart", async () => {
    const agent = createAgent("notify-agent", "core-managed");
    const harness = createHarness([agent], { "notify-agent": 101 });
    harness.unverifiableRuntimeIdentities.add(agent.skill.name);
    const service = new AgentLifecycleService("/roll-data", harness.collaborators);

    const inspection = findInspection(await service.inspectAll(), agent.skill.name);

    assert.equal(inspection.state, "unreachable");
    assert.equal(inspection.endpointReachable, null);
    assert.equal(inspection.canAutoRestart, false);
    assert.match(inspection.message, /runtime 身份无法安全验证/u);
    assert.equal(harness.probeCalls.length, 0);
  });
});

describe("AgentLifecycleService.applyActivation", () => {
  it("only restarts core-managed agents that were running before save", async () => {
    const agents = [
      createAgent("notify-agent", "core-managed"),
      createAgent("stopped-agent", "core-managed"),
      createAgent("smart-reply-agent", "on-demand"),
      createAgent("external-agent", "external-managed"),
    ];
    const harness = createHarness(agents, { "notify-agent": 101 });
    const service = new AgentLifecycleService("/roll-data", harness.collaborators);
    const baseline = service.captureBaseline();
    const effects = [
      restartEffect("notify-agent"),
      restartEffect("notify-agent"),
      restartEffect("stopped-agent"),
      restartEffect("smart-reply-agent"),
      restartEffect("external-agent"),
      nextCommandEffect(),
    ];
    const config = configWithAgentEnv("notify-agent", { TOKEN: "new-value" });

    const result = await service.applyActivation(effects, baseline, config);

    assert.equal(result.success, true);
    assert.equal(result.requiresManualAction, true);
    assert.deepEqual(result.restartedAgentNames, ["notify-agent"]);
    assert.equal(findResult(result.items, "notify-agent").status, "restarted");
    assert.equal(findResult(result.items, "stopped-agent").status, "kept-stopped");
    assert.equal(findResult(result.items, "smart-reply-agent").status, "next-invocation");
    assert.equal(findResult(result.items, "external-agent").status, "manual");
    assert.equal(result.items.filter((item) => item.effect.agentName === "notify-agent").length, 1);

    assert.deepEqual(harness.stopCalls, ["notify-agent"]);
    assert.deepEqual(harness.stopRequests, [{ agentName: "notify-agent", expectedPid: 101 }]);
    assert.deepEqual(harness.startCalls, [
      {
        agentName: "notify-agent",
        dataDir: "/roll-data",
        env: { TOKEN: "new-value" },
      },
    ]);
    assert.deepEqual(harness.waitCalls, ["notify-agent"]);
    assert.deepEqual(harness.statusCalls, [
      { agentName: "notify-agent", status: "starting" },
      { agentName: "notify-agent", status: "online" },
    ]);
  });

  it("blocks automatic restarts when agents.dataDir requires manual migration", async () => {
    const agent = createAgent("notify-agent", "core-managed");
    const harness = createHarness([agent], { "notify-agent": 101 });
    const service = new AgentLifecycleService("/roll-data", harness.collaborators);
    const baseline = service.captureBaseline();

    const result = await service.applyActivation(
      [dataDirMigrationEffect(), restartEffect("notify-agent")],
      baseline,
      DEFAULT_CONFIG,
    );

    assert.equal(result.success, true);
    assert.equal(result.requiresManualAction, true);
    assert.equal(findResult(result.items, "notify-agent").status, "manual");
    assert.match(findResult(result.items, "notify-agent").message, /人工迁移/);
    assert.equal(harness.stopCalls.length, 0);
    assert.equal(harness.startCalls.length, 0);
  });

  it("does not stop a replacement process when the pid changed after capture", async () => {
    const agent = createAgent("notify-agent", "core-managed");
    const harness = createHarness([agent], { "notify-agent": 101 });
    const service = new AgentLifecycleService("/roll-data", harness.collaborators);
    const baseline = service.captureBaseline();
    harness.pids.set("notify-agent", 202);

    const result = await service.applyActivation(
      [restartEffect("notify-agent")],
      baseline,
      DEFAULT_CONFIG,
    );

    assert.equal(result.success, true);
    assert.equal(result.requiresManualAction, true);
    assert.equal(result.items[0]?.status, "runtime-changed");
    assert.equal(harness.stopCalls.length, 0);
    assert.equal(harness.startCalls.length, 0);
  });

  it("does not stop a process when its verified runtime sidecar changes after capture", async () => {
    const agent = createAgent("notify-agent", "core-managed");
    const harness = createHarness([agent], { "notify-agent": 101 });
    const service = new AgentLifecycleService("/roll-data", harness.collaborators);
    const baseline = service.captureBaseline();
    harness.runtimeStartedAt.set("notify-agent", "2026-07-14T12:00:00.000Z");

    const result = await service.applyActivation(
      [restartEffect("notify-agent")],
      baseline,
      DEFAULT_CONFIG,
    );

    assert.equal(result.items[0]?.status, "runtime-changed");
    assert.match(result.items[0]?.message ?? "", /runtime sidecar/u);
    assert.equal(harness.stopCalls.length, 0);
    assert.equal(harness.startCalls.length, 0);
  });

  it("does not stop a replacement process that appears between the final pid check and stop", async () => {
    const agent = createAgent("notify-agent", "core-managed");
    const harness = createHarness([agent], { "notify-agent": 101 });
    const service = new AgentLifecycleService("/roll-data", harness.collaborators);
    const baseline = service.captureBaseline();
    harness.pidReplacementOnNextStop.set("notify-agent", 202);

    const result = await service.applyActivation(
      [restartEffect("notify-agent")],
      baseline,
      DEFAULT_CONFIG,
    );

    assert.equal(result.items[0]?.status, "runtime-changed");
    assert.equal(harness.pids.get("notify-agent"), 202);
    assert.deepEqual(harness.stopRequests, [{ agentName: "notify-agent", expectedPid: 101 }]);
    assert.equal(harness.startCalls.length, 0);
  });

  it("cleans up a newly started process and returns a structured failure when readiness fails", async () => {
    const agent = createAgent("browser-use-agent", "core-managed");
    const harness = createHarness([agent], { "browser-use-agent": 101 });
    harness.waitFailures.add("browser-use-agent");
    const service = new AgentLifecycleService("/roll-data", harness.collaborators);
    const baseline = service.captureBaseline();

    const result = await service.applyActivation(
      [restartEffect("browser-use-agent")],
      baseline,
      DEFAULT_CONFIG,
    );

    assert.equal(result.success, false);
    assert.equal(result.requiresManualAction, true);
    assert.equal(result.items[0]?.status, "failed");
    assert.match(result.items[0]?.message ?? "", /检查 Agent 日志/u);
    assert.doesNotMatch(result.items[0]?.message ?? "", /readiness failed/u);
    assert.deepEqual(harness.stopCalls, ["browser-use-agent", "browser-use-agent"]);
    assert.deepEqual(harness.stopRequests, [
      { agentName: "browser-use-agent", expectedPid: 101 },
      { agentName: "browser-use-agent", expectedPid: 1_001 },
    ]);
    assert.equal(harness.pids.has("browser-use-agent"), false);
    assert.deepEqual(harness.statusCalls, [
      { agentName: "browser-use-agent", status: "starting" },
      { agentName: "browser-use-agent", status: "error" },
    ]);
  });

  it("does not stop a newly started pid when its sidecar changes before failure cleanup", async () => {
    const agent = createAgent("browser-use-agent", "core-managed");
    const harness = createHarness([agent], { "browser-use-agent": 101 });
    harness.waitFailures.add("browser-use-agent");
    harness.replaceRuntimeIdentityOnWaitFailure.add("browser-use-agent");
    const service = new AgentLifecycleService("/roll-data", harness.collaborators);
    const baseline = service.captureBaseline();

    const result = await service.applyActivation(
      [restartEffect("browser-use-agent")],
      baseline,
      DEFAULT_CONFIG,
    );

    assert.equal(result.items[0]?.status, "failed");
    assert.deepEqual(harness.stopCalls, ["browser-use-agent"]);
    assert.equal(harness.pids.get("browser-use-agent"), 1_001);
  });

  it("does not start an explicitly restarted core-managed agent that is stopped", async () => {
    const agent = createAgent("notify-agent", "core-managed");
    const harness = createHarness([agent], {});
    const service = new AgentLifecycleService("/roll-data", harness.collaborators);

    const result = await service.restartRunningAgent("notify-agent", DEFAULT_CONFIG);

    assert.equal(result.status, "kept-stopped");
    assert.equal(harness.startCalls.length, 0);
  });

  it("does not signal an unrelated live pid when its runtime sidecar is missing or mismatched", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roll-lifecycle-unrelated-pid-"));
    const agent = createAgent("notify-agent", "core-managed");
    const child = spawn(
      process.execPath,
      ["-e", "process.send?.('ready');setInterval(()=>{},1000)"],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    let stopCalls = 0;
    try {
      await once(child, "message");
      assert.ok(child.pid);
      const pidDir = join(dataDir, "pids");
      mkdirSync(pidDir, { recursive: true });
      writeFileSync(join(pidDir, `${agent.skill.name}.pid`), String(child.pid), "utf-8");

      const collaborators: Partial<AgentLifecycleCollaborators> = {
        readAgents: () => [agent],
        stopGracefully: async () => {
          stopCalls += 1;
          return true;
        },
      };

      const missingSidecarService = new AgentLifecycleService(dataDir, collaborators);
      const missingResult = await missingSidecarService.applyActivation(
        [restartEffect(agent.skill.name)],
        missingSidecarService.captureBaseline(),
        DEFAULT_CONFIG,
      );
      assert.equal(missingResult.items[0]?.status, "runtime-changed");

      writeFileSync(
        join(pidDir, `${agent.skill.name}.runtime.json`),
        `${JSON.stringify({
          schemaVersion: 1,
          agentName: "unrelated-agent",
          pid: child.pid,
          coreVersion: getRollCoreVersion(),
          startedAt: new Date(0).toISOString(),
          endpoint:
            agent.transport.type === "streamable-http" ? agent.transport.endpoint : undefined,
        })}\n`,
        "utf-8",
      );
      const mismatchedSidecarService = new AgentLifecycleService(dataDir, collaborators);
      const mismatchedResult = await mismatchedSidecarService.applyActivation(
        [restartEffect(agent.skill.name)],
        mismatchedSidecarService.captureBaseline(),
        DEFAULT_CONFIG,
      );
      assert.equal(mismatchedResult.items[0]?.status, "runtime-changed");

      assert.equal(stopCalls, 0);
      assert.doesNotThrow(() => process.kill(child.pid ?? 0, 0));
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

interface Harness {
  readonly collaborators: AgentLifecycleCollaborators;
  readonly pids: Map<string, number>;
  readonly probeFailures: Set<string>;
  readonly waitFailures: Set<string>;
  readonly unverifiableRuntimeIdentities: Set<string>;
  readonly replaceRuntimeIdentityOnWaitFailure: Set<string>;
  readonly probeCalls: Array<{ readonly agentName: string; readonly timeoutMs?: number }>;
  readonly startCalls: Array<{
    readonly agentName: string;
    readonly dataDir: string;
    readonly env?: Readonly<Record<string, string>>;
  }>;
  readonly stopCalls: string[];
  readonly stopRequests: Array<{ readonly agentName: string; readonly expectedPid?: number }>;
  readonly pidReplacementOnNextStop: Map<string, number>;
  readonly runtimeProcessStartTokens: Map<string, ProcessStartToken>;
  readonly runtimeStartedAt: Map<string, string>;
  readonly waitCalls: string[];
  readonly statusCalls: Array<{ readonly agentName: string; readonly status: AgentStatus }>;
}

function createHarness(
  agents: readonly RegisteredAgent[],
  initialPids: Readonly<Record<string, number>>,
): Harness {
  const pids = new Map(Object.entries(initialPids));
  const probeFailures = new Set<string>();
  const waitFailures = new Set<string>();
  const unverifiableRuntimeIdentities = new Set<string>();
  const replaceRuntimeIdentityOnWaitFailure = new Set<string>();
  const probeCalls: Harness["probeCalls"] = [];
  const startCalls: Harness["startCalls"] = [];
  const stopCalls: string[] = [];
  const stopRequests: Harness["stopRequests"] = [];
  const pidReplacementOnNextStop = new Map<string, number>();
  const runtimeProcessStartTokens = new Map(
    agents.map((agent, index) => [agent.skill.name, testProcessStartToken(index + 1)] as const),
  );
  const runtimeStartedAt = new Map(
    agents.map((agent) => [agent.skill.name, new Date(0).toISOString()] as const),
  );
  const waitCalls: string[] = [];
  const statusCalls: Harness["statusCalls"] = [];
  let nextPid = 1_000;

  return {
    pids,
    probeFailures,
    waitFailures,
    unverifiableRuntimeIdentities,
    replaceRuntimeIdentityOnWaitFailure,
    probeCalls,
    startCalls,
    stopCalls,
    stopRequests,
    pidReplacementOnNextStop,
    runtimeProcessStartTokens,
    runtimeStartedAt,
    waitCalls,
    statusCalls,
    collaborators: {
      readAgents: () => agents,
      updateStatus: (_dataDir, agentName, status) => {
        statusCalls.push({ agentName, status });
      },
      getPid: (_dataDir, agentName) => pids.get(agentName),
      inspectRuntime: (agent) => {
        const pid = pids.get(agent.skill.name);
        const expectedEndpoint =
          agent.transport.type === "streamable-http" ? agent.transport.endpoint : undefined;
        const expectedCoreVersion = "test-core";
        return {
          ...(pid !== undefined
            ? {
                pid,
                sidecar: {
                  schemaVersion: 2,
                  agentName: agent.skill.name,
                  pid,
                  processStartToken:
                    runtimeProcessStartTokens.get(agent.skill.name) ?? testProcessStartToken(0),
                  coreVersion: expectedCoreVersion,
                  startedAt: runtimeStartedAt.get(agent.skill.name) ?? new Date(0).toISOString(),
                  ...(expectedEndpoint !== undefined ? { endpoint: expectedEndpoint } : {}),
                },
              }
            : {}),
          expectedCoreVersion,
          ...(expectedEndpoint !== undefined ? { expectedEndpoint } : {}),
          issues: unverifiableRuntimeIdentities.has(agent.skill.name)
            ? [
                {
                  code: "process-identity-mismatch" as const,
                  message: "runtime identity mismatch",
                  fix: "manual",
                },
              ]
            : [],
        };
      },
      probe: async (agent, options) => {
        probeCalls.push({
          agentName: agent.skill.name,
          ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
        if (probeFailures.has(agent.skill.name)) {
          throw new Error("endpoint unavailable: probe-secret");
        }
      },
      start: (agent, dataDir, env) => {
        nextPid += 1;
        pids.set(agent.skill.name, nextPid);
        runtimeProcessStartTokens.set(agent.skill.name, testProcessStartToken(nextPid));
        startCalls.push({
          agentName: agent.skill.name,
          dataDir,
          ...(env !== undefined ? { env } : {}),
        });
        return nextPid;
      },
      stopGracefully: async (_dataDir, agentName, options) => {
        stopCalls.push(agentName);
        stopRequests.push({
          agentName,
          ...(options?.expectedIdentity !== undefined
            ? { expectedPid: options.expectedIdentity.pid }
            : {}),
        });
        const replacementPid = pidReplacementOnNextStop.get(agentName);
        if (replacementPid !== undefined) {
          pids.set(agentName, replacementPid);
          runtimeProcessStartTokens.set(agentName, testProcessStartToken(replacementPid));
          pidReplacementOnNextStop.delete(agentName);
        }
        if (
          options?.expectedIdentity !== undefined &&
          !sameHarnessRuntimeIdentity(
            options.expectedIdentity,
            pids.get(agentName),
            runtimeProcessStartTokens.get(agentName),
            runtimeStartedAt.get(agentName),
          )
        ) {
          return false;
        }
        const stopped = pids.delete(agentName);
        if (stopped) runtimeProcessStartTokens.delete(agentName);
        return stopped;
      },
      waitUntilReady: async (agent) => {
        waitCalls.push(agent.skill.name);
        if (waitFailures.has(agent.skill.name)) {
          if (replaceRuntimeIdentityOnWaitFailure.has(agent.skill.name)) {
            runtimeStartedAt.set(agent.skill.name, "2026-07-14T12:00:00.000Z");
          }
          throw new Error("readiness failed");
        }
      },
      resolveAgentEnv: (config, agentName) => config.agents.env?.[agentName],
      acquireLifecycleLock: () => ({ release: () => {} }),
    },
  };
}

function testProcessStartToken(seed: number): ProcessStartToken {
  const token = `pst-v1:${seed.toString(16).padStart(64, "0")}`;
  assert.ok(isProcessStartToken(token));
  return token;
}

function sameHarnessRuntimeIdentity(
  expected: AgentLifecycleRuntimeIdentity,
  pid: number | undefined,
  processStartToken: ProcessStartToken | undefined,
  startedAt: string | undefined,
): boolean {
  return (
    pid === expected.pid &&
    processStartToken === expected.processStartToken &&
    startedAt === expected.startedAt
  );
}

function createAgent(
  name: string,
  ownership: AgentRuntimeOwnership,
  endpoint = `http://127.0.0.1/${name}`,
): RegisteredAgent {
  const shared = {
    skill: { name, description: `${name} test fixture`, metadata: {} },
    installPath: `/agents/${name}`,
    registeredAt: new Date(0).toISOString(),
    status: "stopped" as const,
  };
  switch (ownership) {
    case "on-demand":
      return {
        ...shared,
        transport: { type: "stdio", command: "node", args: ["dist/index.js"] },
        runtime: { ownership },
      };
    case "external-managed":
      return {
        ...shared,
        transport: { type: "streamable-http", endpoint },
        runtime: { ownership },
      };
    case "core-managed":
      return {
        ...shared,
        transport: { type: "streamable-http", endpoint },
        runtime: {
          ownership,
          start: { command: "node", args: ["dist/index.js"] },
          endpoint: { path: `/${name}`, port: 3_100 },
        },
      };
  }
}

function restartEffect(agentName: string): ConfigActivationEffect {
  return {
    kind: "restart-agent",
    paths: [["agents", "env", agentName]],
    title: `重启 ${agentName}`,
    description: "Agent 启动参数已变更。",
    agentName,
    requiresConfirmation: true,
  };
}

function nextCommandEffect(): ConfigActivationEffect {
  return {
    kind: "next-command",
    paths: [["llm", "defaultModel"]],
    title: "后续命令生效",
    description: "后续命令重新加载配置。",
    requiresConfirmation: false,
  };
}

function dataDirMigrationEffect(): ConfigActivationEffect {
  return {
    kind: "manual",
    paths: [["agents", "dataDir"]],
    title: "Agent 数据目录需要人工迁移",
    description: "保存不会搬迁旧 PID、日志或注册数据。",
    requiresConfirmation: true,
  };
}

function configWithAgentEnv(agentName: string, env: Readonly<Record<string, string>>): RollConfig {
  return {
    ...DEFAULT_CONFIG,
    agents: {
      ...DEFAULT_CONFIG.agents,
      env: { [agentName]: env },
    },
  };
}

function findInspection(
  inspections: Awaited<ReturnType<AgentLifecycleService["inspectAll"]>>,
  agentName: string,
) {
  const inspection = inspections.find((item) => item.agentName === agentName);
  assert.ok(inspection, `missing inspection for ${agentName}`);
  return inspection;
}

function findResult(
  items: Awaited<ReturnType<AgentLifecycleService["applyActivation"]>>["items"],
  agentName: string,
) {
  const item = items.find((candidate) => candidate.effect.agentName === agentName);
  assert.ok(item, `missing activation result for ${agentName}`);
  return item;
}
