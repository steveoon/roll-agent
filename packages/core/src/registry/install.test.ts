import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../config/defaults.ts";
import { installAgent } from "./install.ts";
import { AgentStore } from "./store.ts";
import type { InstallAgentDeps, InstallAgentEvent, InstallAgentInput } from "./install.ts";
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
  readonly runInstall?: () => Promise<void>;
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
  const packageRoot = join(options.dataDir, "fake-package-root");
  mkdirSync(packageRoot, { recursive: true });

  const deps: InstallAgentDeps = {
    agentsConfig: { ...DEFAULT_CONFIG.agents, dataDir: options.dataDir },
    installConfig: DEFAULT_CONFIG.install,
    getStartEnv: () => ({}),
    store,
    report: (event) => events.push(event),
    collaborators: {
      runInstall: async () => {
        calls.push("runInstall");
        if (options.runInstall) {
          await options.runInstall();
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
      resolvePackageRoot: () => packageRoot,
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
  });

  it("同名 installed-package 走 replace，其他来源同名走 add 并因重名失败", async () => {
    const dataDir = makeDataDir();
    const { deps, store } = makeDeps({ dataDir });

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

    store.remove("fake-agent");
    store.add({
      ...preRegistered,
      source: { type: "local-path", path: "/repo/fake-agent" },
    });
    const addResult = await installAgent(BASE_INPUT, deps);
    assert.equal(addResult.ok, false);
    if (!addResult.ok) {
      assert.equal(addResult.step, "register");
    }
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
