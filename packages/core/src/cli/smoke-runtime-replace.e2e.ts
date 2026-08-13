import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  runRoll,
  spawnRollProcess,
  formatSpawnedRollProcess,
  waitForSmokeCondition,
  exitRollChat,
  cleanupSpawnedRollProcess,
  countAgentUsageLeaseFiles,
  readAgentPidFile,
  isProcessAlive,
  forceKillProcess,
  readAgentRuntimeSnapshot,
  getFreeLocalPort,
  readHttpFixtureAgentLog,
  createCoreManagedHttpFixtureAgent,
  type SpawnedRollProcess,
} from "./smoke.e2e-harness.ts";

test(
  "e2e smoke: an active chat lease blocks replacing a crashed lease-bound HTTP Agent",
  {
    timeout: 180_000,
  },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-chat-crashed-agent-${randomUUID()}-`));
    const agentDir = resolve(workspace, "http-fixture-agent");
    const dataDir = resolve(workspace, "agents-data");
    const threadsDir = resolve(workspace, "threads");
    const runtimePath = resolve(dataDir, "pids", "http-fixture-agent.runtime.json");
    let chat: SpawnedRollProcess | undefined;
    let persistentPid: number | undefined;

    try {
      const port = await getFreeLocalPort();
      createCoreManagedHttpFixtureAgent(agentDir, port, { createBrokenDistEntry: true });
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

      const spawnedChat = spawnRollProcess(["chat", "--screen-mode", "inline"], workspace, rollEnv);
      chat = spawnedChat;
      const diagnostics = () =>
        [
          `lease files: ${String(countAgentUsageLeaseFiles(dataDir, "http-fixture-agent"))}`,
          `agent PID: ${readAgentPidFile(dataDir, "http-fixture-agent") ?? "<missing>"}`,
          formatSpawnedRollProcess("roll chat", spawnedChat),
          readHttpFixtureAgentLog(dataDir),
        ].join("\n\n");

      await waitForSmokeCondition(
        "roll chat to acquire a usage lease and start the HTTP Agent",
        () => {
          if (spawnedChat.child.exitCode !== null || spawnedChat.child.signalCode !== null) {
            throw new Error(`roll chat exited before acquiring its lease\n${diagnostics()}`);
          }
          return (
            countAgentUsageLeaseFiles(dataDir, "http-fixture-agent") === 1 &&
            readAgentPidFile(dataDir, "http-fixture-agent") !== undefined
          );
        },
        diagnostics,
        45_000,
      );

      const leaseBoundPidText = readAgentPidFile(dataDir, "http-fixture-agent");
      assert.ok(leaseBoundPidText, diagnostics());
      const leaseBoundPid = Number(leaseBoundPidText);
      assert.ok(Number.isSafeInteger(leaseBoundPid) && leaseBoundPid > 0, diagnostics());
      const leaseBoundRuntime = readAgentRuntimeSnapshot(dataDir, "http-fixture-agent");
      assert.ok(leaseBoundRuntime, diagnostics());
      assert.equal(leaseBoundRuntime.pid, leaseBoundPid, diagnostics());
      assert.equal(leaseBoundRuntime.retention, "lease-bound", diagnostics());

      forceKillProcess(leaseBoundPid);
      await waitForSmokeCondition(
        "the lease-bound HTTP Agent process to exit while chat remains alive",
        () => {
          if (spawnedChat.child.exitCode !== null || spawnedChat.child.signalCode !== null) {
            throw new Error(`roll chat exited after its Agent crashed\n${diagnostics()}`);
          }
          return (
            !isProcessAlive(leaseBoundPid) &&
            countAgentUsageLeaseFiles(dataDir, "http-fixture-agent") === 1
          );
        },
        diagnostics,
      );

      const blockedStart = runRoll(["agent", "start", "http-fixture-agent"], workspace, {
        env: rollEnv,
      });
      assert.equal(
        blockedStart.status,
        1,
        `agent start should reject an active lease whose runtime crashed\nstdout:\n${blockedStart.stdout}\nstderr:\n${blockedStart.stderr}\n${diagnostics()}`,
      );
      assert.match(blockedStart.stderr, /正被其他 Roll 进程使用|活动 chat/u);
      assert.equal(countAgentUsageLeaseFiles(dataDir, "http-fixture-agent"), 1, diagnostics());
      assert.equal(
        readAgentPidFile(dataDir, "http-fixture-agent"),
        leaseBoundPidText,
        diagnostics(),
      );
      assert.equal(
        readAgentRuntimeSnapshot(dataDir, "http-fixture-agent")?.raw,
        leaseBoundRuntime.raw,
        diagnostics(),
      );
      assert.equal(isProcessAlive(leaseBoundPid), false, diagnostics());

      await exitRollChat(spawnedChat, "roll chat");
      await waitForSmokeCondition(
        "the crashed Agent usage lease to be released",
        () => countAgentUsageLeaseFiles(dataDir, "http-fixture-agent") === 0,
        diagnostics,
      );

      const persistentStart = runRoll(["agent", "start", "http-fixture-agent"], workspace, {
        env: rollEnv,
      });
      assert.equal(
        persistentStart.status,
        0,
        `persistent agent start failed\nstdout:\n${persistentStart.stdout}\nstderr:\n${persistentStart.stderr}\n${diagnostics()}`,
      );
      assert.match(persistentStart.stderr, /已启动/u);

      const persistentPidText = readAgentPidFile(dataDir, "http-fixture-agent");
      assert.ok(persistentPidText, diagnostics());
      persistentPid = Number(persistentPidText);
      assert.ok(Number.isSafeInteger(persistentPid) && persistentPid > 0, diagnostics());
      assert.equal(isProcessAlive(persistentPid), true, diagnostics());
      const persistentRuntime = readAgentRuntimeSnapshot(dataDir, "http-fixture-agent");
      assert.ok(persistentRuntime, diagnostics());
      assert.equal(persistentRuntime.pid, persistentPid);
      assert.equal(persistentRuntime.retention, "persistent");

      const stopResult = runRoll(["agent", "stop", "http-fixture-agent"], workspace, {
        env: rollEnv,
      });
      assert.equal(
        stopResult.status,
        0,
        `agent stop failed\nstdout:\n${stopResult.stdout}\nstderr:\n${stopResult.stderr}\n${diagnostics()}`,
      );
      assert.match(stopResult.stderr, /已停止/u);
      await waitForSmokeCondition(
        "the persistent HTTP Agent to stop and clear runtime metadata",
        () =>
          persistentPid !== undefined &&
          !isProcessAlive(persistentPid) &&
          readAgentPidFile(dataDir, "http-fixture-agent") === undefined &&
          !existsSync(runtimePath),
        diagnostics,
      );
    } finally {
      await cleanupSpawnedRollProcess(chat, "roll chat");
      runRoll(["agent", "stop", "http-fixture-agent"], workspace, {
        env: {
          HOME: workspace,
          USERPROFILE: workspace,
        },
      });
      if (persistentPid !== undefined && isProcessAlive(persistentPid)) {
        forceKillProcess(persistentPid);
      }
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
