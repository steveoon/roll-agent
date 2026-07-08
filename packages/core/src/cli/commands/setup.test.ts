import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../../config/defaults.ts";
import { runChatOnboarding, runSetup } from "./setup.ts";
import { ConfigSetupCancelledError } from "./config-prompts.ts";
import type { ConfigPromptAdapter, PromptOption } from "./config-prompts.ts";
import type { RunSetupDeps, SetupAgentContext } from "./setup.ts";
import type { CatalogAvailabilityItem } from "../utils/catalog-status.ts";
import type { InstallAgentResult } from "../../registry/install.ts";
import type { RegisteredAgent } from "../../types/agent.ts";

class ScriptedPrompts implements ConfigPromptAdapter {
  readonly calls: string[] = [];
  private readonly confirmValues: boolean[];
  private readonly multiselectValues: string[][];

  constructor(options: {
    readonly confirm?: readonly boolean[];
    readonly multiselect?: readonly (readonly string[])[];
  }) {
    this.confirmValues = [...(options.confirm ?? [])];
    this.multiselectValues = (options.multiselect ?? []).map((values) => [...values]);
  }

  intro(title: string): void {
    this.calls.push(`intro:${title}`);
  }

  outro(message: string): void {
    this.calls.push(`outro:${message}`);
  }

  info(message: string): void {
    this.calls.push(`info:${message}`);
  }

  warn(message: string): void {
    this.calls.push(`warn:${message}`);
  }

  async select<Value extends string>(options: {
    readonly message: string;
    readonly options: readonly PromptOption<Value>[];
    readonly initialValue?: Value;
  }): Promise<Value> {
    this.calls.push(`select:${options.message}`);
    const value = options.initialValue ?? options.options[0]?.value;
    if (value === undefined) {
      throw new Error("missing select value");
    }
    return value;
  }

  async text(options: { readonly message: string; readonly defaultValue?: string }): Promise<string> {
    this.calls.push(`text:${options.message}`);
    return options.defaultValue ?? "";
  }

  async password(options: { readonly message: string }): Promise<string> {
    this.calls.push(`password:${options.message}`);
    return "fake-key";
  }

  async confirm(options: { readonly message: string; readonly initialValue?: boolean }): Promise<boolean> {
    this.calls.push(`confirm:${options.message}`);
    return this.confirmValues.shift() ?? options.initialValue ?? false;
  }

  async multiselect<Value extends string>(options: {
    readonly message: string;
    readonly options: readonly PromptOption<Value>[];
    readonly initialValues?: readonly Value[];
    readonly required?: boolean;
  }): Promise<readonly Value[]> {
    this.calls.push(`multiselect:${options.message}`);
    const scripted = this.multiselectValues.shift();
    if (scripted === undefined) {
      return options.initialValues ?? [];
    }
    return scripted.filter((value): value is Value =>
      options.options.some((option) => option.value === value),
    );
  }
}

function makeAgent(name: string): RegisteredAgent {
  return {
    skill: { name, description: "测试 agent", metadata: {} },
    transport: { type: "stdio", command: "node" },
    runtime: { ownership: "on-demand" },
    installPath: `/tmp/${name}`,
    registeredAt: "2026-01-01T00:00:00.000Z",
    status: "idle",
  };
}

const CATALOG_ITEM: CatalogAvailabilityItem = {
  entry: {
    shortName: "smart-reply",
    packageName: "@roll-agent/smart-reply-agent",
    skillName: "smart-reply-agent",
    description: "智能回复 Agent",
    requiredEnv: ["REPLY_AUTHORITY_URL"],
  },
  state: "not-installed",
  latestVersion: "1.3.4",
};

function makeContext(): SetupAgentContext {
  return {
    agentsConfig: { ...DEFAULT_CONFIG.agents, dataDir: "/tmp/roll-setup-test" },
    installConfig: DEFAULT_CONFIG.install,
    agents: [],
  };
}

function makeDeps(overrides: Partial<RunSetupDeps> & { prompts: ScriptedPrompts }): {
  readonly deps: RunSetupDeps;
  readonly tracker: string[];
} {
  const tracker: string[] = [];
  const deps: RunSetupDeps = {
    detectLlm: () => ({ configured: false, summary: "" }),
    setupLlmFn: async () => {
      tracker.push("setupLlm");
      return "已配置 LLM: openai/gpt-fake";
    },
    setupInstallFn: async () => {
      tracker.push("setupInstall");
      return "已配置 install 网络参数";
    },
    setupAgentEnvFn: async (agentName) => {
      tracker.push(`setupAgentEnv:${agentName}`);
      return `已配置 Agent 环境变量: ${agentName}`;
    },
    loadAgentContext: makeContext,
    resolveCatalog: async () => [CATALOG_ITEM.entry],
    inspectAvailability: async () => [CATALOG_ITEM],
    install: async (input): Promise<InstallAgentResult> => {
      tracker.push(`install:${input.packageSpec}`);
      return {
        ok: true,
        agent: makeAgent("smart-reply-agent"),
        envReport: {
          items: [],
          missingRequired: [
            { name: "REPLY_AUTHORITY_URL", required: true, source: "missing" },
          ],
          processEnvOnlyRequired: [],
        },
        started: false,
      };
    },
    runDoctor: async () => {
      tracker.push("doctor");
    },
    ...overrides,
  };
  return { deps, tracker };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("runSetup", () => {
  it("完整编排顺序：LLM → 跳过网络 → 安装 agent → env 配置 → doctor", async () => {
    const prompts = new ScriptedPrompts({
      confirm: [false, true],
      multiselect: [["smart-reply"]],
    });
    const { deps, tracker } = makeDeps({ prompts });

    await runSetup(deps);

    assert.deepEqual(tracker, [
      "setupLlm",
      "install:@roll-agent/smart-reply-agent",
      "setupAgentEnv:smart-reply-agent",
      "doctor",
    ]);
    assert.ok(prompts.calls.some((call) => call.startsWith("outro:初始化完成")));
    assert.equal(process.exitCode, undefined);
  });

  it("已配置 LLM 且拒绝重配时跳过 setupLlm", async () => {
    const prompts = new ScriptedPrompts({
      confirm: [false, false],
      multiselect: [[]],
    });
    const { deps, tracker } = makeDeps({
      prompts,
      detectLlm: () => ({ configured: true, summary: "openai/gpt-4o" }),
    });

    await runSetup(deps);

    assert.ok(!tracker.includes("setupLlm"));
    assert.ok(prompts.calls.some((call) => call.includes("已检测到 LLM 配置")));
  });

  it("确认配置安装网络时调用 setupInstall", async () => {
    const prompts = new ScriptedPrompts({
      confirm: [true],
      multiselect: [[]],
    });
    const { deps, tracker } = makeDeps({ prompts });

    await runSetup(deps);

    assert.ok(tracker.includes("setupInstall"));
    assert.ok(!tracker.some((item) => item.startsWith("install:")));
    assert.ok(!tracker.some((item) => item.startsWith("setupAgentEnv:")));
  });

  it("install 配置无效时警告并跳过 agent 安装", async () => {
    const prompts = new ScriptedPrompts({ confirm: [false] });
    const { deps, tracker } = makeDeps({
      prompts,
      loadAgentContext: () => ({
        agentsConfig: { ...DEFAULT_CONFIG.agents, dataDir: "/tmp/roll-setup-test" },
        installConfigError: "install.registry 类型错误",
        agents: [],
      }),
    });

    await runSetup(deps);

    assert.ok(prompts.calls.some((call) => call.includes("跳过官方 Agent 安装")));
    assert.ok(!tracker.some((item) => item.startsWith("install:")));
    assert.ok(tracker.includes("doctor"));
  });

  it("安装失败不中断流程且不进入 env 配置", async () => {
    const prompts = new ScriptedPrompts({
      confirm: [false],
      multiselect: [["smart-reply"]],
    });
    const { deps, tracker } = makeDeps({
      prompts,
      install: async () => ({
        ok: false,
        step: "download",
        message: "安装失败: network down",
      }),
    });

    await runSetup(deps);

    assert.ok(!tracker.some((item) => item.startsWith("setupAgentEnv:")));
    assert.ok(tracker.includes("doctor"));
    assert.ok(prompts.calls.some((call) => call.includes("安装失败")));
  });

  it("用户取消时 exitCode 为 1", async () => {
    const prompts = new ScriptedPrompts({});
    const { deps } = makeDeps({
      prompts,
      setupLlmFn: async () => {
        throw new ConfigSetupCancelledError();
      },
    });

    await runSetup(deps);

    assert.equal(process.exitCode, 1);
  });

  it("core-managed Agent 未启动时提示 roll agent start", async () => {
    const prompts = new ScriptedPrompts({
      confirm: [false, true],
      multiselect: [["smart-reply"]],
    });
    const coreManagedAgent: RegisteredAgent = {
      ...makeAgent("smart-reply-agent"),
      runtime: {
        ownership: "core-managed",
        start: { command: "node", args: ["dist/index.js"] },
        endpoint: { path: "/mcp", port: 4310 },
      },
    };
    const { deps } = makeDeps({
      prompts,
      install: async () => ({
        ok: true,
        agent: coreManagedAgent,
        envReport: {
          items: [],
          missingRequired: [
            { name: "REPLY_AUTHORITY_URL", required: true, source: "missing" },
          ],
          processEnvOnlyRequired: [],
        },
        started: false,
      }),
    });

    await runSetup(deps);

    assert.ok(
      prompts.calls.some((call) =>
        call.startsWith("info:运行 roll agent start smart-reply-agent"),
      ),
    );
  });
});

describe("runChatOnboarding", () => {
  it("安装的 Agent 缺必填 env 时输出提示且 outro 引导 setup/doctor", async () => {
    const prompts = new ScriptedPrompts({
      confirm: [true],
      multiselect: [["smart-reply"]],
    });
    const { deps, tracker } = makeDeps({ prompts });

    const proceeded = await runChatOnboarding(deps);

    assert.equal(proceeded, true);
    assert.ok(tracker.includes("setupLlm"));
    assert.ok(tracker.includes("install:@roll-agent/smart-reply-agent"));
    assert.ok(!tracker.some((item) => item.startsWith("setupAgentEnv:")));
    assert.ok(
      prompts.calls.some(
        (call) => call.startsWith("warn:") && call.includes("缺少必填环境变量"),
      ),
    );
    assert.ok(
      prompts.calls.some((call) => call.startsWith("outro:") && call.includes("roll setup")),
    );
  });

  it("用户拒绝初始化时返回 false 且不进入配置", async () => {
    const prompts = new ScriptedPrompts({ confirm: [false] });
    const { deps, tracker } = makeDeps({ prompts });

    const proceeded = await runChatOnboarding(deps);

    assert.equal(proceeded, false);
    assert.ok(!tracker.includes("setupLlm"));
    assert.ok(!tracker.some((item) => item.startsWith("install:")));
  });
});
