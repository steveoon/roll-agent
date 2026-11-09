import { resolveChatWorkspace } from "../runtime-host/workspace-identity.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import * as runtime from "@roll-agent/runtime";
import { createOwnedThreadStore } from "../runtime-host/session-ownership.ts";
import {
  cleanupSpawnedRollProcess,
  formatSpawnedRollProcess,
  waitForSmokeCondition,
  waitForSpawnedRollExit,
  type SpawnedRollProcess,
} from "./smoke.e2e-harness.ts";

test(
  "real CLI new/last/session hold idle claims; reverse conflict and graceful retry use persisted history",
  { timeout: 60_000 },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), "roll-cli-occupancy-"));
    const threadsDir = resolve(workspace, "threads");
    const cli = resolve(import.meta.dirname, "index.ts");
    const catalog = resolve(import.meta.dirname, "../../../runtime/src/engine/model-catalog.ts");
    const entry = resolve(workspace, "entry.mts");
    const children: SpawnedRollProcess[] = [];
    let store: runtime.ThreadStore | undefined;
    let engine: runtime.ConversationEngine | undefined;
    try {
      writeFileSync(
        resolve(workspace, "roll.config.yaml"),
        `llm:
  default-provider: qwen
  default-model: qwen3.7-plus
  providers:
    qwen:
      api-key: isolated-unused-fixture
agents:
  data-dir: ${JSON.stringify(resolve(workspace, "agents"))}
runtime:
  threads-dir: ${JSON.stringify(threadsDir)}
chat:
  screen-mode: inline
`,
      );
      writeFileSync(
        entry,
        `import { ModelCatalog } from ${JSON.stringify(pathToFileURL(catalog).href)};
ModelCatalog.prototype.refreshIfStale = async function() { return "skipped"; };
globalThis.fetch = async () => { throw new Error("No network allowed in occupancy fixture"); };
process.argv[1] = ${JSON.stringify(cli)};
await import(${JSON.stringify(pathToFileURL(cli).href)});
`,
      );
      const start = (args: string[]) => {
        const child = spawn(
          process.execPath,
          [
            "--experimental-strip-types",
            "--experimental-sqlite",
            entry,
            "chat",
            "--screen-mode",
            "inline",
            ...args,
          ],
          {
            cwd: workspace,
            env: { ...process.env, HOME: workspace, USERPROFILE: workspace, NO_COLOR: "1" },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        const output = { stdout: "", stderr: "" };
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          output.stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          output.stderr += chunk;
        });
        child.stdin.on("error", () => {});
        const spawned = { child, output };
        children.push(spawned);
        return spawned;
      };
      const prompt = async (proc: SpawnedRollProcess) =>
        waitForSmokeCondition(
          "idle CLI prompt",
          () => {
            if (proc.child.exitCode !== null) {
              throw new Error(formatSpawnedRollProcess("CLI", proc));
            }
            return proc.output.stdout.includes("› ");
          },
          () => formatSpawnedRollProcess("CLI", proc),
          15_000,
        );
      const fresh = start([]);
      await prompt(fresh);
      store = createOwnedThreadStore(runtime, threadsDir, "desktop");
      engine = new runtime.ConversationEngine({
        store,
        model: new MockLanguageModelV4({}),
        provider: "mock",
        modelName: "unused",
        settings: runtime.runtimeSettingsSchema.parse({}),
        sources: [],
        skillLibrary: null,
        workspaceInstructions: null,
      });
      const id = store.listThreads()[0]?.id;
      assert.ok(id);
      await assert.rejects(engine.resumeSession(id), runtime.SessionOccupiedError);
      const conflict = start(["--last"]);
      assert.equal((await waitForSpawnedRollExit(conflict, "CLI last conflict", 15_000)).code, 1);
      assert.match(conflict.output.stderr, /两端请选择其一/u);
      fresh.child.stdin.write("exit\n");
      assert.equal((await waitForSpawnedRollExit(fresh, "new CLI exit", 15_000)).code, 0);
      assert.equal(store.hasThread(id), false, "empty new CLI session was safely removed");
      const saved = store.createThread({
        title: "saved",
        workspace: resolveChatWorkspace(workspace),
      });
      store.appendMessages(saved, [{ role: "user", content: "authoritative persisted history" }]);
      const resumed = start(["--last"]);
      await prompt(resumed);
      await assert.rejects(engine.resumeSession(saved), runtime.SessionOccupiedError);
      resumed.child.stdin.write("exit\n");
      assert.equal((await waitForSpawnedRollExit(resumed, "resumed CLI exit", 15_000)).code, 0);
      const desktop = await engine.resumeSession(saved);
      assert.ok(JSON.stringify(desktop.getMessages()).includes("authoritative persisted history"));
      const reverse = start(["--session", saved]);
      assert.equal((await waitForSpawnedRollExit(reverse, "reverse CLI conflict", 15_000)).code, 1);
      assert.match(reverse.output.stderr, /两端请选择其一/u);
      await desktop.close();
      const retry = start(["--session", saved]);
      await prompt(retry);
      retry.child.stdin.write("exit\n");
      assert.equal((await waitForSpawnedRollExit(retry, "CLI retry", 15_000)).code, 0);
    } finally {
      for (const child of children) await cleanupSpawnedRollProcess(child, "occupancy fixture");
      await engine?.dispose();
      store?.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
