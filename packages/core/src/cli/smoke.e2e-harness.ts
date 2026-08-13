import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";

export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunRollOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}

export interface SpawnedRollProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly output: {
    stdout: string;
    stderr: string;
  };
}

export interface ChildExitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface AgentRuntimeSnapshot {
  readonly raw: string;
  readonly pid: number;
  readonly retention: string;
  readonly processStartToken: string;
  readonly startedAt: string;
}

export const CURRENT_CORE_VERSION = readCurrentCoreVersion();
export const NEXT_PATCH_CORE_VERSION = bumpPatchVersion(CURRENT_CORE_VERSION);

export function runRoll(
  args: readonly string[],
  cwd: string,
  options: RunRollOptions = {},
): CliResult {
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

export function spawnRollProcess(
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

export function spawnNodeScriptProcess(scriptPath: string, cwd: string): SpawnedRollProcess {
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

export function formatSpawnedRollProcess(label: string, process: SpawnedRollProcess): string {
  return `${label} (PID: ${String(process.child.pid ?? "unavailable")})
stdout:
${process.output.stdout || "<empty>"}
stderr:
${process.output.stderr || "<empty>"}`;
}

export async function waitForSmokeCondition(
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

export async function waitForSpawnedRollExit(
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

export async function exitRollChat(process: SpawnedRollProcess, label: string): Promise<void> {
  process.child.stdin.write("exit\n");
  const result = await waitForSpawnedRollExit(process, label);
  assert.equal(
    result.code,
    0,
    `${label} should exit cleanly (signal: ${String(result.signal)})\n${formatSpawnedRollProcess(label, process)}`,
  );
}

export async function cleanupSpawnedRollProcess(
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

export function countAgentUsageLeaseFiles(dataDir: string, agentName: string): number {
  const digest = createHash("sha256").update(agentName).digest("hex");
  const leaseDir = resolve(dataDir, "pids", ".leases", digest);
  if (!existsSync(leaseDir)) return 0;
  return readdirSync(leaseDir).filter((entry) => entry.endsWith(".json")).length;
}

export function readAgentPidFile(dataDir: string, agentName: string): string | undefined {
  const pidPath = resolve(dataDir, "pids", `${agentName}.pid`);
  return existsSync(pidPath) ? readFileSync(pidPath, "utf-8").trim() : undefined;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function forceKillProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

export function readAgentRuntimeSnapshot(
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

export function writeInterruptedAgentRelease(dataDir: string, agentName: string): string {
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

export async function getFreeLocalPort(): Promise<number> {
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

export function readHttpFixtureAgentLog(dataDir: string): string {
  const logPath = resolve(dataDir, "logs", "http-fixture-agent.log");
  if (!existsSync(logPath)) {
    return `agent log not found: ${logPath}`;
  }

  const content = readFileSync(logPath, "utf-8").trim();
  return `agent log (${logPath}):\n${content.length > 0 ? content : "<empty>"}`;
}

export function formatHttpFixtureStartFailure(result: CliResult, dataDir: string): string {
  return `agent start failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n${readHttpFixtureAgentLog(dataDir)}`;
}

export function buildConfigYaml(dataDir: string): string {
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

export function buildDeprecatedConfigYaml(dataDir: string): string {
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

export function readCurrentCoreVersion(): string {
  const packageJsonPath = resolve(import.meta.dirname, "../../package.json");
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`Unable to read @roll-agent/core version from ${packageJsonPath}`);
  }
  return parsed.version;
}

export function bumpPatchVersion(version: string): string {
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

export function createFakeNpm(
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

export function createDefaultRegistryBait(workspace: string): {
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

export function createFakeNpmAgentInstaller(
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

export function createCoreManagedHttpFixtureAgent(
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

export function createDeclaredEnvFixtureAgent(agentDir: string): void {
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

export function createDiagnosticEnvFixtureAgent(agentDir: string): void {
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

export function createPreflightFixtureAgent(agentDir: string): void {
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
