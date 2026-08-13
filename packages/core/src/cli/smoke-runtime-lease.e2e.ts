import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  CURRENT_CORE_VERSION,
  runRoll,
  spawnRollProcess,
  formatSpawnedRollProcess,
  waitForSmokeCondition,
  waitForSpawnedRollExit,
  exitRollChat,
  cleanupSpawnedRollProcess,
  countAgentUsageLeaseFiles,
  readAgentPidFile,
  isProcessAlive,
  forceKillProcess,
  getFreeLocalPort,
  readHttpFixtureAgentLog,
  createFakeNpm,
  createCoreManagedHttpFixtureAgent,
  type SpawnedRollProcess,
} from "./smoke.e2e-harness.ts";

test(
  "e2e smoke: independent chats share a lease-bound HTTP Agent and unblock update on exit",
  {
    timeout: 180_000,
  },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-chat-leases-${randomUUID()}-`));
    const agentDir = resolve(workspace, "http-fixture-agent");
    const dataDir = resolve(workspace, "agents-data");
    const threadsDir = resolve(workspace, "threads");
    const fakeBinDir = resolve(workspace, "fake-bin");
    let firstChat: SpawnedRollProcess | undefined;
    let secondChat: SpawnedRollProcess | undefined;

    try {
      const port = await getFreeLocalPort();
      createCoreManagedHttpFixtureAgent(agentDir, port, { createBrokenDistEntry: true });
      createFakeNpm(fakeBinDir, CURRENT_CORE_VERSION);
      writeFileSync(
        resolve(workspace, "roll.config.yaml"),
        `llm:
  default-provider: qwen
  default-model: qwen3.7-plus
  providers:
    qwen:
      api-key: test-key
agents:
  data-dir: ${JSON.stringify(dataDir)}
runtime:
  threads-dir: ${JSON.stringify(threadsDir)}
chat:
  screen-mode: inline
`,
        "utf-8",
      );
      const rollEnv = {
        HOME: workspace,
        USERPROFILE: workspace,
        PATH: `${fakeBinDir}${delimiter}${process.env["PATH"] ?? ""}`,
      };

      const addResult = runRoll(["agent", "add", agentDir], workspace, {
        env: { ...rollEnv, ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(
        addResult.status,
        0,
        `agent add failed\nstdout:\n${addResult.stdout}\nstderr:\n${addResult.stderr}`,
      );

      const first = spawnRollProcess(["chat", "--screen-mode", "inline"], workspace, rollEnv);
      firstChat = first;
      const second = spawnRollProcess(["chat", "--screen-mode", "inline"], workspace, rollEnv);
      secondChat = second;
      const chatDiagnostics = () =>
        [
          `lease files: ${String(countAgentUsageLeaseFiles(dataDir, "http-fixture-agent"))}`,
          `agent PID: ${readAgentPidFile(dataDir, "http-fixture-agent") ?? "<missing>"}`,
          formatSpawnedRollProcess("first roll chat", first),
          formatSpawnedRollProcess("second roll chat", second),
          readHttpFixtureAgentLog(dataDir),
        ].join("\n\n");

      await waitForSmokeCondition(
        "both roll chat processes to acquire usage leases",
        () => {
          if (
            first.child.exitCode !== null ||
            first.child.signalCode !== null ||
            second.child.exitCode !== null ||
            second.child.signalCode !== null
          ) {
            throw new Error(`roll chat exited before acquiring both leases\n${chatDiagnostics()}`);
          }
          return (
            countAgentUsageLeaseFiles(dataDir, "http-fixture-agent") === 2 &&
            readAgentPidFile(dataDir, "http-fixture-agent") !== undefined
          );
        },
        chatDiagnostics,
        45_000,
      );

      const originalPid = readAgentPidFile(dataDir, "http-fixture-agent");
      assert.ok(originalPid, chatDiagnostics());

      await exitRollChat(first, "first roll chat");
      await waitForSmokeCondition(
        "the first chat lease to be released",
        () => countAgentUsageLeaseFiles(dataDir, "http-fixture-agent") === 1,
        chatDiagnostics,
      );
      assert.equal(readAgentPidFile(dataDir, "http-fixture-agent"), originalPid, chatDiagnostics());

      const pingResult = runRoll(["run", "http-fixture-agent", "ping"], workspace, {
        env: rollEnv,
      });
      assert.equal(
        pingResult.status,
        0,
        `second chat should keep the Agent usable\nstdout:\n${pingResult.stdout}\nstderr:\n${pingResult.stderr}\n${chatDiagnostics()}`,
      );
      assert.match(pingResult.stdout, /"ok"\s*:\s*true/u);
      assert.equal(readAgentPidFile(dataDir, "http-fixture-agent"), originalPid, chatDiagnostics());

      writeFileSync(
        resolve(agentDir, "SKILL.md"),
        `---
name: http-fixture-agent
description: Updated while chat lease is active
---

Provides a single ping tool for lifecycle smoke tests after update.
`,
        "utf-8",
      );
      const blockedUpdate = runRoll(["update"], workspace, { env: rollEnv });
      assert.equal(
        blockedUpdate.status,
        1,
        `roll update should fail while a chat lease is active\nstdout:\n${blockedUpdate.stdout}\nstderr:\n${blockedUpdate.stderr}\n${chatDiagnostics()}`,
      );
      assert.match(blockedUpdate.stderr, /尚未修改软件包或注册数据/u);
      assert.match(blockedUpdate.stderr, /正被其他 Roll 进程使用|chat/u);
      assert.equal(readAgentPidFile(dataDir, "http-fixture-agent"), originalPid, chatDiagnostics());

      const listWhileBlocked = runRoll(["agent", "list", "--json"], workspace, { env: rollEnv });
      assert.equal(listWhileBlocked.status, 0, listWhileBlocked.stderr);
      const agentsWhileBlocked = JSON.parse(listWhileBlocked.stdout) as ReadonlyArray<{
        readonly skill: { readonly name: string; readonly description: string };
      }>;
      const agentWhileBlocked = agentsWhileBlocked.find(
        (agent) => agent.skill.name === "http-fixture-agent",
      );
      assert.ok(agentWhileBlocked);
      assert.equal(agentWhileBlocked.skill.description, "Core managed HTTP fixture agent");

      await exitRollChat(second, "second roll chat");
      await waitForSmokeCondition(
        "the final chat lease and lease-bound Agent PID to be removed",
        () =>
          countAgentUsageLeaseFiles(dataDir, "http-fixture-agent") === 0 &&
          readAgentPidFile(dataDir, "http-fixture-agent") === undefined,
        chatDiagnostics,
      );

      const successfulUpdate = runRoll(["update"], workspace, { env: rollEnv });
      assert.equal(
        successfulUpdate.status,
        0,
        `roll update should succeed after all chats exit\nstdout:\n${successfulUpdate.stdout}\nstderr:\n${successfulUpdate.stderr}\n${chatDiagnostics()}`,
      );
      assert.match(successfulUpdate.stderr, /1 个 Agent 已更新|更新完成/u);
      assert.equal(countAgentUsageLeaseFiles(dataDir, "http-fixture-agent"), 0);
      assert.equal(readAgentPidFile(dataDir, "http-fixture-agent"), undefined);

      const listAfterUpdate = runRoll(["agent", "list", "--json"], workspace, { env: rollEnv });
      assert.equal(listAfterUpdate.status, 0, listAfterUpdate.stderr);
      const agentsAfterUpdate = JSON.parse(listAfterUpdate.stdout) as ReadonlyArray<{
        readonly skill: { readonly name: string; readonly description: string };
      }>;
      const agentAfterUpdate = agentsAfterUpdate.find(
        (agent) => agent.skill.name === "http-fixture-agent",
      );
      assert.ok(agentAfterUpdate);
      assert.equal(agentAfterUpdate.skill.description, "Updated while chat lease is active");
    } finally {
      await cleanupSpawnedRollProcess(firstChat, "first roll chat");
      await cleanupSpawnedRollProcess(secondChat, "second roll chat");
      runRoll(["agent", "stop", "http-fixture-agent"], workspace, {
        env: {
          HOME: workspace,
          USERPROFILE: workspace,
          PATH: `${fakeBinDir}${delimiter}${process.env["PATH"] ?? ""}`,
        },
      });
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "e2e smoke: failed agent start keeps a runtime leased by a concurrent chat",
  {
    timeout: 180_000,
  },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-start-chat-race-${randomUUID()}-`));
    const agentDir = resolve(workspace, "http-fixture-agent");
    const dataDir = resolve(workspace, "agents-data");
    const threadsDir = resolve(workspace, "threads");
    let startProcess: SpawnedRollProcess | undefined;
    let chat: SpawnedRollProcess | undefined;
    let agentPid: number | undefined;

    try {
      const port = await getFreeLocalPort();
      createCoreManagedHttpFixtureAgent(agentDir, port, {
        startupDelayMs: 30_000,
        createBrokenDistEntry: true,
      });
      writeFileSync(
        resolve(workspace, "roll.config.yaml"),
        `llm:
  default-provider: qwen
  default-model: qwen3.7-plus
  providers:
    qwen:
      api-key: test-key
agents:
  data-dir: ${JSON.stringify(dataDir)}
runtime:
  threads-dir: ${JSON.stringify(threadsDir)}
chat:
  screen-mode: inline
`,
        "utf-8",
      );
      const rollEnv = {
        HOME: workspace,
        USERPROFILE: workspace,
      };

      const addResult = runRoll(["agent", "add", agentDir], workspace, {
        env: { ...rollEnv, ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(
        addResult.status,
        0,
        `agent add failed\nstdout:\n${addResult.stdout}\nstderr:\n${addResult.stderr}`,
      );

      const spawnedStart = spawnRollProcess(
        ["agent", "start", "http-fixture-agent"],
        workspace,
        rollEnv,
      );
      startProcess = spawnedStart;
      const diagnostics = () =>
        [
          `lease files: ${String(countAgentUsageLeaseFiles(dataDir, "http-fixture-agent"))}`,
          `agent PID: ${readAgentPidFile(dataDir, "http-fixture-agent") ?? "<missing>"}`,
          formatSpawnedRollProcess("roll agent start", spawnedStart),
          ...(chat === undefined ? [] : [formatSpawnedRollProcess("roll chat", chat)]),
          readHttpFixtureAgentLog(dataDir),
        ].join("\n\n");

      await waitForSmokeCondition(
        "roll agent start to spawn its persistent runtime",
        () => {
          if (spawnedStart.child.exitCode !== null || spawnedStart.child.signalCode !== null) {
            throw new Error(`roll agent start exited before spawning\n${diagnostics()}`);
          }
          return readAgentPidFile(dataDir, "http-fixture-agent") !== undefined;
        },
        diagnostics,
      );

      const agentPidText = readAgentPidFile(dataDir, "http-fixture-agent");
      assert.ok(agentPidText, diagnostics());
      agentPid = Number(agentPidText);
      assert.ok(Number.isSafeInteger(agentPid) && agentPid > 0, diagnostics());

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5_000);
      });

      const spawnedChat = spawnRollProcess(["chat", "--screen-mode", "inline"], workspace, rollEnv);
      chat = spawnedChat;
      await waitForSmokeCondition(
        "roll chat to lease the still-starting runtime",
        () => {
          if (spawnedStart.child.exitCode !== null || spawnedStart.child.signalCode !== null) {
            throw new Error(
              `roll agent start exited before chat acquired its lease\n${diagnostics()}`,
            );
          }
          if (spawnedChat.child.exitCode !== null || spawnedChat.child.signalCode !== null) {
            throw new Error(`roll chat exited before acquiring its lease\n${diagnostics()}`);
          }
          return countAgentUsageLeaseFiles(dataDir, "http-fixture-agent") === 1;
        },
        diagnostics,
      );

      const startExit = await waitForSpawnedRollExit(spawnedStart, "roll agent start", 30_000);
      assert.equal(startExit.code, 1, diagnostics());
      assert.match(spawnedStart.output.stderr, /did not become ready within 15000ms/u);
      assert.match(
        spawnedStart.output.stderr,
        /启动探活失败，但 Agent 正被其他 Roll 使用，因此未停止/u,
      );
      assert.equal(countAgentUsageLeaseFiles(dataDir, "http-fixture-agent"), 1, diagnostics());
      assert.equal(readAgentPidFile(dataDir, "http-fixture-agent"), agentPidText, diagnostics());
      assert.equal(isProcessAlive(agentPid), true, diagnostics());

      await cleanupSpawnedRollProcess(spawnedChat, "roll chat");
      const stopResult = runRoll(["agent", "stop", "http-fixture-agent"], workspace, {
        env: rollEnv,
      });
      assert.equal(
        stopResult.status,
        0,
        `agent stop failed after chat exit\nstdout:\n${stopResult.stdout}\nstderr:\n${stopResult.stderr}\n${diagnostics()}`,
      );
      await waitForSmokeCondition(
        "the retained runtime and lease metadata to be removed",
        () =>
          agentPid !== undefined &&
          !isProcessAlive(agentPid) &&
          readAgentPidFile(dataDir, "http-fixture-agent") === undefined &&
          countAgentUsageLeaseFiles(dataDir, "http-fixture-agent") === 0,
        diagnostics,
      );
    } finally {
      await cleanupSpawnedRollProcess(chat, "roll chat");
      await cleanupSpawnedRollProcess(startProcess, "roll agent start");
      runRoll(["agent", "stop", "http-fixture-agent"], workspace, {
        env: {
          HOME: workspace,
          USERPROFILE: workspace,
        },
      });
      if (agentPid !== undefined && isProcessAlive(agentPid)) {
        forceKillProcess(agentPid);
      }
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
