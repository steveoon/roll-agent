import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../config/defaults.ts";
import { installAgent } from "./install.ts";
import { AgentStore } from "./store.ts";
import type { InstallAgentDeps, InstallAgentEvent, InstallAgentInput } from "./install.ts";
import type { PackageManagerRunSpec } from "../cli/utils/package-manager.ts";
import type { DiscoveredAgent } from "./discovery.ts";
import type { AgentSetupResult } from "./runtime-setup.ts";
import type { RegisteredAgent } from "../types/agent.ts";

const workRoot = mkdtempSync(join(tmpdir(), "roll-install-agent-test-"));

after(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

let caseCounter = 0;

function makeDataDir(): string {
  caseCounter += 1;
  const dir = join(workRoot, `case-${caseCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function installedAgentDir(dataDir: string): string {
  return join(dataDir, "installed", "fake-agent-package");
}

function installLockPath(dataDir: string): string {
  return join(dataDir, "installed", ".fake-agent-package.install.lock");
}

function makeDiscovered(overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent {
  return {
    skill: { name: "fake-agent", description: "测试 agent", metadata: {} },
    transport: { type: "stdio", command: "node" },
    runtime: { ownership: "on-demand" },
    skillPath: "/fake/SKILL.md",
    skillBody: "",
    ...overrides,
  };
}

interface HarnessOptions {
  readonly dataDir: string;
  readonly discovered?: DiscoveredAgent;
  readonly runInstall?: (spec: PackageManagerRunSpec) => Promise<void>;
  readonly runSetup?: () => Promise<AgentSetupResult>;
  readonly waitReady?: () => Promise<void>;
}

function makeDeps(options: HarnessOptions): {
  readonly deps: InstallAgentDeps;
  readonly events: InstallAgentEvent[];
  readonly store: AgentStore;
  readonly calls: string[];
} {
  const events: InstallAgentEvent[] = [];
  const calls: string[] = [];
  const store = new AgentStore(options.dataDir);

  const deps: InstallAgentDeps = {
    agentsConfig: { ...DEFAULT_CONFIG.agents, dataDir: options.dataDir },
    installConfig: DEFAULT_CONFIG.install,
    getStartEnv: () => ({}),
    store,
    report: (event) => events.push(event),
    collaborators: {
      runInstall: async (spec) => {
        calls.push("runInstall");
        const prefixIndex = spec.args.indexOf("--prefix");
        const installPrefix = spec.args[prefixIndex + 1];
        if (installPrefix === undefined) {
          throw new Error("install spec 缺少 --prefix 参数值");
        }
        mkdirSync(join(installPrefix, "fake-package-root"), { recursive: true });
        if (options.runInstall) {
          await options.runInstall(spec);
        }
        return { stdout: "", stderr: "" };
      },
      discover: () => {
        calls.push("discover");
        return options.discovered ?? makeDiscovered();
      },
      runSetup: async () => {
        calls.push("runSetup");
        if (options.runSetup) {
          return options.runSetup();
        }
        return { ok: true, skipped: true, message: "无需额外 setup" };
      },
      start: () => {
        calls.push("start");
        return 12345;
      },
      waitReady: async () => {
        calls.push("waitReady");
        if (options.waitReady) {
          await options.waitReady();
        }
      },
      stopGracefully: async () => {
        calls.push("stopGracefully");
        return true;
      },
      resolvePackageRoot: (installDir) => join(installDir, "fake-package-root"),
      readManifest: () => ({ name: "@fake/agent-package", version: "1.2.3" }),
    },
  };

  return { deps, events, store, calls };
}

const BASE_INPUT: InstallAgentInput = { packageSpec: "@fake/agent-package" };

describe("installAgent", () => {
  it("成功链路：事件顺序、注册与版本写入", async () => {
    const dataDir = makeDataDir();
    const { deps, events, store } = makeDeps({ dataDir });

    const result = await installAgent(BASE_INPUT, deps);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.agent.skill.name, "fake-agent");
      assert.equal(result.started, false);
      assert.equal(result.envReport, undefined);
      assert.equal(
        result.agent.installPath,
        join(dataDir, "installed", "fake-agent-package", "fake-package-root"),
      );
    }

    const stepEvents = events.filter((event) => event.type === "step");
    assert.deepEqual(
      stepEvents.map((event) => (event.type === "step" ? event.step : "")),
      ["download", "discover"],
    );

    const registered = store.findByName("fake-agent");
    assert.equal(registered?.source?.type, "installed-package");
    if (registered?.source?.type === "installed-package") {
      assert.equal(registered.source.packageName, "@fake/agent-package");
      assert.equal(registered.source.installedVersion, "1.2.3");
    }
  });

  it("git URL 与本地目录 spec 在 resolve 阶段拒绝", async () => {
    const dataDir = makeDataDir();
    const { deps } = makeDeps({ dataDir });

    const gitResult = await installAgent({ packageSpec: "git@github.com:org/agent.git" }, deps);
    assert.equal(gitResult.ok, false);
    if (!gitResult.ok) {
      assert.equal(gitResult.step, "resolve");
      assert.match(gitResult.message, /roll agent add/);
    }

    const dirResult = await installAgent({ packageSpec: dataDir }, deps);
    assert.equal(dirResult.ok, false);
    if (!dirResult.ok) {
      assert.equal(dirResult.step, "resolve");
    }
  });

  it("拒绝符号链接 installDir 且不会开始下载", async () => {
    const dataDir = makeDataDir();
    const installDir = join(dataDir, "installed", "fake-agent-package");
    const symlinkTarget = join(dataDir, "symlink-target");
    mkdirSync(join(dataDir, "installed"), { recursive: true });
    mkdirSync(symlinkTarget, { recursive: true });
    symlinkSync(symlinkTarget, installDir, process.platform === "win32" ? "junction" : "dir");
    const { deps, calls } = makeDeps({ dataDir });

    const result = await installAgent(BASE_INPUT, deps);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "resolve");
      assert.match(result.message, /符号链接/);
    }
    assert.deepEqual(calls, []);
    assert.equal(lstatSync(installDir).isSymbolicLink(), true);
    assert.equal(existsSync(symlinkTarget), true);
  });

  it("拒绝带有同级安装锁的 installDir，并给出安全的人工恢复提示", async () => {
    const dataDir = makeDataDir();
    const installDir = installedAgentDir(dataDir);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      installLockPath(dataDir),
      JSON.stringify({ token: "another-install", pid: 12345, startedAt: "2026-01-01T00:00:00Z" }),
      "utf8",
    );
    const { deps, calls } = makeDeps({ dataDir });

    const result = await installAgent(BASE_INPUT, deps);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "resolve");
      assert.match(result.message, /检查锁文件中的 pid/);
      assert.match(result.message, /不会自动抢占/);
      assert.match(result.message, /\.fake-agent-package\.install\.lock/);
    }
    assert.deepEqual(calls, []);
  });

  it("npm install 失败返回 download 失败且不注册", async () => {
    const dataDir = makeDataDir();
    const { deps, store } = makeDeps({
      dataDir,
      runInstall: async () => {
        throw new Error("network down");
      },
    });

    const result = await installAgent(BASE_INPUT, deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "download");
      assert.match(result.message, /安装失败/);
    }
    assert.equal(store.findByName("fake-agent"), undefined);
    assert.equal(existsSync(installedAgentDir(dataDir)), false);
    assert.equal(existsSync(installLockPath(dataDir)), false);
  });

  it("npm install 失败不清理调用前已经存在的 installDir", async () => {
    const dataDir = makeDataDir();
    const installDir = join(dataDir, "installed", "fake-agent-package");
    const existingMarker = join(installDir, "existing-content");
    mkdirSync(existingMarker, { recursive: true });
    const { deps } = makeDeps({
      dataDir,
      runInstall: async () => {
        throw new Error("network down");
      },
    });

    const result = await installAgent(BASE_INPUT, deps);

    assert.equal(result.ok, false);
    assert.equal(existsSync(existingMarker), true);
    assert.equal(existsSync(installLockPath(dataDir)), false);
  });

  it("并发首次安装在 download 前互斥，失败方不会删除成功方目录", async () => {
    const dataDir = makeDataDir();
    const firstDownload = Promise.withResolvers<void>();
    let downloadCount = 0;
    const { deps, calls } = makeDeps({
      dataDir,
      runInstall: async () => {
        downloadCount += 1;
        await firstDownload.promise;
      },
    });

    const firstInstall = installAgent(BASE_INPUT, deps);
    assert.equal(downloadCount, 1);
    const secondResult = await installAgent(BASE_INPUT, deps);

    assert.equal(secondResult.ok, false);
    if (!secondResult.ok) {
      assert.equal(secondResult.step, "resolve");
      assert.match(secondResult.message, /锁文件/);
    }
    assert.equal(downloadCount, 1);
    assert.equal(calls.filter((call) => call === "runInstall").length, 1);
    assert.equal(existsSync(installedAgentDir(dataDir)), true);
    assert.equal(existsSync(installLockPath(dataDir)), true);

    firstDownload.resolve();
    const firstResult = await firstInstall;
    assert.equal(firstResult.ok, true);
    assert.equal(existsSync(join(installedAgentDir(dataDir), "fake-package-root")), true);
    assert.equal(existsSync(installLockPath(dataDir)), false);
    assert.equal(calls.filter((call) => call === "runSetup").length, 1);
  });

  it("npm lifecycle 始终看到稳定 final prefix，锁记录可审计字段并在成功后释放", async () => {
    const dataDir = makeDataDir();
    const installDir = installedAgentDir(dataDir);
    const lockPath = installLockPath(dataDir);
    const { deps } = makeDeps({
      dataDir,
      runInstall: async (spec) => {
        const prefixIndex = spec.args.indexOf("--prefix");
        assert.equal(spec.args[prefixIndex + 1], installDir);
        assert.equal(existsSync(installDir), true);
        const marker: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
        assert.equal(typeof marker, "object");
        assert.notEqual(marker, null);
        if (typeof marker === "object" && marker !== null) {
          assert.equal(typeof Reflect.get(marker, "token"), "string");
          assert.equal(Reflect.get(marker, "pid"), process.pid);
          assert.match(String(Reflect.get(marker, "startedAt")), /^\d{4}-\d{2}-\d{2}T/);
        }
      },
    });

    const result = await installAgent(BASE_INPUT, deps);

    assert.equal(result.ok, true);
    assert.equal(existsSync(lockPath), false);
  });

  it("discover 抛错返回 discover 失败", async () => {
    const dataDir = makeDataDir();
    const { deps } = makeDeps({ dataDir });
    const failingDeps: InstallAgentDeps = {
      ...deps,
      collaborators: {
        ...deps.collaborators,
        discover: () => {
          throw new Error("SKILL.md 缺少 name");
        },
      },
    };

    const result = await installAgent(BASE_INPUT, failingDeps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "discover");
      assert.match(result.message, /SKILL.md/);
    }
    assert.equal(existsSync(join(dataDir, "installed", "fake-agent-package")), false);
  });

  it("安装后找不到 package root 时清理新建 installDir", async () => {
    const dataDir = makeDataDir();
    const { deps } = makeDeps({ dataDir });
    const missingPackageRoot = join(dataDir, "missing-package-root");
    const failingDeps: InstallAgentDeps = {
      ...deps,
      collaborators: {
        ...deps.collaborators,
        resolvePackageRoot: () => missingPackageRoot,
      },
    };

    const result = await installAgent(BASE_INPUT, failingDeps);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "discover");
      assert.match(result.message, /未找到包目录/);
    }
    assert.equal(existsSync(join(dataDir, "installed", "fake-agent-package")), false);
  });

  it("读取安装包 manifest 抛错时保留原始异常并清理新建 installDir", async () => {
    const dataDir = makeDataDir();
    const { deps } = makeDeps({ dataDir });
    const failingDeps: InstallAgentDeps = {
      ...deps,
      collaborators: {
        ...deps.collaborators,
        readManifest: () => {
          throw new Error("manifest unreadable");
        },
      },
    };

    await assert.rejects(() => installAgent(BASE_INPUT, failingDeps), /manifest unreadable/);
    assert.equal(existsSync(join(dataDir, "installed", "fake-agent-package")), false);
  });

  it("setup 失败：agent 注册为 error 且透传 retryCommand", async () => {
    const dataDir = makeDataDir();
    const { deps, store } = makeDeps({
      dataDir,
      runSetup: async () => ({
        ok: false,
        skipped: false,
        message: "playwright 安装失败",
        retryCommand: "npx playwright install chromium",
      }),
    });

    const result = await installAgent(BASE_INPUT, deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "setup");
      assert.equal(result.retryCommand, "npx playwright install chromium");
    }
    assert.equal(store.findByName("fake-agent")?.status, "error");
    assert.equal(existsSync(join(dataDir, "installed", "fake-agent-package")), true);
  });

  it("setup 抛错且尚未注册时保留原始异常并清理新建 installDir", async () => {
    const dataDir = makeDataDir();
    const { deps } = makeDeps({
      dataDir,
      runSetup: async () => {
        throw new Error("setup crashed");
      },
    });

    await assert.rejects(() => installAgent(BASE_INPUT, deps), /setup crashed/);
    assert.equal(existsSync(join(dataDir, "installed", "fake-agent-package")), false);
  });

  it("同名 installed-package 走升级替换且不输出其他来源替换提示", async () => {
    const dataDir = makeDataDir();
    const { deps, store, events } = makeDeps({ dataDir });

    const preRegistered: RegisteredAgent = {
      skill: { name: "fake-agent", description: "旧版", metadata: {} },
      transport: { type: "stdio", command: "node" },
      runtime: { ownership: "on-demand" },
      installPath: "/old/path",
      registeredAt: "2026-01-01T00:00:00.000Z",
      status: "idle",
      source: {
        type: "installed-package",
        packageName: "@fake/agent-package",
        packageSpec: "@fake/agent-package",
        installDir: "/old/install",
        installedVersion: "1.0.0",
      },
    };
    store.add(preRegistered);

    const replaceResult = await installAgent(BASE_INPUT, deps);
    assert.equal(replaceResult.ok, true);
    assert.equal(store.list().length, 1);
    const replaced = store.findByName("fake-agent");
    if (replaced?.source?.type === "installed-package") {
      assert.equal(replaced.source.installedVersion, "1.2.3");
    }
    assert.equal(
      events.some(
        (event) =>
          event.type === "info" &&
          event.message.includes("已通过") &&
          event.message.includes("替换"),
      ),
      false,
      "同名 installed-package 升级不应提示「其他来源替换」",
    );
  });

  it("expectedSkillName 命中非 npm 来源时默认在 download 前失败", async () => {
    const dataDir = makeDataDir();
    const { deps, store, calls } = makeDeps({ dataDir });
    store.add({
      skill: { name: "fake-agent", description: "本地开发版", metadata: {} },
      transport: { type: "stdio", command: "node" },
      runtime: { ownership: "on-demand" },
      installPath: "/repo/fake-agent",
      registeredAt: "2026-01-01T00:00:00.000Z",
      status: "idle",
      source: { type: "local-path", path: "/repo/fake-agent" },
    });

    const result = await installAgent({ ...BASE_INPUT, expectedSkillName: "fake-agent" }, deps);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "register");
      assert.match(result.message, /默认不会替换为 npm 安装/);
      assert.match(result.retryCommand ?? "", /--force/);
    }
    assert.deepEqual(calls, []);
    assert.equal(store.findByName("fake-agent")?.source?.type, "local-path");
  });

  it("replaceExisting=true 时允许非 npm 来源替换并输出明确 info", async () => {
    const dataDir = makeDataDir();
    const { deps, store, events } = makeDeps({ dataDir });
    store.add({
      skill: { name: "fake-agent", description: "本地开发版", metadata: {} },
      transport: { type: "stdio", command: "node" },
      runtime: { ownership: "on-demand" },
      installPath: "/repo/fake-agent",
      registeredAt: "2026-01-01T00:00:00.000Z",
      status: "idle",
      source: { type: "local-path", path: "/repo/fake-agent" },
    });

    const otherSourceResult = await installAgent(
      { ...BASE_INPUT, expectedSkillName: "fake-agent", replaceExisting: true },
      deps,
    );
    assert.equal(otherSourceResult.ok, true);
    assert.equal(store.list().length, 1);
    const npmReplaced = store.findByName("fake-agent");
    assert.equal(npmReplaced?.source?.type, "installed-package");
    if (npmReplaced?.source?.type === "installed-package") {
      assert.equal(npmReplaced.source.installedVersion, "1.2.3");
    }
    assert.ok(
      events.some(
        (event) =>
          event.type === "info" &&
          event.message.includes("local-path") &&
          event.message.includes("替换为 npm 安装"),
      ),
      "其他来源替换应输出明确 info",
    );
  });

  it("discover 后才发现非 npm 同名冲突时失败并清理新建 installDir", async () => {
    const dataDir = makeDataDir();
    const { deps, store, calls } = makeDeps({ dataDir });
    store.add({
      skill: { name: "fake-agent", description: "Git 注册版", metadata: {} },
      transport: { type: "stdio", command: "node" },
      runtime: { ownership: "on-demand" },
      installPath: "/repo/fake-agent",
      registeredAt: "2026-01-01T00:00:00.000Z",
      status: "idle",
      source: { type: "git", url: "https://example.com/fake-agent.git" },
    });

    const result = await installAgent(BASE_INPUT, deps);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "register");
      assert.match(result.message, /默认不会替换为 npm 安装/);
    }
    assert.deepEqual(calls, ["runInstall", "discover"]);
    assert.equal(store.findByName("fake-agent")?.source?.type, "git");
    assert.equal(existsSync(join(dataDir, "installed", "fake-agent-package")), false);
  });

  it("core-managed 自动启动成功：状态 online、started true", async () => {
    const dataDir = makeDataDir();
    const { deps, store, calls } = makeDeps({
      dataDir,
      discovered: makeDiscovered({
        transport: { type: "streamable-http", endpoint: "http://127.0.0.1:4310/mcp" },
        runtime: {
          ownership: "core-managed",
          start: { command: "node", args: ["dist/index.js"] },
          endpoint: { path: "/mcp", port: 4310 },
        },
      }),
    });

    const result = await installAgent(BASE_INPUT, deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.started, true);
    }
    assert.equal(store.findByName("fake-agent")?.status, "online");
    assert.ok(calls.includes("start"));
    assert.ok(calls.includes("waitReady"));
    assert.ok(!calls.includes("stopGracefully"));
  });

  it("安装锁覆盖 waitReady，期间第二次安装不会开始 download", async () => {
    const dataDir = makeDataDir();
    const readyStarted = Promise.withResolvers<void>();
    const releaseReady = Promise.withResolvers<void>();
    const { deps, calls } = makeDeps({
      dataDir,
      discovered: makeDiscovered({
        transport: { type: "streamable-http", endpoint: "http://127.0.0.1:4314/mcp" },
        runtime: {
          ownership: "core-managed",
          start: { command: "node", args: ["dist/index.js"] },
          endpoint: { path: "/mcp", port: 4314 },
        },
      }),
      waitReady: async () => {
        readyStarted.resolve();
        await releaseReady.promise;
      },
    });

    const firstInstall = installAgent(BASE_INPUT, deps);
    await readyStarted.promise;
    assert.equal(existsSync(installLockPath(dataDir)), true);

    const secondResult = await installAgent(BASE_INPUT, deps);
    assert.equal(secondResult.ok, false);
    if (!secondResult.ok) {
      assert.equal(secondResult.step, "resolve");
      assert.match(secondResult.message, /锁文件/);
    }
    assert.equal(calls.filter((call) => call === "runInstall").length, 1);

    releaseReady.resolve();
    const firstResult = await firstInstall;
    assert.equal(firstResult.ok, true);
    assert.equal(existsSync(installLockPath(dataDir)), false);
  });

  it("waitReady 失败：回滚 stopGracefully 并标记 error", async () => {
    const dataDir = makeDataDir();
    const { deps, store, calls } = makeDeps({
      dataDir,
      discovered: makeDiscovered({
        transport: { type: "streamable-http", endpoint: "http://127.0.0.1:4311/mcp" },
        runtime: {
          ownership: "core-managed",
          start: { command: "node", args: ["dist/index.js"] },
          endpoint: { path: "/mcp", port: 4311 },
        },
      }),
      waitReady: async () => {
        throw new Error("ready 探测超时");
      },
    });

    const result = await installAgent(BASE_INPUT, deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "start");
      assert.match(result.message, /自动启动失败/);
    }
    assert.equal(store.findByName("fake-agent")?.status, "error");
    assert.ok(calls.includes("stopGracefully"));
    assert.equal(existsSync(installLockPath(dataDir)), false);
  });

  it("autoStart=false 时 core-managed 不启动", async () => {
    const dataDir = makeDataDir();
    const { deps, store, calls } = makeDeps({
      dataDir,
      discovered: makeDiscovered({
        transport: { type: "streamable-http", endpoint: "http://127.0.0.1:4312/mcp" },
        runtime: {
          ownership: "core-managed",
          start: { command: "node", args: ["dist/index.js"] },
          endpoint: { path: "/mcp", port: 4312 },
        },
      }),
    });

    const result = await installAgent({ ...BASE_INPUT, autoStart: false }, deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.started, false);
    }
    assert.equal(store.findByName("fake-agent")?.status, "idle");
    assert.ok(!calls.includes("start"));
  });

  it("替换在线 core-managed 旧 Agent 且新 Agent 不启动时停止旧进程并保持 idle", async () => {
    const dataDir = makeDataDir();
    const { deps, store, calls } = makeDeps({ dataDir });
    store.add({
      skill: { name: "fake-agent", description: "旧常驻版", metadata: {} },
      transport: { type: "streamable-http", endpoint: "http://127.0.0.1:4313/mcp" },
      runtime: {
        ownership: "core-managed",
        start: { command: "node", args: ["dist/index.js"] },
        endpoint: { path: "/mcp", port: 4313 },
      },
      installPath: "/repo/fake-agent",
      registeredAt: "2026-01-01T00:00:00.000Z",
      status: "online",
      source: { type: "local-path", path: "/repo/fake-agent" },
    });

    const result = await installAgent(
      { ...BASE_INPUT, expectedSkillName: "fake-agent", replaceExisting: true },
      deps,
    );

    assert.equal(result.ok, true);
    assert.ok(calls.includes("stopGracefully"));
    assert.ok(!calls.includes("start"));
    assert.equal(store.findByName("fake-agent")?.status, "idle");
    assert.equal(store.findByName("fake-agent")?.source?.type, "installed-package");
  });

  it("core-managed 缺必填 env 时跳过启动并返回 envReport", async () => {
    const dataDir = makeDataDir();
    const { deps, store, calls, events } = makeDeps({
      dataDir,
      discovered: makeDiscovered({
        skill: {
          name: "fake-agent",
          description: "测试 agent",
          metadata: {},
          env: { required: [{ name: "ROLL_TEST_FAKE_REQUIRED_TOKEN" }] },
        },
        transport: { type: "streamable-http", endpoint: "http://127.0.0.1:4313/mcp" },
        runtime: {
          ownership: "core-managed",
          start: { command: "node", args: ["dist/index.js"] },
          endpoint: { path: "/mcp", port: 4313 },
        },
      }),
    });

    const result = await installAgent(BASE_INPUT, deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.started, false);
      assert.equal(result.envReport?.missingRequired.length, 1);
      assert.equal(result.envReport?.missingRequired[0]?.name, "ROLL_TEST_FAKE_REQUIRED_TOKEN");
    }
    assert.equal(store.findByName("fake-agent")?.status, "idle");
    assert.ok(!calls.includes("start"));
    assert.ok(
      events.some(
        (event) => event.type === "warn" && event.message.includes("ROLL_TEST_FAKE_REQUIRED_TOKEN"),
      ),
    );
  });
});
