import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  CURRENT_CORE_VERSION,
  NEXT_PATCH_CORE_VERSION,
  runRoll,
  getFreeLocalPort,
  formatHttpFixtureStartFailure,
  buildConfigYaml,
  buildDeprecatedConfigYaml,
  createFakeNpm,
  createDefaultRegistryBait,
  createFakeNpmAgentInstaller,
  createCoreManagedHttpFixtureAgent,
} from "./smoke.e2e-harness.ts";

test("e2e smoke: installed-package rename is rejected and its directory is rolled back", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-update-package-rename-${randomUUID()}-`));
  const fakeBinDir = resolve(workspace, "fake-bin");
  const dataDir = resolve(workspace, "agents-data");
  const installDir = resolve(workspace, "installed-agent");
  const packageName = "@roll-agent/browser-use-agent";
  const packageRoot = resolve(installDir, "node_modules/@roll-agent/browser-use-agent");
  const installLogPath = resolve(workspace, "fake-npm-install.log");

  try {
    createFakeNpmAgentInstaller(fakeBinDir, {
      packageName,
      oldVersion: "0.15.0",
      latestVersion: "0.20.0",
      coreVersion: CURRENT_CORE_VERSION,
      installLogPath,
      installedAgentName: "renamed-browser-use-agent",
    });
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `agents:
  data-dir: ${JSON.stringify(dataDir)}
`,
      "utf-8",
    );
    writeFileSync(
      resolve(packageRoot, "package.json"),
      JSON.stringify({
        name: packageName,
        version: "0.15.0",
        type: "module",
        rollAgent: {
          runtime: { ownership: "on-demand", transport: "stdio" },
          start: { command: "node", args: ["dist/index.js"] },
        },
      }),
      "utf-8",
    );
    writeFileSync(
      resolve(packageRoot, "SKILL.md"),
      "---\nname: browser-use-agent\ndescription: Browser automation agent\n---\n",
      "utf-8",
    );
    writeFileSync(
      resolve(dataDir, "agents.json"),
      JSON.stringify(
        {
          schemaVersion: 2,
          agents: [
            {
              skill: {
                name: "browser-use-agent",
                description: "Browser automation agent",
                metadata: {},
              },
              transport: { type: "stdio", command: "node" },
              runtime: { ownership: "on-demand" },
              installPath: packageRoot,
              registeredAt: "2026-01-01T00:00:00.000Z",
              status: "idle",
              source: {
                type: "installed-package",
                packageName,
                packageSpec: `${packageName}@latest`,
                installDir,
                installedVersion: "0.15.0",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = runRoll(["update"], workspace, {
      env: {
        HOME: workspace,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
      },
    });

    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /Agent "browser-use-agent" 更新后的名称变为 "renamed-browser-use-agent"/u,
    );
    assert.doesNotMatch(result.stderr, /Invalid Agent lifecycle lock handle/u);

    const restoredManifest = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf-8"),
    ) as { readonly version?: unknown };
    assert.equal(restoredManifest.version, "0.15.0");
    assert.match(
      readFileSync(resolve(packageRoot, "SKILL.md"), "utf-8"),
      /name: browser-use-agent/u,
    );

    const stored = JSON.parse(readFileSync(resolve(dataDir, "agents.json"), "utf-8")) as {
      readonly agents?: ReadonlyArray<{
        readonly skill?: { readonly name?: unknown };
        readonly source?: { readonly installedVersion?: unknown };
      }>;
    };
    assert.equal(stored.agents?.[0]?.skill?.name, "browser-use-agent");
    assert.equal(stored.agents?.[0]?.source?.installedVersion, "0.15.0");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: update warns after self-update when config needs migration", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-update-router-${randomUUID()}-`));

  try {
    const fakeBinDir = resolve(workspace, "fake-bin");
    createFakeNpm(fakeBinDir, NEXT_PATCH_CORE_VERSION);
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      buildDeprecatedConfigYaml(resolve(workspace, "agents-data")),
      "utf-8",
    );

    const result = runRoll(["update"], workspace, {
      env: {
        HOME: workspace,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stderr, new RegExp(`roll 已更新到 v${NEXT_PATCH_CORE_VERSION}`));
    assert.match(result.stderr, /升级后需要迁移本地配置/);
    assert.match(result.stderr, /roll config migrate/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: update still self-updates when config YAML is invalid", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-update-invalid-config-${randomUUID()}-`));

  try {
    const fakeBinDir = resolve(workspace, "fake-bin");
    createFakeNpm(fakeBinDir, NEXT_PATCH_CORE_VERSION);
    const defaultRegistry = createDefaultRegistryBait(workspace);
    writeFileSync(resolve(workspace, "roll.config.yaml"), "llm: [\n", "utf-8");

    const result = runRoll(["update"], workspace, {
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stderr, /本地配置存在问题/);
    assert.match(result.stderr, new RegExp(`roll 已更新到 v${NEXT_PATCH_CORE_VERSION}`));
    assert.match(result.stderr, /请修复配置文件后再继续使用相关命令/);
    assert.match(result.stderr, /已跳过已注册 Agent 更新/);
    assert.doesNotMatch(result.stderr, /default-registry-bait/);
    assert.doesNotMatch(result.stderr, /改用默认 Agent 数据目录/);
    assert.equal(readFileSync(defaultRegistry.storePath, "utf-8"), defaultRegistry.originalStore);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: update --check does not inspect a default registry for invalid YAML", () => {
  const workspace = mkdtempSync(
    resolve(tmpdir(), `roll-update-check-invalid-config-${randomUUID()}-`),
  );

  try {
    const fakeBinDir = resolve(workspace, "fake-bin");
    createFakeNpm(fakeBinDir, CURRENT_CORE_VERSION);
    const defaultRegistry = createDefaultRegistryBait(workspace);
    writeFileSync(resolve(workspace, "roll.config.yaml"), "llm: [\n", "utf-8");

    const result = runRoll(["update", "--check"], workspace, {
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /本地配置存在问题/);
    assert.match(result.stderr, /跳过已注册 Agent 检查/);
    assert.doesNotMatch(result.stderr, /default-registry-bait/);
    assert.doesNotMatch(result.stderr, /改用默认 Agent 数据目录/);
    assert.equal(readFileSync(defaultRegistry.storePath, "utf-8"), defaultRegistry.originalStore);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: update stops when install config is invalid", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-update-invalid-install-${randomUUID()}-`));

  try {
    const fakeBinDir = resolve(workspace, "fake-bin");
    createFakeNpm(fakeBinDir, NEXT_PATCH_CORE_VERSION);
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `${buildConfigYaml(resolve(workspace, "agents-data"))}
install:
  fetch-retries: 999
`,
      "utf-8",
    );

    const result = runRoll(["update"], workspace, {
      env: {
        HOME: workspace,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
      },
    });

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /install 配置无效，已停止更新/);
    assert.match(result.stderr, /install\.fetchRetries/);
    assert.doesNotMatch(result.stderr, new RegExp(`roll 已更新到 v${NEXT_PATCH_CORE_VERSION}`));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test(
  "e2e smoke: updating a running local-path core-managed http agent refreshes metadata and restarts it",
  {
    timeout: 120_000,
  },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-http-update-${randomUUID()}-`));

    try {
      const agentDir = resolve(workspace, "http-fixture-agent");
      const dataDir = resolve(workspace, "agents-data");
      const port = await getFreeLocalPort();

      createCoreManagedHttpFixtureAgent(agentDir, port, { createBrokenDistEntry: true });
      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

      const addResult = runRoll(["agent", "add", agentDir], workspace, {
        env: { ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(addResult.status, 0, addResult.stderr);

      const startResult = runRoll(["agent", "start", "http-fixture-agent"], workspace);
      assert.equal(startResult.status, 0, formatHttpFixtureStartFailure(startResult, dataDir));

      const pidPath = resolve(dataDir, "pids", "http-fixture-agent.pid");
      const originalPid = readFileSync(pidPath, "utf-8").trim();

      writeFileSync(
        resolve(agentDir, "SKILL.md"),
        `---
name: http-fixture-agent
description: Updated core managed HTTP fixture agent
---

Provides a single ping tool for lifecycle smoke tests after update.
`,
        "utf-8",
      );

      const updateResult = runRoll(["update"], workspace);
      assert.equal(
        updateResult.status,
        0,
        `roll update failed\nstdout:\n${updateResult.stdout}\nstderr:\n${updateResult.stderr}`,
      );
      assert.match(updateResult.stderr, /1 个 Agent 已更新|更新完成/);

      const updatedPid = readFileSync(pidPath, "utf-8").trim();
      assert.notEqual(updatedPid, originalPid);

      const listResult = runRoll(["agent", "list", "--json"], workspace);
      assert.equal(listResult.status, 0, listResult.stderr);
      const agents = JSON.parse(listResult.stdout) as ReadonlyArray<{
        readonly skill: { readonly name: string; readonly description: string };
      }>;
      const fixtureAgent = agents.find((agent) => agent.skill.name === "http-fixture-agent");
      assert.ok(fixtureAgent);
      assert.equal(fixtureAgent.skill.description, "Updated core managed HTTP fixture agent");

      const healthResult = runRoll(["agent", "health", "--json"], workspace);
      assert.equal(healthResult.status, 0, healthResult.stderr);
      const health = JSON.parse(healthResult.stdout) as ReadonlyArray<{
        readonly agentName: string;
        readonly healthy: boolean;
      }>;
      const updatedEntry = health.find((entry) => entry.agentName === "http-fixture-agent");
      assert.ok(updatedEntry);
      assert.equal(updatedEntry.healthy, true);
    } finally {
      runRoll(["agent", "stop", "http-fixture-agent"], workspace);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "e2e smoke: update rejects a local Agent rename and keeps the old runtime stopped",
  {
    timeout: 120_000,
  },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-http-update-rename-${randomUUID()}-`));

    try {
      const agentDir = resolve(workspace, "http-fixture-agent");
      const dataDir = resolve(workspace, "agents-data");
      const port = await getFreeLocalPort();

      createCoreManagedHttpFixtureAgent(agentDir, port, { createBrokenDistEntry: true });
      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

      const addResult = runRoll(["agent", "add", agentDir], workspace, {
        env: { ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(addResult.status, 0, addResult.stderr);

      const startResult = runRoll(["agent", "start", "http-fixture-agent"], workspace);
      assert.equal(startResult.status, 0, formatHttpFixtureStartFailure(startResult, dataDir));

      writeFileSync(
        resolve(agentDir, "SKILL.md"),
        `---
name: renamed-http-fixture-agent
description: Renamed core managed HTTP fixture agent
---

Update must reject this in-place rename.
`,
        "utf-8",
      );

      const updateResult = runRoll(["update"], workspace);
      assert.equal(
        updateResult.status,
        1,
        `roll update should reject an Agent rename\nstdout:\n${updateResult.stdout}\nstderr:\n${updateResult.stderr}`,
      );
      assert.match(
        updateResult.stderr,
        /Agent "http-fixture-agent" 更新后的名称变为 "renamed-http-fixture-agent"/u,
      );
      assert.match(updateResult.stderr, /未自动恢复常驻进程/u);
      assert.doesNotMatch(updateResult.stderr, /Invalid Agent lifecycle lock handle/u);

      const listResult = runRoll(["agent", "list", "--json"], workspace);
      assert.equal(listResult.status, 0, listResult.stderr);
      const agents = JSON.parse(listResult.stdout) as ReadonlyArray<{
        readonly skill: { readonly name: string };
      }>;
      assert.deepEqual(
        agents.map((agent) => agent.skill.name),
        ["http-fixture-agent"],
      );

      const healthResult = runRoll(["agent", "health", "--json"], workspace);
      assert.equal(healthResult.status, 1, healthResult.stderr);
      const health = JSON.parse(healthResult.stdout) as ReadonlyArray<{
        readonly agentName: string;
        readonly healthy: boolean;
      }>;
      const oldEntry = health.find((entry) => entry.agentName === "http-fixture-agent");
      assert.ok(oldEntry);
      assert.equal(oldEntry.healthy, false);
      assert.equal(existsSync(resolve(dataDir, "pids", "http-fixture-agent.pid")), false);
    } finally {
      runRoll(["agent", "stop", "http-fixture-agent"], workspace);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "e2e smoke: failed managed restart during update returns non-zero and cleans up the process",
  {
    timeout: 120_000,
  },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-http-update-fail-${randomUUID()}-`));

    try {
      const agentDir = resolve(workspace, "http-fixture-agent");
      const dataDir = resolve(workspace, "agents-data");
      const port = await getFreeLocalPort();

      createCoreManagedHttpFixtureAgent(agentDir, port, { createBrokenDistEntry: true });
      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

      const addResult = runRoll(["agent", "add", agentDir], workspace, {
        env: { ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(addResult.status, 0, addResult.stderr);

      const startResult = runRoll(["agent", "start", "http-fixture-agent"], workspace);
      assert.equal(startResult.status, 0, formatHttpFixtureStartFailure(startResult, dataDir));

      const packageJsonPath = resolve(agentDir, "package.json");
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
        readonly rollAgent?: {
          readonly endpoint?: {
            readonly path?: string;
            readonly port?: number;
          };
        };
      };
      writeFileSync(
        packageJsonPath,
        JSON.stringify(
          {
            ...packageJson,
            rollAgent: {
              ...packageJson.rollAgent,
              endpoint: {
                ...packageJson.rollAgent?.endpoint,
                path: "/broken-mcp",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const updateResult = runRoll(["update"], workspace, {
        env: {
          ROLL_AGENT_READY_STARTUP_TIMEOUT_MS: "1500",
          ROLL_AGENT_READY_PROBE_TIMEOUT_MS: "200",
          ROLL_AGENT_READY_INTERVAL_MS: "100",
        },
      });
      assert.equal(
        updateResult.status,
        1,
        `roll update should fail when managed restart cannot become ready\nstdout:\n${updateResult.stdout}\nstderr:\n${updateResult.stderr}`,
      );
      assert.match(updateResult.stderr, /更新完成但有失败|重启失败|metadata 刷新或重启失败/);

      const pidPath = resolve(dataDir, "pids", "http-fixture-agent.pid");
      assert.equal(existsSync(pidPath), false);

      const healthResult = runRoll(["agent", "health", "--json"], workspace);
      assert.equal(healthResult.status, 1, healthResult.stderr);
      const health = JSON.parse(healthResult.stdout) as ReadonlyArray<{
        readonly agentName: string;
        readonly healthy: boolean;
        readonly message: string;
      }>;
      const entry = health.find((item) => item.agentName === "http-fixture-agent");
      assert.ok(entry);
      assert.equal(entry.healthy, false);
      assert.match(entry.message, /未运行|缺少活动 PID/);
    } finally {
      runRoll(["agent", "stop", "http-fixture-agent"], workspace);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
