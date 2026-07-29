import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunRollOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}

interface SpawnedRollProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly output: {
    stdout: string;
    stderr: string;
  };
}

interface ChildExitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface AgentRuntimeSnapshot {
  readonly raw: string;
  readonly pid: number;
  readonly retention: string;
  readonly processStartToken: string;
  readonly startedAt: string;
}

const CURRENT_CORE_VERSION = readCurrentCoreVersion();
const NEXT_PATCH_CORE_VERSION = bumpPatchVersion(CURRENT_CORE_VERSION);

function runRoll(args: readonly string[], cwd: string, options: RunRollOptions = {}): CliResult {
  const cliEntry = resolve(import.meta.dirname, "index.ts");
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--experimental-sqlite", cliEntry, ...args],
    {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1", ...(options.env ?? {}) },
      input: options.input,
    },
  );

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function spawnRollProcess(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): SpawnedRollProcess {
  const cliEntry = resolve(import.meta.dirname, "index.ts");
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--experimental-sqlite", cliEntry, ...args],
    {
      cwd,
      env: { ...process.env, NO_COLOR: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output.stderr += chunk;
  });
  child.stdin.on("error", () => {
    // Cleanup can race with a child that already closed stdin.
  });
  return { child, output };
}

function spawnNodeScriptProcess(scriptPath: string, cwd: string): SpawnedRollProcess {
  const child = spawn(process.execPath, ["--experimental-strip-types", scriptPath], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output.stderr += chunk;
  });
  child.stdin.on("error", () => {
    // Cleanup can race with a child that already closed stdin.
  });
  return { child, output };
}

function formatSpawnedRollProcess(label: string, process: SpawnedRollProcess): string {
  return `${label} (PID: ${String(process.child.pid ?? "unavailable")})
stdout:
${process.output.stdout || "<empty>"}
stderr:
${process.output.stderr || "<empty>"}`;
}

async function waitForSmokeCondition(
  description: string,
  condition: () => boolean,
  diagnostics: () => string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`Timed out waiting for ${description}\n${diagnostics()}`);
}

async function waitForSpawnedRollExit(
  process: SpawnedRollProcess,
  label: string,
  timeoutMs = 15_000,
): Promise<ChildExitResult> {
  if (process.child.exitCode !== null || process.child.signalCode !== null) {
    return { code: process.child.exitCode, signal: process.child.signalCode };
  }

  return new Promise<ChildExitResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      process.child.off("exit", onExit);
      process.child.off("error", onError);
      reject(
        new Error(
          `Timed out waiting for ${label} to exit\n${formatSpawnedRollProcess(label, process)}`,
        ),
      );
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      process.child.off("error", onError);
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      process.child.off("exit", onExit);
      reject(
        new Error(
          `${label} process error: ${error.message}\n${formatSpawnedRollProcess(label, process)}`,
        ),
      );
    };
    process.child.once("exit", onExit);
    process.child.once("error", onError);
  });
}

async function exitRollChat(process: SpawnedRollProcess, label: string): Promise<void> {
  process.child.stdin.write("exit\n");
  const result = await waitForSpawnedRollExit(process, label);
  assert.equal(
    result.code,
    0,
    `${label} should exit cleanly (signal: ${String(result.signal)})\n${formatSpawnedRollProcess(label, process)}`,
  );
}

async function cleanupSpawnedRollProcess(
  process: SpawnedRollProcess | undefined,
  label: string,
): Promise<void> {
  if (
    process === undefined ||
    process.child.exitCode !== null ||
    process.child.signalCode !== null
  ) {
    return;
  }

  process.child.stdin.end("exit\n");
  try {
    await waitForSpawnedRollExit(process, label, 5_000);
    return;
  } catch {
    process.child.kill("SIGTERM");
  }
  try {
    await waitForSpawnedRollExit(process, label, 5_000);
  } catch {
    process.child.kill("SIGKILL");
    await waitForSpawnedRollExit(process, label, 5_000).catch(() => {});
  }
}

function countAgentUsageLeaseFiles(dataDir: string, agentName: string): number {
  const digest = createHash("sha256").update(agentName).digest("hex");
  const leaseDir = resolve(dataDir, "pids", ".leases", digest);
  if (!existsSync(leaseDir)) return 0;
  return readdirSync(leaseDir).filter((entry) => entry.endsWith(".json")).length;
}

function readAgentPidFile(dataDir: string, agentName: string): string | undefined {
  const pidPath = resolve(dataDir, "pids", `${agentName}.pid`);
  return existsSync(pidPath) ? readFileSync(pidPath, "utf-8").trim() : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function forceKillProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

function readAgentRuntimeSnapshot(
  dataDir: string,
  agentName: string,
): AgentRuntimeSnapshot | undefined {
  const runtimePath = resolve(dataDir, "pids", `${agentName}.runtime.json`);
  if (!existsSync(runtimePath)) return undefined;

  const raw = readFileSync(runtimePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("pid" in parsed) ||
    typeof parsed.pid !== "number" ||
    !("retention" in parsed) ||
    typeof parsed.retention !== "string" ||
    !("processStartToken" in parsed) ||
    typeof parsed.processStartToken !== "string" ||
    !("startedAt" in parsed) ||
    typeof parsed.startedAt !== "string"
  ) {
    throw new Error(`Invalid Agent runtime sidecar: ${runtimePath}`);
  }
  return {
    raw,
    pid: parsed.pid,
    retention: parsed.retention,
    processStartToken: parsed.processStartToken,
    startedAt: parsed.startedAt,
  };
}

function writeInterruptedAgentRelease(dataDir: string, agentName: string): string {
  const runtime = readAgentRuntimeSnapshot(dataDir, agentName);
  if (runtime === undefined) {
    throw new Error(`Missing Agent runtime sidecar for ${agentName}`);
  }

  const leaseId = randomUUID();
  const digest = createHash("sha256").update(agentName).digest("hex");
  const leaseDir = resolve(dataDir, "pids", ".leases", digest);
  const releasePath = resolve(leaseDir, `.${leaseId}.${randomUUID()}.releasing.json`);
  mkdirSync(leaseDir, { recursive: true });
  writeFileSync(
    releasePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        leaseId,
        agentName,
        holderKind: "chat",
        ownerIdentity: {
          pid: 2_147_483_647,
          processStartToken: `pst-v2:${"0".repeat(64)}`,
        },
        runtimeIdentity: {
          pid: runtime.pid,
          processStartToken: runtime.processStartToken,
          startedAt: runtime.startedAt,
        },
        acquiredAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return releasePath;
}

async function getFreeLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  if (
    typeof address !== "object" ||
    address === null ||
    !("port" in address) ||
    typeof address.port !== "number"
  ) {
    throw new Error("Unable to allocate a local TCP port for HTTP fixture agent");
  }
  return address.port;
}

function readHttpFixtureAgentLog(dataDir: string): string {
  const logPath = resolve(dataDir, "logs", "http-fixture-agent.log");
  if (!existsSync(logPath)) {
    return `agent log not found: ${logPath}`;
  }

  const content = readFileSync(logPath, "utf-8").trim();
  return `agent log (${logPath}):\n${content.length > 0 ? content : "<empty>"}`;
}

function formatHttpFixtureStartFailure(result: CliResult, dataDir: string): string {
  return `agent start failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n${readHttpFixtureAgentLog(dataDir)}`;
}

function buildConfigYaml(dataDir: string): string {
  return `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

ask:
  confirm-threshold: 0.5

agents:
  data-dir: ${dataDir}
`;
}

function buildDeprecatedConfigYaml(dataDir: string): string {
  return `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

router:
  mode: declarative
  llm-model: claude-sonnet-4-6

agents:
  data-dir: ${dataDir}
`;
}

function readCurrentCoreVersion(): string {
  const packageJsonPath = resolve(import.meta.dirname, "../../package.json");
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`Unable to read @roll-agent/core version from ${packageJsonPath}`);
  }
  return parsed.version;
}

function bumpPatchVersion(version: string): string {
  const parts = version.split(".");
  if (parts.length !== 3) {
    throw new Error(`Unsupported semver version: ${version}`);
  }

  const [majorRaw, minorRaw, patchRaw] = parts;
  const major = Number.parseInt(majorRaw ?? "", 10);
  const minor = Number.parseInt(minorRaw ?? "", 10);
  const patch = Number.parseInt(patchRaw ?? "", 10);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    throw new Error(`Unsupported semver version: ${version}`);
  }
  return `${major}.${minor}.${patch + 1}`;
}

function createFakeNpm(
  binDir: string,
  latestVersion: string | Readonly<Record<string, string>>,
): void {
  mkdirSync(binDir, { recursive: true });
  const npmPath = resolve(binDir, "npm");
  const versionsByPackage =
    typeof latestVersion === "string" ? { "*": latestVersion } : latestVersion;
  writeFileSync(
    npmPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "view" && args[2] === "version") {
  const useJson = args.includes("--json");
  const versionsByPackage = ${JSON.stringify(versionsByPackage)};
  const latestVersion = versionsByPackage[args[1]] ?? versionsByPackage["*"];
  const output = useJson ? JSON.stringify(latestVersion) : latestVersion;
  process.stdout.write(output + "\\n");
  process.exit(0);
}
if (args[0] === "install" && args[1] === "-g") {
  process.exit(0);
}
process.exit(0);
`,
    "utf-8",
  );
  chmodSync(npmPath, 0o755);
}

function createDefaultRegistryBait(workspace: string): {
  readonly storePath: string;
  readonly originalStore: string;
} {
  const defaultDataDir = resolve(workspace, ".roll-agent/agents");
  const storePath = resolve(defaultDataDir, "agents.json");
  const unrelatedAgentPath = resolve(workspace, "unrelated-default-agent");
  mkdirSync(defaultDataDir, { recursive: true });
  writeFileSync(
    storePath,
    JSON.stringify(
      {
        schemaVersion: 2,
        agents: [
          {
            skill: {
              name: "default-registry-bait",
              description: "must not be touched through config fallback",
              metadata: {},
            },
            transport: { type: "stdio", command: "node" },
            runtime: { ownership: "on-demand" },
            installPath: unrelatedAgentPath,
            registeredAt: "2026-01-01T00:00:00.000Z",
            status: "idle",
            source: { type: "local-path", path: unrelatedAgentPath },
          },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  );
  return {
    storePath,
    originalStore: readFileSync(storePath, "utf-8"),
  };
}

function createFakeNpmAgentInstaller(
  binDir: string,
  options: {
    readonly packageName: string;
    readonly oldVersion: string;
    readonly latestVersion: string;
    readonly coreVersion: string;
    readonly installLogPath: string;
    readonly installedAgentName?: string;
    readonly failInstall?: boolean;
  },
): void {
  mkdirSync(binDir, { recursive: true });
  const npmPath = resolve(binDir, "npm");
  writeFileSync(
    npmPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const packageName = ${JSON.stringify(options.packageName)};
const oldVersion = ${JSON.stringify(options.oldVersion)};
const latestVersion = ${JSON.stringify(options.latestVersion)};
const coreVersion = ${JSON.stringify(options.coreVersion)};
const installLogPath = ${JSON.stringify(options.installLogPath)};
const installedAgentName = ${JSON.stringify(options.installedAgentName ?? "browser-use-agent")};
const failInstall = ${JSON.stringify(options.failInstall ?? false)};

function packageRoot(prefix) {
  return path.join(prefix, "node_modules", ...packageName.split("/"));
}

function writeInstalledPackage(prefix, version) {
  const root = packageRoot(prefix);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: packageName,
        version,
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
  fs.writeFileSync(
    path.join(root, "SKILL.md"),
    "---\\nname: " + installedAgentName + "\\ndescription: Browser automation agent\\n---\\n\\nFixture.\\n",
    "utf-8",
  );
}

if (args[0] === "view" && args[2] === "version") {
  const useJson = args.includes("--json");
  const latest = args[1] === packageName ? latestVersion : coreVersion;
  process.stdout.write((useJson ? JSON.stringify(latest) : latest) + "\\n");
  process.exit(0);
}

if (args[0] === "install" && args[1] === "-g") {
  process.exit(0);
}

if (args[0] === "install") {
  const prefixIndex = args.indexOf("--prefix");
  const prefix = prefixIndex === -1 ? undefined : args[prefixIndex + 1];
  const packageSpec = args.find((arg, index) => {
    return index > 0 && args[index - 1] !== "--prefix" && !arg.startsWith("--");
  });
  if (!prefix || !packageSpec) {
    process.stderr.write("missing --prefix or package spec\\n");
    process.exit(1);
  }

  fs.appendFileSync(installLogPath, packageSpec + "\\n", "utf-8");
  if (failInstall) {
    fs.mkdirSync(prefix, { recursive: true });
    fs.writeFileSync(path.join(prefix, "partial-install.txt"), "partial", "utf-8");
    process.stderr.write("fixture install failed after a partial write\\n");
    process.exit(1);
  }
  const pinnedOldSpec = packageName + "@" + oldVersion;
  const rangedOldSpec = packageName + "@^" + oldVersion;
  const version =
    packageSpec === packageName || packageSpec === rangedOldSpec || packageSpec === pinnedOldSpec
      ? oldVersion
      : latestVersion;
  writeInstalledPackage(prefix, version);
  process.exit(0);
}

process.exit(0);
`,
    "utf-8",
  );
  chmodSync(npmPath, 0o755);
}

function createCoreManagedHttpFixtureAgent(
  agentDir: string,
  port: number,
  options: {
    readonly startupDelayMs?: number;
    readonly shutdownDelayMs?: number;
    readonly createBrokenDistEntry?: boolean;
  } = {},
): void {
  const sdkEntry = resolve(import.meta.dirname, "../../../../packages/sdk/src/index.ts");
  const zodEntry = resolve(
    import.meta.dirname,
    "../../../../packages/sdk/node_modules/zod/index.js",
  );
  const startupDelayMs = options.startupDelayMs ?? 0;
  const shutdownDelayMs = options.shutdownDelayMs ?? 0;

  mkdirSync(resolve(agentDir, "src"), { recursive: true });

  writeFileSync(
    resolve(agentDir, "SKILL.md"),
    `---
name: http-fixture-agent
description: Core managed HTTP fixture agent
---

Provides a single ping tool for lifecycle smoke tests.
`,
    "utf-8",
  );

  writeFileSync(
    resolve(agentDir, "package.json"),
    JSON.stringify(
      {
        name: "http-fixture-agent",
        version: "0.0.1",
        private: true,
        type: "module",
        rollAgent: {
          runtime: {
            ownership: "core-managed",
            transport: "streamable-http",
          },
          start: {
            command: process.execPath,
            args: ["dist/index.js"],
          },
          endpoint: {
            path: "/mcp",
            port,
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  writeFileSync(
    resolve(agentDir, "src/index.ts"),
    `import { defineAgent, defineTool } from ${JSON.stringify(sdkEntry)};
import { z } from ${JSON.stringify(zodEntry)};

if (${startupDelayMs} > 0) {
  await new Promise((resolve) => {
    setTimeout(resolve, ${startupDelayMs});
  });
}

if (${shutdownDelayMs} > 0) {
  process.on("SIGTERM", () => {
    setTimeout(() => {
      process.exit(0);
    }, ${shutdownDelayMs});
  });
}

const ping = defineTool({
  name: "ping",
  description: "health ping",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

const agent = defineAgent({
  name: "http-fixture-agent",
  tools: [ping],
});

await agent.listen({
  transport: {
    type: "http",
    host: "127.0.0.1",
    port: ${port},
  },
});
`,
    "utf-8",
  );

  if (options.createBrokenDistEntry) {
    mkdirSync(resolve(agentDir, "dist"), { recursive: true });
    writeFileSync(
      resolve(agentDir, "dist/index.js"),
      'throw new Error("dist entry should not be used for local-path fixture");\n',
      "utf-8",
    );
  }
}

function createDeclaredEnvFixtureAgent(agentDir: string): void {
  mkdirSync(resolve(agentDir, "references"), { recursive: true });
  writeFileSync(
    resolve(agentDir, "SKILL.md"),
    `---
name: declared-env-agent
description: Agent with declared environment requirements
metadata:
  roll-transport: stdio
  roll-command: node src/index.ts
  roll-env-file: references/env.yaml
---
`,
    "utf-8",
  );
  writeFileSync(
    resolve(agentDir, "references/env.yaml"),
    `required:
  - name: REQUIRED_TOKEN
    purpose: Required auth token
  - name: REQUIRED_URL
    purpose: Required upstream URL
optional:
  - name: OPTIONAL_MODEL
    purpose: Optional model override
    default: provider/default-model
`,
    "utf-8",
  );
}

function createDiagnosticEnvFixtureAgent(agentDir: string): void {
  const sdkEntry = resolve(import.meta.dirname, "../../../../packages/sdk/src/index.ts");
  const zodEntry = resolve(
    import.meta.dirname,
    "../../../../packages/sdk/node_modules/zod/index.js",
  );

  mkdirSync(resolve(agentDir, "src"), { recursive: true });
  mkdirSync(resolve(agentDir, "references"), { recursive: true });

  writeFileSync(
    resolve(agentDir, "SKILL.md"),
    `---
name: diagnostic-env-agent
description: Agent that exposes runtime env diagnostics
metadata:
  roll-transport: stdio
  roll-command: node --experimental-strip-types src/index.ts
  roll-env-file: references/env.yaml
---
`,
    "utf-8",
  );

  writeFileSync(
    resolve(agentDir, "references/env.yaml"),
    `required:
  - name: CONFIG_TOKEN
    purpose: Config-managed token
  - name: SHELL_ONLY_TOKEN
    purpose: Shell-inherited token
optional:
  - name: OPTIONAL_MODEL
    purpose: Optional model override
    default: provider/default-model
`,
    "utf-8",
  );

  writeFileSync(
    resolve(agentDir, "src/index.ts"),
    `import { createHash } from "node:crypto";
import { z } from ${JSON.stringify(zodEntry)};
import { defineAgent, defineTool } from ${JSON.stringify(sdkEntry)};

const declaredEnvKeys = ["CONFIG_TOKEN", "SHELL_ONLY_TOKEN", "OPTIONAL_MODEL"] as const;

function createEnvFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function collectEffectiveEnvSources(env = process.env) {
  return Object.fromEntries(
    declaredEnvKeys.map((name) => {
      const value = env[name];
      if (typeof value === "string" && value.length > 0) {
        return [name, { present: true, fingerprint: createEnvFingerprint(value) }];
      }

      return [name, { present: false }];
    }),
  );
}

const diagnosticStatus = defineTool({
  name: "diagnostic_status",
  description: "Expose effective env sources for smoke tests",
  input: z.object({}),
  output: z.object({
    effectiveEnvSources: z.record(
      z.object({
        present: z.boolean(),
        fingerprint: z.string().optional(),
      }),
    ),
  }),
  execute: async () => ({
    effectiveEnvSources: collectEffectiveEnvSources(),
  }),
});

const agent = defineAgent({
  name: "diagnostic-env-agent",
  tools: [diagnosticStatus],
});

await agent.listen();
`,
    "utf-8",
  );
}

function createPreflightFixtureAgent(agentDir: string): void {
  const sdkEntry = resolve(import.meta.dirname, "../../../../packages/sdk/src/index.ts");
  const zodEntry = resolve(
    import.meta.dirname,
    "../../../../packages/sdk/node_modules/zod/index.js",
  );

  mkdirSync(resolve(agentDir, "src"), { recursive: true });
  mkdirSync(resolve(agentDir, "references"), { recursive: true });

  writeFileSync(
    resolve(agentDir, "SKILL.md"),
    `---
name: preflight-fixture-agent
description: Agent for preflight aggregation smoke tests
metadata:
  roll-transport: stdio
  roll-command: node --experimental-strip-types src/index.ts
  roll-env-file: references/env.yaml
---
`,
    "utf-8",
  );

  writeFileSync(
    resolve(agentDir, "references/env.yaml"),
    `required:
  - name: REQUIRED_TOKEN
    purpose: Reply authority bearer token
`,
    "utf-8",
  );

  writeFileSync(
    resolve(agentDir, "src/index.ts"),
    `import { z } from ${JSON.stringify(zodEntry)};
import { defineAgent, defineTool } from ${JSON.stringify(sdkEntry)};

const generateReply = defineTool({
  name: "generate_reply",
  description: "Generate reply for a recruiter thread",
  input: z.object({
    field: z.string().describe("候选人的原始消息"),
    target: z.object({
      platform: z.enum(["zhipin"]).describe("目标平台"),
      recruiterUsername: z.string().describe("招聘者用户名"),
    }),
  }),
  output: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

const agent = defineAgent({
  name: "preflight-fixture-agent",
  tools: [generateReply],
});

await agent.listen();
`,
    "utf-8",
  );
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
      env: { ROLL_SKIP_INSTALL: "1" },
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

test("e2e smoke: agent tools prints tool schemas in text and json", { timeout: 120_000 }, () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-tools-${randomUUID()}-`));

  try {
    const smokeAgentPath = resolve(
      import.meta.dirname,
      "../../../../packages/sdk/test-fixtures/smoke-agent",
    );
    const dataDir = resolve(workspace, "agents-data");

    writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

    const addResult = runRoll(["agent", "add", smokeAgentPath], workspace, {
      env: { ROLL_SKIP_INSTALL: "1" },
    });
    assert.equal(addResult.status, 0, addResult.stderr);

    const textResult = runRoll(["agent", "tools", "smoke-test-agent"], workspace);
    assert.equal(
      textResult.status,
      0,
      `agent tools failed\nstdout:\n${textResult.stdout}\nstderr:\n${textResult.stderr}`,
    );
    assert.match(textResult.stdout, /Input Schema/);
    assert.match(textResult.stdout, /\bping\b/);
    assert.match(textResult.stdout, /"type": "object"/);

    const jsonResult = runRoll(["agent", "tools", "smoke-test-agent", "--json"], workspace);
    assert.equal(
      jsonResult.status,
      0,
      `agent tools --json failed\nstdout:\n${jsonResult.stdout}\nstderr:\n${jsonResult.stderr}`,
    );

    const tools = JSON.parse(jsonResult.stdout) as ReadonlyArray<{
      readonly name: string;
      readonly description?: string;
      readonly inputSchema: {
        readonly type: string;
      };
    }>;
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, "ping");
    assert.equal(
      tools[0]?.description,
      "Return a deterministic empty message list for smoke tests",
    );
    assert.equal(tools[0]?.inputSchema.type, "object");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test(
  "e2e smoke: skills list/get/path serve registered skill documents",
  { timeout: 120_000 },
  () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-skills-${randomUUID()}-`));

    try {
      const smokeAgentPath = resolve(
        import.meta.dirname,
        "../../../../packages/sdk/test-fixtures/smoke-agent",
      );
      const skillPath = resolve(smokeAgentPath, "SKILL.md");
      const dataDir = resolve(workspace, "agents-data");

      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

      const addResult = runRoll(["agent", "add", smokeAgentPath], workspace, {
        env: { ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(addResult.status, 0, addResult.stderr);

      const listResult = runRoll(["skills", "list", "--json"], workspace);
      assert.equal(
        listResult.status,
        0,
        `skills list failed\nstdout:\n${listResult.stdout}\nstderr:\n${listResult.stderr}`,
      );
      const listedSkills = JSON.parse(listResult.stdout) as ReadonlyArray<{
        readonly name: string;
        readonly description: string;
        readonly source: string;
        readonly path?: string;
      }>;
      assert.deepEqual(
        listedSkills.find((skill) => skill.name === "smoke-test-agent"),
        {
          name: "smoke-test-agent",
          description: "CLI smoke test fixture agent.",
          source: "filesystem",
          path: skillPath,
        },
      );

      const pathResult = runRoll(["skills", "path", "smoke-test-agent"], workspace);
      assert.equal(pathResult.status, 0, pathResult.stderr);
      assert.equal(pathResult.stdout.trim(), skillPath);

      const getResult = runRoll(["skills", "get", "smoke-test-agent"], workspace);
      assert.equal(getResult.status, 0, getResult.stderr);
      assert.match(getResult.stdout, /# Smoke Test Agent/);
      assert.match(getResult.stdout, /`ping` - 返回固定的空消息列表/);

      const getWithReferencesResult = runRoll(
        ["skills", "get", "smoke-test-agent", "--include-references", "--json"],
        workspace,
      );
      assert.equal(getWithReferencesResult.status, 0, getWithReferencesResult.stderr);
      const documentWithReferences = JSON.parse(getWithReferencesResult.stdout) as {
        readonly name: string;
        readonly references: readonly unknown[];
      };
      assert.equal(documentWithReferences.name, "smoke-test-agent");
      assert.deepEqual(documentWithReferences.references, []);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test("e2e smoke: run suggests the closest tool name when the requested tool is missing", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-run-suggest-${randomUUID()}-`));

  try {
    const smokeAgentPath = resolve(
      import.meta.dirname,
      "../../../../packages/sdk/test-fixtures/smoke-agent",
    );
    const dataDir = resolve(workspace, "agents-data");

    writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

    const addResult = runRoll(["agent", "add", smokeAgentPath], workspace, {
      env: { ROLL_SKIP_INSTALL: "1" },
    });
    assert.equal(addResult.status, 0, addResult.stderr);

    const runResult = runRoll(["run", "smoke-test-agent", "pnig"], workspace);
    assert.equal(runResult.status, 1);
    assert.match(runResult.stderr, /Tool "pnig" 不存在于 Agent "smoke-test-agent" 中/);
    assert.match(runResult.stderr, /Did you mean: `ping`\?/);
    assert.match(runResult.stderr, /roll agent tools smoke-test-agent/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: run reads batch calls from stdin as structured JSON", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-run-batch-stdin-${randomUUID()}-`));

  try {
    const dataDir = resolve(workspace, "agents-data");
    writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

    const runResult = runRoll(["run", "--batch-stdin", "--json"], workspace, {
      input: '[{"agent":"missing-agent","tool":"noop","label":"missing"}]',
    });
    assert.equal(runResult.status, 1);

    const results = JSON.parse(runResult.stdout) as ReadonlyArray<{
      readonly index: number;
      readonly agent: string;
      readonly tool: string;
      readonly label?: string;
      readonly ok: boolean;
      readonly error?: string;
    }>;
    assert.deepEqual(results, [
      {
        index: 0,
        agent: "missing-agent",
        tool: "noop",
        label: "missing",
        ok: false,
        error: 'Agent "missing-agent" 未注册。使用 `roll agent list` 查看已注册 Agent。',
      },
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: run rejects batch stdin with positional args before parsing stdin", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-run-batch-positional-${randomUUID()}-`));

  try {
    const dataDir = resolve(workspace, "agents-data");
    writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

    const runResult = runRoll(["run", "smoke-test-agent", "ping", "--batch-stdin"], workspace, {
      input: "not-json",
    });
    assert.equal(runResult.status, 1);
    assert.match(runResult.stderr, /batch 模式不接受 agent\/tool 位置参数/);
    assert.equal(runResult.stdout, "");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

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

test("e2e smoke: agent add warns when declared required env is missing", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-add-env-${randomUUID()}-`));

  try {
    const agentDir = resolve(workspace, "declared-env-agent");
    const dataDir = resolve(workspace, "agents-data");
    createDeclaredEnvFixtureAgent(agentDir);
    writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

    const addResult = runRoll(["agent", "add", agentDir], workspace);
    assert.equal(addResult.status, 0, addResult.stderr);
    assert.match(addResult.stderr, /仍缺少必填环境变量: REQUIRED_TOKEN, REQUIRED_URL/);
    assert.match(addResult.stderr, /roll config setup agent declared-env-agent/);
    assert.match(addResult.stderr, /roll config explain agents\.env\.declared-env-agent/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: agent info shows declared env satisfaction sources", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-info-env-${randomUUID()}-`));

  try {
    const agentDir = resolve(workspace, "declared-env-agent");
    const dataDir = resolve(workspace, "agents-data");
    createDeclaredEnvFixtureAgent(agentDir);
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

ask:
  confirm-threshold: 0.5

agents:
  data-dir: ${dataDir}
  env:
    declared-env-agent:
      REQUIRED_TOKEN: config-token
`,
      "utf-8",
    );

    const addResult = runRoll(["agent", "add", agentDir], workspace, {
      env: { REQUIRED_URL: "https://example.com" },
    });
    assert.equal(addResult.status, 0, addResult.stderr);

    const infoResult = runRoll(["agent", "info", "declared-env-agent"], workspace, {
      env: { REQUIRED_URL: "https://example.com" },
    });
    assert.equal(infoResult.status, 0, infoResult.stderr);
    assert.match(infoResult.stdout, /REQUIRED_TOKEN: \[必填\] 已配置于 agents\.env/);
    assert.match(infoResult.stdout, /REQUIRED_URL: \[必填\] 仅当前 shell 环境/);
    assert.match(infoResult.stdout, /OPTIONAL_MODEL: \[可选\] 默认值 \(provider\/default-model\)/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: unresolved agents.env placeholders are treated as missing", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-placeholder-env-${randomUUID()}-`));

  try {
    const agentDir = resolve(workspace, "declared-env-agent");
    const dataDir = resolve(workspace, "agents-data");
    createDeclaredEnvFixtureAgent(agentDir);
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

ask:
  confirm-threshold: 0.5

agents:
  data-dir: ${dataDir}
  env:
    declared-env-agent:
      REQUIRED_TOKEN: \${ROLL_MISSING_REQUIRED_TOKEN}
`,
      "utf-8",
    );

    const addResult = runRoll(["agent", "add", agentDir], workspace);
    assert.equal(addResult.status, 0, addResult.stderr);
    assert.match(addResult.stderr, /仍缺少必填环境变量: REQUIRED_TOKEN, REQUIRED_URL/);
    assert.match(addResult.stderr, /roll config setup agent declared-env-agent/);

    const infoResult = runRoll(["agent", "info", "declared-env-agent"], workspace);
    assert.equal(infoResult.status, 0, infoResult.stderr);
    assert.match(infoResult.stdout, /REQUIRED_TOKEN: \[必填\] 缺失/);

    const doctorResult = runRoll(["doctor", "--json"], workspace);
    assert.equal(doctorResult.status, 1, doctorResult.stderr);

    const checks = JSON.parse(doctorResult.stdout) as ReadonlyArray<{
      readonly name: string;
      readonly status: string;
      readonly message: string;
    }>;

    const envCheck = checks.find((check) => check.name === "Agent 环境变量 (declared-env-agent)");
    assert.ok(envCheck);
    assert.equal(envCheck.status, "fail");
    assert.match(envCheck.message, /REQUIRED_TOKEN/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: agent info compares declared env with runtime diagnostics", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-diagnostic-env-${randomUUID()}-`));

  try {
    const agentDir = resolve(workspace, "diagnostic-env-agent");
    const dataDir = resolve(workspace, "agents-data");
    createDiagnosticEnvFixtureAgent(agentDir);
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

ask:
  confirm-threshold: 0.5

agents:
  data-dir: ${dataDir}
  env:
    diagnostic-env-agent:
      CONFIG_TOKEN: config-token
`,
      "utf-8",
    );

    const addResult = runRoll(["agent", "add", agentDir], workspace);
    assert.equal(addResult.status, 0, addResult.stderr);

    const infoResult = runRoll(["agent", "info", "diagnostic-env-agent"], workspace, {
      env: { SHELL_ONLY_TOKEN: "shell-token" },
    });
    assert.equal(infoResult.status, 0, infoResult.stderr);
    assert.match(infoResult.stdout, /运行态校验: 已验证（diagnostic_status）/);
    assert.match(
      infoResult.stdout,
      /CONFIG_TOKEN: \[必填\] 已配置于 agents\.env；运行态: ✓ from yaml \(stable\)/,
    );
    assert.match(
      infoResult.stdout,
      /SHELL_ONLY_TOKEN: \[必填\] 仅当前 shell 环境；运行态: ⚠ from shell \(ephemeral\)/,
    );
    assert.match(
      infoResult.stdout,
      /OPTIONAL_MODEL: \[可选\] 默认值 \(provider\/default-model\)；运行态: 未设置（使用默认值）/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: doctor surfaces runtime env drift as warn", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-diagnostic-doctor-${randomUUID()}-`));

  try {
    const agentDir = resolve(workspace, "diagnostic-env-agent");
    const dataDir = resolve(workspace, "agents-data");
    createDiagnosticEnvFixtureAgent(agentDir);
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

ask:
  confirm-threshold: 0.5

agents:
  data-dir: ${dataDir}
  env:
    diagnostic-env-agent:
      CONFIG_TOKEN: config-token
`,
      "utf-8",
    );

    const addResult = runRoll(["agent", "add", agentDir], workspace);
    assert.equal(addResult.status, 0, addResult.stderr);

    const doctorResult = runRoll(["doctor", "--json"], workspace, {
      env: { SHELL_ONLY_TOKEN: "shell-token" },
    });
    assert.equal(doctorResult.status, 0, doctorResult.stderr);

    const checks = JSON.parse(doctorResult.stdout) as ReadonlyArray<{
      readonly name: string;
      readonly status: string;
      readonly message: string;
    }>;

    const envCheck = checks.find((check) => check.name === "Agent 环境变量 (diagnostic-env-agent)");
    assert.ok(envCheck);
    assert.equal(envCheck.status, "warn");
    assert.match(envCheck.message, /SHELL_ONLY_TOKEN/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: roll run aggregates missing input fields and env requirements", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-preflight-${randomUUID()}-`));

  try {
    const agentDir = resolve(workspace, "preflight-fixture-agent");
    const dataDir = resolve(workspace, "agents-data");
    createPreflightFixtureAgent(agentDir);
    writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

    const addResult = runRoll(["agent", "add", agentDir], workspace);
    assert.equal(addResult.status, 0, addResult.stderr);

    const runResult = runRoll(
      ["run", "preflight-fixture-agent", "generate_reply", "--input-json", "{}"],
      workspace,
    );
    assert.equal(runResult.status, 1);
    assert.match(runResult.stderr, /A\. 输入缺失 \/ 参数校验/);
    assert.match(runResult.stderr, /field 为必填字段/);
    assert.match(runResult.stderr, /target\.platform 为必填字段/);
    assert.match(runResult.stderr, /target\.recruiterUsername 为必填字段/);
    assert.match(runResult.stderr, /B\. 运行条件缺失/);
    assert.match(runResult.stderr, /REQUIRED_TOKEN/);
    assert.match(runResult.stderr, /agents\.env\.preflight-fixture-agent/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: roll --help includes chat and runtime", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-help-${randomUUID()}-`));

  try {
    const result = runRoll(["--help"], workspace);
    assert.equal(result.status, 0, `roll --help failed\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /\bchat\b/);
    assert.match(result.stdout, /\bruntime\b/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: runtime serve exposes the formal stdio entrypoint", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-runtime-help-${randomUUID()}-`));

  try {
    const help = runRoll(["runtime", "serve", "--help"], workspace);
    assert.equal(
      help.status,
      0,
      `roll runtime serve --help failed\nstdout:\n${help.stdout}\nstderr:\n${help.stderr}`,
    );
    assert.match(`${help.stdout}\n${help.stderr}`, /--stdio/);

    const missingTransport = runRoll(["runtime", "serve"], workspace);
    assert.equal(missingTransport.status, 1);
    assert.match(missingTransport.stderr, /roll runtime serve --stdio/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: roll chat --help renders description", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-chat-help-${randomUUID()}-`));

  try {
    const result = runRoll(["chat", "--help"], workspace);
    assert.equal(result.status, 0, `roll chat --help failed\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /会话/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: roll chat without provider config exits with guidance", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-chat-json-${randomUUID()}-`));

  try {
    const result = runRoll(["chat", "--json"], workspace, { env: { HOME: workspace } });
    assert.equal(
      result.status,
      1,
      `roll chat without provider config should exit 1\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stderr, /未配置/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: roll chat REPL exits cleanly without leaving an empty session", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-chat-repl-${randomUUID()}-`));

  try {
    const dataDir = resolve(workspace, "agents-data");
    const threadsDir = resolve(workspace, "threads");
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `llm:
  default-provider: qwen
  default-model: qwen3.7-plus
  providers:
    qwen:
      api-key: test-key
agents:
  data-dir: ${dataDir}
runtime:
  threads-dir: ${threadsDir}
`,
      "utf-8",
    );

    const chatResult = runRoll(["chat"], workspace, { input: "exit\n" });
    assert.equal(
      chatResult.status,
      0,
      `roll chat REPL should exit cleanly\nstdout:\n${chatResult.stdout}\nstderr:\n${chatResult.stderr}`,
    );
    assert.match(chatResult.stdout, /›/);

    const listResult = runRoll(["chat", "--list", "--json"], workspace);
    assert.equal(listResult.status, 0, listResult.stderr);
    assert.deepEqual(JSON.parse(listResult.stdout) as unknown, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: multi-word help options are rendered as kebab-case", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-help-options-${randomUUID()}-`));

  try {
    const installHelp = runRoll(["agent", "install", "--help"], workspace);
    assert.equal(
      installHelp.status,
      0,
      `roll agent install --help failed\nstdout:\n${installHelp.stdout}\nstderr:\n${installHelp.stderr}`,
    );
    assert.match(installHelp.stdout, /--skip-browser-setup/);
    assert.match(installHelp.stdout, /--no-start/);
    assert.doesNotMatch(installHelp.stdout, /--skipBrowserSetup|--noStart/);

    const updateHelp = runRoll(["update", "--help"], workspace);
    assert.equal(
      updateHelp.status,
      0,
      `roll update --help failed\nstdout:\n${updateHelp.stdout}\nstderr:\n${updateHelp.stderr}`,
    );
    assert.match(updateHelp.stdout, /--skip-browser-setup/);
    assert.doesNotMatch(updateHelp.stdout, /--skipBrowserSetup/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config set help clarifies dotted key syntax", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-help-${randomUUID()}-`));

  try {
    const result = runRoll(["config", "set", "--help"], workspace);
    assert.equal(
      result.status,
      0,
      `config set --help failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /英文句点 [`]?\.[`]? 分隔/);
    assert.match(result.stdout, /ask\.confirm-threshold/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config explain describes install registry", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-explain-${randomUUID()}-`));

  try {
    const result = runRoll(["config", "explain", "install.registry"], workspace);
    assert.equal(
      result.status,
      0,
      `config explain failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /npm Registry/);
    assert.match(result.stdout, /显式|默认源|registry/);
    assert.match(result.stdout, /roll config setup install/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config setup fails clearly without a TTY", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-setup-tty-${randomUUID()}-`));

  try {
    const result = runRoll(["config", "setup", "llm"], workspace);
    assert.equal(
      result.status,
      1,
      `expected non-zero exit\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stderr, /需要交互式终端/);
    assert.match(result.stderr, /roll config set/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config init writes ask section and ask config can be set/get", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-${randomUUID()}-`));
  const homeEnv = { HOME: workspace };

  try {
    const initResult = runRoll(["config", "init"], workspace, { input: "\n\n\n", env: homeEnv });
    assert.equal(
      initResult.status,
      0,
      `config init failed\nstdout:\n${initResult.stdout}\nstderr:\n${initResult.stderr}`,
    );

    const configPath = resolve(workspace, "roll.config.yaml");
    const configText = readFileSync(configPath, "utf-8");
    assert.match(configText, /^ask:/m);
    assert.ok(!configText.includes("router:"));

    const setModelResult = runRoll(["config", "set", "ask.llmModel", "gpt-4.1-mini"], workspace, {
      env: homeEnv,
    });
    assert.equal(
      setModelResult.status,
      0,
      `config set ask.llmModel failed\nstdout:\n${setModelResult.stdout}\nstderr:\n${setModelResult.stderr}`,
    );

    const getModelResult = runRoll(["config", "get", "ask.llmModel"], workspace, { env: homeEnv });
    assert.equal(getModelResult.status, 0, getModelResult.stderr);
    assert.equal(getModelResult.stdout.trim(), "gpt-4.1-mini");

    const setThresholdResult = runRoll(
      ["config", "set", "ask.confirmThreshold", "0.7"],
      workspace,
      { env: homeEnv },
    );
    assert.equal(setThresholdResult.status, 0, setThresholdResult.stderr);

    const getThresholdResult = runRoll(["config", "get", "ask.confirmThreshold"], workspace, {
      env: homeEnv,
    });
    assert.equal(getThresholdResult.status, 0, getThresholdResult.stderr);
    assert.equal(getThresholdResult.stdout.trim(), "0.7");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config get accepts kebab and camel paths equivalently", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-get-codec-${randomUUID()}-`));

  try {
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers:
    anthropic:
      api-key: sk-test
      base-url: https://example.com
agents:
  data-dir: ${resolve(workspace, "agents-data")}
`,
      "utf-8",
    );

    const kebabResult = runRoll(["config", "get", "llm.default-provider"], workspace);
    assert.equal(kebabResult.status, 0, kebabResult.stderr);
    assert.equal(kebabResult.stdout.trim(), "anthropic");

    const camelResult = runRoll(["config", "get", "llm.defaultProvider"], workspace);
    assert.equal(camelResult.status, 0, camelResult.stderr);
    assert.equal(camelResult.stdout.trim(), "anthropic");

    const nestedKebabResult = runRoll(
      ["config", "get", "llm.providers.anthropic.base-url"],
      workspace,
    );
    assert.equal(nestedKebabResult.status, 0, nestedKebabResult.stderr);
    assert.equal(nestedKebabResult.stdout.trim(), "https://example.com");

    const nestedCamelResult = runRoll(
      ["config", "get", "llm.providers.anthropic.baseUrl"],
      workspace,
    );
    assert.equal(nestedCamelResult.status, 0, nestedCamelResult.stderr);
    assert.equal(nestedCamelResult.stdout.trim(), "https://example.com");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: agent list blocks legacy camelCase agents.env keys with migration guidance", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-legacy-agents-env-${randomUUID()}-`));

  try {
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}
agents:
  data-dir: ${resolve(workspace, "agents-data")}
  env:
    smartReplyAgent:
      REPLY_AUTHORITY_URL: https://legacy.example.com
`,
      "utf-8",
    );

    const result = runRoll(["agent", "list"], workspace);
    assert.equal(result.status, 1, `agent list should fail\nstdout:\n${result.stdout}`);
    assert.match(result.stderr, /smartReplyAgent/);
    assert.match(result.stderr, /roll config migrate/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: deprecated router config fails with migration guidance", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-router-migration-${randomUUID()}-`));

  try {
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      buildDeprecatedConfigYaml(resolve(workspace, "agents-data")),
      "utf-8",
    );

    const result = runRoll(["config", "get"], workspace);
    assert.equal(result.status, 1, `config get should fail\nstdout:\n${result.stdout}`);
    assert.match(result.stderr, /`router` 配置段已废弃/);
    assert.match(result.stderr, /ask\.llm-model/);
    assert.match(result.stderr, /ask\.confirm-threshold/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: deprecated runtime.bash config fails with migration guidance", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-runtime-shell-migration-${randomUUID()}-`));

  try {
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

runtime:
  bash:
    enabled: true
    auto-approve-safe: false

agents:
  data-dir: ${resolve(workspace, "agents-data")}
`,
      "utf-8",
    );

    const result = runRoll(["config", "get"], workspace);
    assert.equal(result.status, 1, `config get should fail\nstdout:\n${result.stdout}`);
    assert.match(result.stderr, /`runtime\.bash` 配置段已废弃/);
    assert.match(result.stderr, /runtime\.shell/);
    assert.match(result.stderr, /roll config migrate/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config migrate rewrites router config and creates backup", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-migrate-${randomUUID()}-`));

  try {
    const configPath = resolve(workspace, "roll.config.yaml");
    writeFileSync(
      configPath,
      buildDeprecatedConfigYaml(resolve(workspace, "agents-data")),
      "utf-8",
    );

    const migrateResult = runRoll(["config", "migrate"], workspace);
    assert.equal(
      migrateResult.status,
      0,
      `config migrate failed\nstdout:\n${migrateResult.stdout}\nstderr:\n${migrateResult.stderr}`,
    );
    assert.match(migrateResult.stdout, /配置文件已迁移/);
    assert.match(migrateResult.stdout, /已备份原文件/);

    const migratedConfig = readFileSync(configPath, "utf-8");
    assert.match(migratedConfig, /^ask:/m);
    assert.ok(!migratedConfig.includes("router:"));

    const backupPath = migrateResult.stdout
      .split(/\r?\n/u)
      .find((line) => line.includes("已备份原文件: "))
      ?.split("已备份原文件: ", 2)[1]
      ?.trim();
    assert.ok(backupPath);
    assert.equal(existsSync(backupPath), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config migrate rewrites runtime.bash to runtime.shell", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-runtime-shell-migrate-${randomUUID()}-`));

  try {
    const configPath = resolve(workspace, "roll.config.yaml");
    writeFileSync(
      configPath,
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

runtime:
  bash:
    enabled: true
    auto-approve-safe: false
    session:
      enabled: true

agents:
  data-dir: ${resolve(workspace, "agents-data")}
`,
      "utf-8",
    );

    const migrateResult = runRoll(["config", "migrate"], workspace);
    assert.equal(
      migrateResult.status,
      0,
      `config migrate failed\nstdout:\n${migrateResult.stdout}\nstderr:\n${migrateResult.stderr}`,
    );
    assert.match(migrateResult.stdout, /runtime\.bash/);
    assert.match(migrateResult.stdout, /runtime\.shell/);

    const migratedConfig = readFileSync(configPath, "utf-8");
    assert.match(migratedConfig, /^runtime:/m);
    assert.match(migratedConfig, /shell:/);
    assert.match(migratedConfig, /auto-approve-safe: false/);
    assert.match(migratedConfig, /session:\n\s+enabled: true/);
    assert.ok(!migratedConfig.includes("bash:"));

    const getResult = runRoll(["config", "get", "runtime.shell.enabled"], workspace);
    assert.equal(getResult.status, 0, getResult.stderr);
    assert.match(getResult.stdout, /true/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config migrate fails when router and ask values conflict", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-conflict-${randomUUID()}-`));

  try {
    const configPath = resolve(workspace, "roll.config.yaml");
    writeFileSync(
      configPath,
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}

ask:
  llm-model: gpt-4.1-mini

router:
  llm-model: claude-sonnet-4-6

agents:
  data-dir: ${resolve(workspace, "agents-data")}
`,
      "utf-8",
    );

    const original = readFileSync(configPath, "utf-8");
    const migrateResult = runRoll(["config", "migrate"], workspace);
    assert.equal(migrateResult.status, 1, migrateResult.stdout);
    assert.match(migrateResult.stderr, /值冲突/);
    assert.equal(readFileSync(configPath, "utf-8"), original);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: agent list still works with deprecated router config", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-agent-list-router-${randomUUID()}-`));

  try {
    const smokeAgentPath = resolve(
      import.meta.dirname,
      "../../../../packages/sdk/test-fixtures/smoke-agent",
    );
    const dataDir = resolve(workspace, "agents-data");

    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      buildDeprecatedConfigYaml(dataDir),
      "utf-8",
    );

    const addResult = runRoll(["agent", "add", smokeAgentPath], workspace, {
      env: { ROLL_SKIP_INSTALL: "1" },
    });
    assert.equal(
      addResult.status,
      0,
      `agent add with deprecated router config failed\nstdout:\n${addResult.stdout}\nstderr:\n${addResult.stderr}`,
    );

    const listResult = runRoll(["agent", "list", "--json"], workspace);
    assert.equal(
      listResult.status,
      0,
      `agent list with deprecated router config failed\nstdout:\n${listResult.stdout}\nstderr:\n${listResult.stderr}`,
    );

    const listedAgents = JSON.parse(listResult.stdout) as ReadonlyArray<{
      readonly skill: { readonly name: string };
    }>;
    assert.ok(listedAgents.some((agent) => agent.skill.name === "smoke-test-agent"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: config init suggests migrate when existing config uses deprecated router schema", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-config-init-router-${randomUUID()}-`));

  try {
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      buildDeprecatedConfigYaml(resolve(workspace, "agents-data")),
      "utf-8",
    );

    const result = runRoll(["config", "init"], workspace, { input: "" });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /建议先运行 `roll config migrate`/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: doctor reports config that needs migration", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-doctor-router-${randomUUID()}-`));

  try {
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      buildDeprecatedConfigYaml(resolve(workspace, "agents-data")),
      "utf-8",
    );

    const result = runRoll(["doctor", "--json"], workspace);
    assert.equal(result.status, 0, result.stderr);

    const checks = JSON.parse(result.stdout) as ReadonlyArray<{
      readonly name: string;
      readonly status: string;
      readonly message: string;
    }>;
    const configCheck = checks.find((check) => check.name === "配置文件");
    assert.ok(configCheck);
    assert.equal(configCheck.status, "warn");
    assert.match(configCheck.message, /需要迁移/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: doctor reports invalid config file", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-doctor-invalid-${randomUUID()}-`));

  try {
    writeFileSync(resolve(workspace, "roll.config.yaml"), "llm: [\n", "utf-8");

    const result = runRoll(["doctor", "--json"], workspace);
    assert.equal(result.status, 1, result.stdout);

    const checks = JSON.parse(result.stdout) as ReadonlyArray<{
      readonly name: string;
      readonly status: string;
      readonly message: string;
    }>;
    const configCheck = checks.find((check) => check.name === "配置文件");
    assert.ok(configCheck);
    assert.equal(configCheck.status, "fail");
    assert.match(configCheck.message, /Invalid YAML syntax/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: doctor reports agent env issues from declared requirements", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-doctor-env-${randomUUID()}-`));

  try {
    const agentDir = resolve(workspace, "declared-env-agent");
    const dataDir = resolve(workspace, "agents-data");
    createDeclaredEnvFixtureAgent(agentDir);
    writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

    const addResult = runRoll(["agent", "add", agentDir], workspace, {
      env: { REQUIRED_URL: "https://example.com" },
    });
    assert.equal(addResult.status, 0, addResult.stderr);

    const doctorResult = runRoll(["doctor", "--json"], workspace, {
      env: { REQUIRED_URL: "https://example.com" },
    });
    assert.equal(doctorResult.status, 1, doctorResult.stderr);

    const checks = JSON.parse(doctorResult.stdout) as ReadonlyArray<{
      readonly name: string;
      readonly status: string;
      readonly message: string;
    }>;

    const envCheck = checks.find((check) => check.name === "Agent 环境变量 (declared-env-agent)");
    assert.ok(envCheck);
    assert.equal(envCheck.status, "fail");
    assert.match(envCheck.message, /REQUIRED_TOKEN/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: update --check warns about deprecated config without failing", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-update-check-router-${randomUUID()}-`));

  try {
    const fakeBinDir = resolve(workspace, "fake-bin");
    createFakeNpm(fakeBinDir, "0.2.1");
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      buildDeprecatedConfigYaml(resolve(workspace, "agents-data")),
      "utf-8",
    );

    const result = runRoll(["update", "--check"], workspace, {
      env: {
        HOME: workspace,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
      },
    });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stderr, /检测到本地配置需要迁移/);
    assert.match(result.stderr, /roll config migrate/);
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

test("e2e smoke: agent health --json returns empty array when no agents are registered", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-health-empty-${randomUUID()}-`));

  try {
    writeFileSync(
      resolve(workspace, "roll.config.yaml"),
      buildConfigYaml(resolve(workspace, "agents-data")),
      "utf-8",
    );

    const result = runRoll(["agent", "health", "--json"], workspace);
    assert.equal(result.status, 0, `agent health --json failed\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), "[]");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

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

test(
  "e2e smoke: failed agent start cleans its runtime after health writes error",
  {
    timeout: 120_000,
  },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-start-health-race-${randomUUID()}-`));
    const agentDir = resolve(workspace, "http-fixture-agent");
    const dataDir = resolve(workspace, "agents-data");
    let startProcess: SpawnedRollProcess | undefined;
    let agentPid: number | undefined;

    try {
      const port = await getFreeLocalPort();
      createCoreManagedHttpFixtureAgent(agentDir, port, {
        startupDelayMs: 30_000,
        createBrokenDistEntry: true,
      });
      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");
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
          `agent PID: ${readAgentPidFile(dataDir, "http-fixture-agent") ?? "<missing>"}`,
          formatSpawnedRollProcess("roll agent start", spawnedStart),
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

      const healthResult = runRoll(["agent", "health", "--json"], workspace, {
        env: rollEnv,
      });
      assert.equal(
        healthResult.status,
        1,
        `health should mark the still-starting Agent as error\nstdout:\n${healthResult.stdout}\nstderr:\n${healthResult.stderr}\n${diagnostics()}`,
      );
      const health = JSON.parse(healthResult.stdout) as ReadonlyArray<{
        readonly agentName: string;
        readonly healthy: boolean;
        readonly message: string;
      }>;
      const fixtureHealth = health.find((entry) => entry.agentName === "http-fixture-agent");
      assert.ok(fixtureHealth);
      assert.equal(fixtureHealth.healthy, false);
      assert.match(fixtureHealth.message, /进程存在但不可连接/u);
      assert.equal(spawnedStart.child.exitCode, null, diagnostics());

      const startExit = await waitForSpawnedRollExit(spawnedStart, "roll agent start", 25_000);
      assert.equal(startExit.code, 1, diagnostics());
      assert.match(spawnedStart.output.stderr, /did not become ready within 15000ms/u);
      await waitForSmokeCondition(
        "the failed start runtime to be stopped after the health status update",
        () =>
          agentPid !== undefined &&
          !isProcessAlive(agentPid) &&
          readAgentPidFile(dataDir, "http-fixture-agent") === undefined,
        diagnostics,
      );
      assert.equal(countAgentUsageLeaseFiles(dataDir, "http-fixture-agent"), 0, diagnostics());
    } finally {
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

test(
  "e2e smoke: failed agent start cleans its runtime when registry finalization times out",
  {
    timeout: 180_000,
  },
  async () => {
    const workspace = mkdtempSync(
      resolve(tmpdir(), `roll-start-registry-timeout-${randomUUID()}-`),
    );
    const agentDir = resolve(workspace, "http-fixture-agent");
    const dataDir = resolve(workspace, "agents-data");
    const lockMarkerPath = resolve(workspace, "registry-lock-held");
    const lockHolderPath = resolve(workspace, "hold-registry-lock.mjs");
    let startProcess: SpawnedRollProcess | undefined;
    let lockHolder: SpawnedRollProcess | undefined;
    let agentPid: number | undefined;

    try {
      const port = await getFreeLocalPort();
      createCoreManagedHttpFixtureAgent(agentDir, port, {
        startupDelayMs: 60_000,
        createBrokenDistEntry: true,
      });
      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");
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

      const registryLockModule = resolve(import.meta.dirname, "../registry/agent-registry-lock.ts");
      writeFileSync(
        lockHolderPath,
        `import { writeFileSync } from "node:fs";
import { acquireAgentRegistryLockAsync } from ${JSON.stringify(registryLockModule)};

const lock = await acquireAgentRegistryLockAsync(${JSON.stringify(dataDir)});
writeFileSync(${JSON.stringify(lockMarkerPath)}, "locked", "utf-8");
const release = () => {
  lock.release();
  process.exit(0);
};
process.stdin.once("data", release);
process.once("SIGTERM", release);
setTimeout(release, 45_000);
await new Promise(() => {});
`,
        "utf-8",
      );

      const spawnedStart = spawnRollProcess(
        ["agent", "start", "http-fixture-agent"],
        workspace,
        rollEnv,
      );
      startProcess = spawnedStart;
      const diagnostics = () =>
        [
          `registry lock marker: ${existsSync(lockMarkerPath) ? "present" : "missing"}`,
          `agent PID: ${readAgentPidFile(dataDir, "http-fixture-agent") ?? "<missing>"}`,
          formatSpawnedRollProcess("roll agent start", spawnedStart),
          ...(lockHolder === undefined
            ? []
            : [formatSpawnedRollProcess("registry lock holder", lockHolder)]),
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

      const spawnedLockHolder = spawnNodeScriptProcess(lockHolderPath, workspace);
      lockHolder = spawnedLockHolder;
      await waitForSmokeCondition(
        "the independent process to hold the registry lock",
        () => {
          if (
            spawnedLockHolder.child.exitCode !== null ||
            spawnedLockHolder.child.signalCode !== null
          ) {
            throw new Error(`registry lock holder exited early\n${diagnostics()}`);
          }
          return existsSync(lockMarkerPath);
        },
        diagnostics,
      );

      const startExit = await waitForSpawnedRollExit(spawnedStart, "roll agent start", 45_000);
      assert.equal(startExit.code, 1, diagnostics());
      assert.match(spawnedStart.output.stderr, /did not become ready within 15000ms/u);
      assert.match(spawnedStart.output.stderr, /已按 runtime identity 安全回收新进程/u);
      assert.match(spawnedStart.output.stderr, /Agent 注册表正在被另一项操作修改/u);
      await waitForSmokeCondition(
        "the failed start runtime to be stopped despite the registry lock",
        () =>
          agentPid !== undefined &&
          !isProcessAlive(agentPid) &&
          readAgentPidFile(dataDir, "http-fixture-agent") === undefined,
        diagnostics,
      );
      assert.equal(countAgentUsageLeaseFiles(dataDir, "http-fixture-agent"), 0, diagnostics());
    } finally {
      await cleanupSpawnedRollProcess(startProcess, "roll agent start");
      await cleanupSpawnedRollProcess(lockHolder, "registry lock holder");
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

test(
  "e2e smoke: core-managed http agent can start, report health, and stop",
  {
    timeout: 120_000,
  },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-http-agent-${randomUUID()}-`));

    try {
      const agentDir = resolve(workspace, "http-fixture-agent");
      const dataDir = resolve(workspace, "agents-data");
      const port = await getFreeLocalPort();

      createCoreManagedHttpFixtureAgent(agentDir, port, {
        shutdownDelayMs: 1_200,
        createBrokenDistEntry: true,
      });
      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

      const addResult = runRoll(["agent", "add", agentDir], workspace, {
        env: { ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(
        addResult.status,
        0,
        `agent add failed\nstdout:\n${addResult.stdout}\nstderr:\n${addResult.stderr}`,
      );

      const startResult = runRoll(["agent", "start", "http-fixture-agent"], workspace);
      assert.equal(startResult.status, 0, formatHttpFixtureStartFailure(startResult, dataDir));
      assert.match(startResult.stderr, /已启动|已在运行/);

      const healthResult = runRoll(["agent", "health", "--json"], workspace);
      assert.equal(
        healthResult.status,
        0,
        `agent health failed\nstdout:\n${healthResult.stdout}\nstderr:\n${healthResult.stderr}`,
      );
      const health = JSON.parse(healthResult.stdout) as ReadonlyArray<{
        readonly agentName: string;
        readonly healthy: boolean;
        readonly message: string;
      }>;
      const runningEntry = health.find((entry) => entry.agentName === "http-fixture-agent");
      assert.ok(runningEntry);
      assert.equal(runningEntry.healthy, true);
      assert.match(runningEntry.message, /运行中|可连接/);

      const stopResult = runRoll(["agent", "stop", "http-fixture-agent"], workspace);
      assert.equal(
        stopResult.status,
        0,
        `agent stop failed\nstdout:\n${stopResult.stdout}\nstderr:\n${stopResult.stderr}`,
      );
      assert.match(stopResult.stderr, /已停止|当前未运行/);

      const healthAfterStopResult = runRoll(["agent", "health", "--json"], workspace);
      assert.equal(
        healthAfterStopResult.status,
        1,
        `agent health after stop should report unhealthy\nstdout:\n${healthAfterStopResult.stdout}\nstderr:\n${healthAfterStopResult.stderr}`,
      );
      const healthAfterStop = JSON.parse(healthAfterStopResult.stdout) as ReadonlyArray<{
        readonly agentName: string;
        readonly healthy: boolean;
        readonly message: string;
      }>;
      const stoppedEntry = healthAfterStop.find(
        (entry) => entry.agentName === "http-fixture-agent",
      );
      assert.ok(stoppedEntry);
      assert.equal(stoppedEntry.healthy, false);
      assert.match(stoppedEntry.message, /未运行|PID/);
    } finally {
      runRoll(["agent", "stop", "http-fixture-agent"], workspace);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "e2e smoke: agent stop recovers an interrupted lease release only after confirmation",
  {
    timeout: 120_000,
  },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-http-recover-${randomUUID()}-`));
    const agentName = "http-fixture-agent";
    let runtimePid: number | undefined;

    try {
      const agentDir = resolve(workspace, agentName);
      const dataDir = resolve(workspace, "agents-data");
      const port = await getFreeLocalPort();

      createCoreManagedHttpFixtureAgent(agentDir, port, { createBrokenDistEntry: true });
      writeFileSync(resolve(workspace, "roll.config.yaml"), buildConfigYaml(dataDir), "utf-8");

      const addResult = runRoll(["agent", "add", agentDir], workspace, {
        env: { ROLL_SKIP_INSTALL: "1" },
      });
      assert.equal(addResult.status, 0, addResult.stderr);

      const startResult = runRoll(["agent", "start", agentName], workspace);
      assert.equal(startResult.status, 0, formatHttpFixtureStartFailure(startResult, dataDir));
      const runtime = readAgentRuntimeSnapshot(dataDir, agentName);
      assert.ok(runtime);
      runtimePid = runtime.pid;
      const releasePath = writeInterruptedAgentRelease(dataDir, agentName);

      const healthResult = runRoll(["agent", "health", "--json"], workspace);
      assert.equal(healthResult.status, 1, healthResult.stderr);
      const health = JSON.parse(healthResult.stdout) as ReadonlyArray<{
        readonly agentName: string;
        readonly healthy: boolean;
        readonly message: string;
        readonly recovery?: {
          readonly status: string;
          readonly command?: string;
        };
      }>;
      const healthEntry = health.find((entry) => entry.agentName === agentName);
      assert.ok(healthEntry);
      assert.equal(healthEntry.healthy, false);
      assert.equal(healthEntry.recovery?.status, "recoverable");
      assert.equal(healthEntry.recovery?.command, `roll agent stop ${agentName}`);
      assert.match(healthEntry.message, /--recover/u);

      const doctorResult = runRoll(["doctor", "--json", "--fix-plan"], workspace);
      assert.equal(doctorResult.status, 0, doctorResult.stderr);
      const doctorChecks = JSON.parse(doctorResult.stdout) as ReadonlyArray<{
        readonly name: string;
        readonly fix?: string;
        readonly details?: {
          readonly type?: string;
          readonly status?: string;
        };
      }>;
      const leaseCheck = doctorChecks.find(
        (check) => check.name === `Agent usage lease (${agentName})`,
      );
      assert.ok(leaseCheck);
      assert.equal(leaseCheck.details?.type, "agent-usage-stop-recovery");
      assert.equal(leaseCheck.details?.status, "recoverable");
      assert.match(leaseCheck.fix ?? "", /agent stop http-fixture-agent --recover/u);

      const unconfirmedStop = runRoll(["agent", "stop", agentName], workspace);
      assert.equal(unconfirmedStop.status, 1);
      assert.match(unconfirmedStop.stderr, /上次停止未完成/u);
      assert.match(unconfirmedStop.stderr, new RegExp(`Agent\\s+${agentName}`, "u"));
      assert.match(
        unconfirmedStop.stderr,
        new RegExp(`Runtime\\s+PID ${String(runtime.pid)}`, "u"),
      );
      assert.match(unconfirmedStop.stderr, /残留记录\s+1 个/u);
      assert.match(unconfirmedStop.stderr, /中断来源\s+roll chat · PID \d+ 已退出/u);
      assert.match(unconfirmedStop.stderr, /当前状态\s+未发现其他 Roll 进程正在使用此 Agent/u);
      assert.match(unconfirmedStop.stderr, /当前环境无法显示确认菜单/u);
      assert.equal(unconfirmedStop.stderr.includes(releasePath), false);
      assert.doesNotMatch(unconfirmedStop.stderr, /\.releasing\.json/u);
      assert.equal(existsSync(releasePath), true);
      assert.equal(isProcessAlive(runtime.pid), true);

      const recoveredStop = runRoll(["agent", "stop", agentName, "--recover"], workspace);
      assert.equal(
        recoveredStop.status,
        0,
        `agent stop --recover failed\nstdout:\n${recoveredStop.stdout}\nstderr:\n${recoveredStop.stderr}`,
      );
      assert.match(recoveredStop.stderr, /已清理 1 个残留记录并停止/u);
      assert.equal(existsSync(releasePath), false);
      assert.equal(isProcessAlive(runtime.pid), false);
      assert.equal(readAgentPidFile(dataDir, agentName), undefined);
    } finally {
      runRoll(["agent", "stop", agentName, "--recover"], workspace);
      if (runtimePid !== undefined && isProcessAlive(runtimePid)) {
        forceKillProcess(runtimePid);
      }
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "e2e smoke: removing a running core-managed http agent stops it and deregisters it",
  {
    timeout: 120_000,
  },
  async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), `roll-http-remove-${randomUUID()}-`));

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

      const removeResult = runRoll(["agent", "remove", "http-fixture-agent"], workspace);
      assert.equal(
        removeResult.status,
        0,
        `agent remove failed\nstdout:\n${removeResult.stdout}\nstderr:\n${removeResult.stderr}`,
      );
      assert.match(removeResult.stderr, /已移除/);

      const listResult = runRoll(["agent", "list", "--json"], workspace);
      assert.equal(listResult.status, 0, listResult.stderr);
      const agents = JSON.parse(listResult.stdout) as ReadonlyArray<{
        readonly skill: { readonly name: string };
      }>;
      assert.ok(!agents.some((agent) => agent.skill.name === "http-fixture-agent"));
    } finally {
      runRoll(["agent", "stop", "http-fixture-agent"], workspace);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

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
