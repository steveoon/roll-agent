import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  cleanupSpawnedRollProcess,
  formatSpawnedRollProcess,
  waitForSmokeCondition,
  waitForSpawnedRollExit,
  type SpawnedRollProcess,
} from "./smoke.e2e-harness.ts";

test(
  "e2e smoke: chat cancels background refresh and returns input to its parent shell",
  {
    timeout: 45_000,
  },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), "roll-chat-exit-"));
    const cli = resolve(import.meta.dirname, "index.ts");
    const catalog = resolve(import.meta.dirname, "../../../runtime/src/engine/model-catalog.ts");
    const entry = resolve(workspace, "chat-entry.mts");
    let shell: SpawnedRollProcess | undefined;
    try {
      writeFileSync(
        resolve(workspace, "roll.config.yaml"),
        `llm:
  default-provider: qwen
  default-model: qwen3.7-plus
  providers:
    qwen:
      api-key: test-key
agents:
  data-dir: ${JSON.stringify(resolve(workspace, "agents"))}
runtime:
  threads-dir: ${JSON.stringify(resolve(workspace, "threads"))}
chat:
  screen-mode: inline
`,
      );
      // Model the handle held by an in-flight network refresh. No external request is made.
      // Its safety timer also bounds the pre-fix counterexample if the parent shell is killed.
      writeFileSync(
        entry,
        `import { ModelCatalog } from ${JSON.stringify(pathToFileURL(catalog).href)};
ModelCatalog.prototype.refreshIfStale = async function(signal) {
  process.stderr.write('CATALOG_REFRESH_STARTED\\n');
  return await new Promise(resolve => {
    const safety = setTimeout(() => process.exit(99), 25_000);
    const cancel = () => {
      clearTimeout(safety);
      process.stderr.write('CATALOG_REFRESH_CANCELLED\\n');
      resolve('failed');
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
  });
};
process.argv[1] = ${JSON.stringify(cli)};
await import(${JSON.stringify(pathToFileURL(cli).href)});
`,
      );
      const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
      const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
      const windows = process.platform === "win32";
      const wrapper = resolve(workspace, windows ? "parent.ps1" : "parent.sh");
      writeFileSync(
        wrapper,
        windows
          ? `& ${psQuote(process.execPath)} --experimental-strip-types --experimental-sqlite ${psQuote(entry)} chat --screen-mode inline
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
[Console]::Out.WriteLine('ROLL_SHELL_READY')
$next = [Console]::ReadLine()
[Console]::Out.WriteLine("ROLL_SHELL_INPUT:$next")
`
          : `${quote(process.execPath)} --experimental-strip-types --experimental-sqlite ${quote(entry)} chat --screen-mode inline
code=$?
[ "$code" -eq 0 ] || exit "$code"
printf 'ROLL_SHELL_READY\\n'
IFS= read -r next
printf 'ROLL_SHELL_INPUT:%s\\n' "$next"
`,
      );
      const child = spawn(
        windows ? "powershell.exe" : "/bin/sh",
        windows
          ? [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              wrapper,
            ]
          : [wrapper],
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
      shell = { child, output };
      const diagnostics = () => formatSpawnedRollProcess("parent shell", { child, output });
      await waitForSmokeCondition(
        "chat prompt and background refresh",
        () => {
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(diagnostics());
          return output.stdout.includes("› ") && output.stderr.includes("CATALOG_REFRESH_STARTED");
        },
        diagnostics,
        15_000,
      );
      child.stdin.write("exit\n");
      await waitForSmokeCondition(
        "shell to regain control after chat exit",
        () => {
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(diagnostics());
          return output.stdout.includes("ROLL_SHELL_READY");
        },
        diagnostics,
        5_000,
      );
      assert.match(output.stderr, /CATALOG_REFRESH_CANCELLED/);
      child.stdin.write("next-command\n");
      const result = await waitForSpawnedRollExit({ child, output }, "parent shell", 5_000);
      assert.equal(result.code, 0, diagnostics());
      assert.match(output.stdout, /ROLL_SHELL_INPUT:next-command/);
    } finally {
      await cleanupSpawnedRollProcess(shell, "parent shell");
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
