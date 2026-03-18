import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runRoll(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): CliResult {
  const cliEntry = resolve(import.meta.dirname, "index.ts");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cliEntry, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function buildConfigYaml(dataDir: string): string {
  return `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-20250514
  providers: {}

router:
  mode: declarative

agents:
  data-dir: ${dataDir}
`;
}

test("e2e smoke: register fixture agent and run ping", { timeout: 120_000 }, () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-e2e-${randomUUID()}-`));

  try {
    const smokeAgentPath = resolve(
      import.meta.dirname,
      "../../../../packages/sdk/test-fixtures/smoke-agent",
    );
    const dataDir = resolve(workspace, "agents-data");

    writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

    const addResult = runRoll(["agent", "add", smokeAgentPath], workspace, {
      ROLL_SKIP_INSTALL: "1",
    });
    assert.equal(
      addResult.status,
      0,
      `agent add failed\nstdout:\n${addResult.stdout}\nstderr:\n${addResult.stderr}`,
    );

    const listResult = runRoll(["agent", "list", "--json"], workspace);
    assert.equal(
      listResult.status,
      0,
      `agent list failed\nstdout:\n${listResult.stdout}\nstderr:\n${listResult.stderr}`,
    );

    const listedAgents = JSON.parse(listResult.stdout) as ReadonlyArray<{
      readonly skill: { readonly name: string };
    }>;
    assert.ok(listedAgents.some((agent) => agent.skill.name === "smoke-test-agent"));

    const runResult = runRoll(["run", "smoke-test-agent", "ping"], workspace);
    assert.equal(
      runResult.status,
      0,
      `roll run failed\nstdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`,
    );
    assert.match(runResult.stdout, /"messages"\s*:\s*\[\]/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
