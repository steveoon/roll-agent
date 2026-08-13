import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  CURRENT_CORE_VERSION,
  runRoll,
  buildConfigYaml,
  createFakeNpm,
  createFakeNpmAgentInstaller,
} from "./smoke.e2e-harness.ts";

test("e2e smoke: agent install rejects local source directories", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-install-local-${randomUUID()}-`));

  try {
    const smokeAgentPath = resolve(
      import.meta.dirname,
      "../../../../packages/sdk/test-fixtures/smoke-agent",
    );
    const dataDir = resolve(workspace, "agents-data");

    writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

    const installResult = runRoll(["agent", "install", smokeAgentPath], workspace);
    assert.equal(installResult.status, 1);
    assert.match(installResult.stderr, /本地源码目录请使用 `roll agent add/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: update --check refreshes installed-package agent versions", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-update-check-agent-${randomUUID()}-`));

  try {
    const fakeBinDir = resolve(workspace, "fake-bin");
    const dataDir = resolve(workspace, "agents-data");
    const installDir = resolve(workspace, "installed-agents");
    const packageRoot = resolve(installDir, "node_modules/@roll-agent/browser-use-agent");

    createFakeNpm(fakeBinDir, {
      "@roll-agent/core": CURRENT_CORE_VERSION,
      "@roll-agent/browser-use-agent": "0.8.0",
    });
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(resolve(workspace, ".roll-agent"), { recursive: true });
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
        name: "@roll-agent/browser-use-agent",
        version: "0.7.7",
      }),
      "utf-8",
    );
    writeFileSync(
      resolve(workspace, ".roll-agent/update-check.json"),
      JSON.stringify({
        packages: {
          "@roll-agent/browser-use-agent": {
            latestVersion: "0.7.7",
            checkedAt: Date.now(),
          },
        },
      }),
      "utf-8",
    );
    writeFileSync(
      resolve(dataDir, "agents.json"),
      JSON.stringify({
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
              packageName: "@roll-agent/browser-use-agent",
              packageSpec: "@roll-agent/browser-use-agent@latest",
              installDir,
              installedVersion: "0.7.7",
            },
          },
        ],
      }),
      "utf-8",
    );

    const result = runRoll(["update", "--check"], workspace, {
      env: {
        HOME: workspace,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      /browser-use-agent \[installed-package\].*可更新 v0\.7\.7 → v0\.8\.0/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: update resolves installed-package specs consistently", () => {
  const packageName = "@roll-agent/browser-use-agent";
  const cases = [
    {
      expectedInstallSpec: `${packageName}@latest`,
      expectedVersion: "0.20.0",
      label: "bare package",
      packageSpec: packageName,
    },
    {
      expectedInstallSpec: `${packageName}@latest`,
      expectedVersion: "0.20.0",
      label: "version range",
      packageSpec: `${packageName}@^0.15.0`,
    },
    {
      expectedInstallSpec: `${packageName}@0.15.0`,
      expectedVersion: "0.15.0",
      label: "exact version",
      packageSpec: `${packageName}@0.15.0`,
    },
  ] as const;

  for (const testCase of cases) {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-update-install-agent-${randomUUID()}-`));
    const fakeBinDir = resolve(workspace, "fake-bin");
    const dataDir = resolve(workspace, "agents-data");
    const installDir = resolve(workspace, "installed-agents");
    const packageRoot = resolve(installDir, "node_modules/@roll-agent/browser-use-agent");
    const installLogPath = resolve(workspace, "fake-npm-install.log");

    try {
      createFakeNpmAgentInstaller(fakeBinDir, {
        packageName,
        oldVersion: "0.15.0",
        latestVersion: "0.20.0",
        coreVersion: CURRENT_CORE_VERSION,
        installLogPath,
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
        resolve(installDir, "package.json"),
        JSON.stringify({ dependencies: { [packageName]: "^0.15.0" } }, null, 2),
        "utf-8",
      );
      writeFileSync(
        resolve(packageRoot, "package.json"),
        JSON.stringify(
          {
            name: packageName,
            version: "0.15.0",
            type: "module",
            rollAgent: {
              runtime: { ownership: "on-demand", transport: "stdio" },
              start: { command: "node", args: ["dist/index.js"] },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      writeFileSync(
        resolve(packageRoot, "SKILL.md"),
        "---\nname: browser-use-agent\ndescription: Browser automation agent\n---\n\nFixture.\n",
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
                  packageSpec: testCase.packageSpec,
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

      assert.equal(result.status, 0, `${testCase.label}: ${result.stderr}`);
      assert.match(result.stderr, /browser-use-agent 已重新安装/, testCase.label);
      assert.equal(readFileSync(installLogPath, "utf-8").trim(), testCase.expectedInstallSpec);

      const stored = JSON.parse(readFileSync(resolve(dataDir, "agents.json"), "utf-8")) as {
        agents?: Array<{
          source?: {
            installedVersion?: unknown;
            packageSpec?: unknown;
          };
        }>;
      };
      assert.equal(
        stored.agents?.[0]?.source?.installedVersion,
        testCase.expectedVersion,
        testCase.label,
      );
      assert.equal(stored.agents?.[0]?.source?.packageSpec, testCase.packageSpec, testCase.label);

      const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf-8")) as {
        version?: unknown;
      };
      assert.equal(manifest.version, testCase.expectedVersion, testCase.label);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("e2e smoke: update recreates a missing installed-package directory", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-update-missing-install-${randomUUID()}-`));
  const fakeBinDir = resolve(workspace, "fake-bin");
  const dataDir = resolve(workspace, "agents-data");
  const installDir = resolve(workspace, "missing-installed-agent");
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
    });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `agents:
  data-dir: ${JSON.stringify(dataDir)}
`,
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
    assert.equal(existsSync(installDir), false);

    const result = runRoll(["update"], workspace, {
      env: {
        HOME: workspace,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /browser-use-agent 已重新安装/);
    assert.equal(readFileSync(installLogPath, "utf-8").trim(), `${packageName}@latest`);

    const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf-8")) as {
      readonly version?: unknown;
    };
    assert.equal(manifest.version, "0.20.0");

    const stored = JSON.parse(readFileSync(resolve(dataDir, "agents.json"), "utf-8")) as {
      readonly agents?: ReadonlyArray<{
        readonly source?: { readonly installedVersion?: unknown };
      }>;
    };
    assert.equal(stored.agents?.[0]?.source?.installedVersion, "0.20.0");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: failed update removes a partially recreated install directory", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-update-missing-rollback-${randomUUID()}-`));
  const fakeBinDir = resolve(workspace, "fake-bin");
  const dataDir = resolve(workspace, "agents-data");
  const installDir = resolve(workspace, "missing-installed-agent");
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
      failInstall: true,
    });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `agents:
  data-dir: ${JSON.stringify(dataDir)}
`,
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
        USERPROFILE: workspace,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
      },
    });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /fixture install failed after a partial write/u);
    assert.equal(existsSync(installDir), false);

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
