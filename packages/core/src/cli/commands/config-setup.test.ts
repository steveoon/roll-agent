import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { runConfigSetup, setupShell } from "./config-setup.ts";
import { explainConfig } from "./config-explain.ts";
import { findConfigGuidance } from "./config-guidance.ts";
import { DEFAULT_CONFIG } from "../../config/defaults.ts";
import { AgentStore } from "../../registry/store.ts";
import { createDefaultRuntimeForTransport, type RegisteredAgent } from "../../types/agent.ts";
import {
  ConfigSetupCancelledError,
  type ConfigPromptAdapter,
  type PromptOption,
} from "./config-prompts.ts";

class FakePrompts implements ConfigPromptAdapter {
  readonly messages: string[] = [];
  private readonly selectValues: string[];
  private readonly textValues: string[];
  private readonly passwordValues: string[];
  private readonly confirmValues: boolean[];

  constructor(options: {
    readonly select?: readonly string[];
    readonly text?: readonly string[];
    readonly password?: readonly string[];
    readonly confirm?: readonly boolean[];
  }) {
    this.selectValues = [...(options.select ?? [])];
    this.textValues = [...(options.text ?? [])];
    this.passwordValues = [...(options.password ?? [])];
    this.confirmValues = [...(options.confirm ?? [])];
  }

  intro(title: string): void {
    this.messages.push(title);
  }

  outro(message: string): void {
    this.messages.push(message);
  }

  info(message: string): void {
    this.messages.push(message);
  }

  warn(message: string): void {
    this.messages.push(message);
  }

  async select<Value extends string>(options: {
    readonly message: string;
    readonly options: readonly PromptOption<Value>[];
    readonly initialValue?: Value;
  }): Promise<Value> {
    this.messages.push(options.message);
    const value = this.selectValues.shift() ?? options.initialValue ?? options.options[0]?.value;
    if (value === undefined) {
      throw new Error(`missing fake select value for ${options.message}`);
    }
    return value as Value;
  }

  async text(options: {
    readonly message: string;
    readonly placeholder?: string;
    readonly defaultValue?: string;
    readonly initialValue?: string;
    readonly required?: boolean;
    readonly validate?: (value: string) => string | undefined;
  }): Promise<string> {
    this.messages.push(options.message);
    const value = this.textValues.shift() ?? options.defaultValue ?? "";
    if (options.required && value.trim().length === 0) {
      throw new Error("此项不能为空");
    }
    const issue = options.validate?.(value);
    if (issue) {
      throw new Error(issue);
    }
    return value;
  }

  async password(options: {
    readonly message: string;
    readonly required?: boolean;
    readonly validate?: (value: string) => string | undefined;
  }): Promise<string> {
    this.messages.push(options.message);
    const value = this.passwordValues.shift() ?? "";
    if (options.required && value.trim().length === 0) {
      throw new Error("此项不能为空");
    }
    const issue = options.validate?.(value);
    if (issue) {
      throw new Error(issue);
    }
    return value;
  }

  async confirm(options: {
    readonly message: string;
    readonly initialValue?: boolean;
  }): Promise<boolean> {
    this.messages.push(options.message);
    return this.confirmValues.shift() ?? options.initialValue ?? false;
  }

  async multiselect<Value extends string>(options: {
    readonly message: string;
    readonly options: readonly PromptOption<Value>[];
    readonly initialValues?: readonly Value[];
    readonly required?: boolean;
  }): Promise<readonly Value[]> {
    this.messages.push(options.message);
    return options.initialValues ?? [];
  }
}

class CancelPrompts extends FakePrompts {
  async select<Value extends string>(): Promise<Value> {
    throw new ConfigSetupCancelledError();
  }
}

function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `roll-config-setup-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readConfig(path: string): Record<string, unknown> {
  return parseYaml(readFileSync(resolve(path, "roll.config.yaml"), "utf-8")) as Record<
    string,
    unknown
  >;
}

function makeAgent(name: string): RegisteredAgent {
  const transport = { type: "stdio", command: "node" } as const;
  return {
    skill: {
      name,
      description: `${name} description`,
      metadata: {},
      env: {
        required: [
          {
            name: "API_URL",
            purpose: "Upstream API base URL",
            example: "https://api.example.com",
          },
          {
            name: "API_TOKEN",
            purpose: "Secret API token",
            example: "token_xxx",
          },
        ],
        optional: [{ name: "TIMEOUT_MS", default: "30000", example: "30000" }],
      },
    },
    transport,
    runtime: createDefaultRuntimeForTransport(transport),
    installPath: `/tmp/${name}`,
    registeredAt: new Date().toISOString(),
    status: "idle",
  };
}

describe("config setup", () => {
  let cwd: string;
  let previousCwd: string;
  let homeDir: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  const restoreEnv = (name: string, value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  };

  beforeEach(() => {
    previousCwd = process.cwd();
    previousHome = process.env["HOME"];
    previousUserProfile = process.env["USERPROFILE"];
    cwd = makeTmpDir();
    homeDir = makeTmpDir();
    process.chdir(cwd);
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("writes LLM provider config from prompts", async () => {
    await runConfigSetup(
      "llm",
      undefined,
      new FakePrompts({
        select: ["openai"],
        text: ["gpt-4.1", "https://gateway.example.com/v1"],
        password: ["sk-test"],
      }),
    );

    const config = readConfig(homeDir);
    assert.deepEqual(config["llm"], {
      "default-provider": "openai",
      "default-model": "gpt-4.1",
      providers: {
        openai: {
          "api-key": "sk-test",
          "base-url": "https://gateway.example.com/v1",
        },
      },
    });
  });

  it("writes install config for the China development scenario", async () => {
    await runConfigSetup("install", undefined, new FakePrompts({ select: ["china-dev"] }));

    const config = readConfig(homeDir);
    assert.deepEqual(config["install"], {
      registry: "https://registry.npmmirror.com",
      "fetch-retries": 3,
      "prefer-offline": false,
      "network-timeout-ms": 120000,
    });
  });

  it("writes install config for a private registry scenario", async () => {
    await runConfigSetup(
      "install",
      undefined,
      new FakePrompts({
        select: ["private-registry"],
        text: ["https://registry.internal.example.com"],
      }),
    );

    const config = readConfig(homeDir);
    assert.equal(
      (config["install"] as Record<string, unknown>)["registry"],
      "https://registry.internal.example.com",
    );
  });

  it("writes chat shell runtime config when enabled", async () => {
    await runConfigSetup("shell", undefined, new FakePrompts({ confirm: [true, true, false] }));

    const config = readConfig(homeDir);
    assert.deepEqual(config["runtime"], {
      shell: {
        enabled: true,
        "auto-approve-safe": true,
        session: { enabled: false },
      },
    });
  });

  it("Windows shell setup skips POSIX-only auto approve and session prompts", async () => {
    const prompts = new FakePrompts({ confirm: [true] });
    await setupShell(prompts, "win32");

    const config = readConfig(homeDir);
    assert.deepEqual(config["runtime"], { shell: { enabled: true } });
    assert.ok(!prompts.messages.some((message) => message.includes("安全只读命令")));
    assert.ok(!prompts.messages.some((message) => message.includes("长跑命令会话")));
    assert.match(
      prompts.messages.join("\n"),
      /Windows 原生 shell 当前仅支持 PowerShell 7 one-shot/u,
    );
  });

  it("bash setup alias writes only the shell disable flag when declined", async () => {
    await runConfigSetup("bash", undefined, new FakePrompts({ confirm: [false] }));

    const config = readConfig(homeDir);
    assert.deepEqual(config["runtime"], { shell: { enabled: false } });
  });

  it("updates a discovered parent config instead of creating a nested config", async () => {
    const childDir = resolve(cwd, "nested", "workspace");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      resolve(cwd, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: test
  providers: {}
ask: {}
agents:
  data-dir: ~/.roll-agent/agents
`,
      "utf-8",
    );
    process.chdir(childDir);

    await runConfigSetup("install", undefined, new FakePrompts({ select: ["china-dev"] }));

    assert.equal(existsSync(resolve(childDir, "roll.config.yaml")), false);
    assert.equal(
      readdirSync(cwd).filter((entry) => entry.startsWith("roll.config.yaml.bak.")).length,
      1,
    );
    const config = readConfig(cwd);
    assert.deepEqual(config["install"], {
      registry: "https://registry.npmmirror.com",
      "fetch-retries": 3,
      "prefer-offline": false,
      "network-timeout-ms": 120000,
    });
  });

  it("writes required agent env values and skips optional env by default", async () => {
    const dataDir = resolve(cwd, "agents-data");
    writeFileSync(
      resolve(cwd, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: test
  providers: {}
ask: {}
agents:
  data-dir: ${dataDir}
`,
      "utf-8",
    );
    const store = new AgentStore(dataDir);
    store.add(makeAgent("fixture-agent"));

    const prompts = new FakePrompts({
      text: ["https://api.example.com"],
      password: ["secret-token"],
      confirm: [false],
    });
    await runConfigSetup("agent", "fixture-agent", prompts);

    const config = readConfig(cwd);
    const agents = config["agents"] as Record<string, unknown>;
    const env = agents["env"] as Record<string, Record<string, string>>;
    assert.deepEqual(env["fixture-agent"], {
      API_URL: "https://api.example.com",
      API_TOKEN: "secret-token",
    });
    const output = prompts.messages.join("\n");
    assert.match(output, /API_TOKEN 将以明文写入/);
    assert.match(output, /下次 roll run \/ roll ask/);
  });

  it("tells core-managed agents how to apply env changes", async () => {
    const dataDir = resolve(cwd, "agents-data");
    writeFileSync(
      resolve(cwd, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: test
  providers: {}
ask: {}
agents:
  data-dir: ${dataDir}
`,
      "utf-8",
    );
    const store = new AgentStore(dataDir);
    store.add({
      ...makeAgent("managed-agent"),
      transport: { type: "streamable-http", endpoint: "http://127.0.0.1:3100/mcp" },
      runtime: {
        ownership: "core-managed",
        start: { command: "node" },
        endpoint: { path: "/mcp", port: 3100 },
      },
    });

    const prompts = new FakePrompts({
      text: ["https://api.example.com"],
      password: ["secret-token"],
      confirm: [false],
    });
    await runConfigSetup("agent", "managed-agent", prompts);

    assert.match(
      prompts.messages.join("\n"),
      /roll agent stop managed-agent && roll agent start managed-agent/,
    );
  });

  it("keeps existing secret agent env when the password prompt is blank", async () => {
    const dataDir = resolve(cwd, "agents-data");
    writeFileSync(
      resolve(cwd, "roll.config.yaml"),
      `llm:
  default-provider: anthropic
  default-model: test
  providers: {}
ask: {}
agents:
  data-dir: ${dataDir}
  env:
    fixture-agent:
      API_URL: https://existing.example.com
      API_TOKEN: existing-token
`,
      "utf-8",
    );
    const store = new AgentStore(dataDir);
    store.add(makeAgent("fixture-agent"));

    const prompts = new FakePrompts({
      password: [""],
      confirm: [false],
    });
    await runConfigSetup("agent", "fixture-agent", prompts);

    const config = readConfig(cwd);
    const agents = config["agents"] as Record<string, unknown>;
    const env = agents["env"] as Record<string, Record<string, string>>;
    assert.deepEqual(env["fixture-agent"], {
      API_URL: "https://existing.example.com",
      API_TOKEN: "existing-token",
    });
    assert.match(prompts.messages.join("\n"), /API_TOKEN（必填，回车保留当前值）/);
  });

  it("marks cancelled setup as a non-zero exit", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runConfigSetup(undefined, undefined, new CancelPrompts({}));

      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("warns when an LLM API key would be written in plaintext", async () => {
    const prompts = new FakePrompts({
      select: ["openai"],
      text: ["gpt-4.1", ""],
      password: ["sk-plaintext"],
    });
    await runConfigSetup("llm", undefined, prompts);

    assert.match(prompts.messages.join("\n"), /将以明文写入/);
  });

  it("does not warn when the LLM API key uses an env reference", async () => {
    const prompts = new FakePrompts({
      select: ["openai"],
      text: ["gpt-4.1", ""],
      password: ["$" + "{OPENAI_API_KEY}"],
    });
    await runConfigSetup("llm", undefined, prompts);

    assert.doesNotMatch(prompts.messages.join("\n"), /将以明文写入/);
  });

  it("can persist required agent env values from the current shell", async () => {
    const previousApiUrl = process.env["API_URL"];
    const previousApiToken = process.env["API_TOKEN"];
    try {
      process.env["API_URL"] = "https://shell.example.com";
      process.env["API_TOKEN"] = "shell-token";
      const dataDir = resolve(cwd, "agents-data");
      writeFileSync(
        resolve(cwd, "roll.config.yaml"),
        `llm:
  default-provider: anthropic
  default-model: test
  providers: {}
ask: {}
agents:
  data-dir: ${dataDir}
`,
        "utf-8",
      );
      const store = new AgentStore(dataDir);
      store.add(makeAgent("fixture-agent"));
      const prompts = new FakePrompts({ confirm: [true, true, false] });

      await runConfigSetup("agent", "fixture-agent", prompts);

      const config = readConfig(cwd);
      const agents = config["agents"] as Record<string, unknown>;
      const env = agents["env"] as Record<string, Record<string, string>>;
      assert.deepEqual(env["fixture-agent"], {
        API_URL: "https://shell.example.com",
        API_TOKEN: "shell-token",
      });
      assert.match(prompts.messages.join("\n"), /当前 shell 临时环境变量/);
    } finally {
      if (previousApiUrl === undefined) {
        delete process.env["API_URL"];
      } else {
        process.env["API_URL"] = previousApiUrl;
      }
      if (previousApiToken === undefined) {
        delete process.env["API_TOKEN"];
      } else {
        process.env["API_TOKEN"] = previousApiToken;
      }
    }
  });
});

describe("config explain", () => {
  let stdout: string[];
  let stderr: string[];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    console.log = (message?: unknown) => {
      stdout.push(String(message ?? ""));
    };
    console.error = (message?: unknown) => {
      stderr.push(String(message ?? ""));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = undefined;
  });

  it("explains a global config path", () => {
    explainConfig("install.registry");

    assert.match(stdout.join("\n"), /npm Registry/);
    assert.match(stdout.join("\n"), /roll config setup install/);
  });

  it("keeps global guidance defaults in sync with DEFAULT_CONFIG", () => {
    const expectedDefaults = [
      ["llm.default-provider", DEFAULT_CONFIG.llm.defaultProvider],
      ["llm.default-model", DEFAULT_CONFIG.llm.defaultModel],
      ["install.fetch-retries", DEFAULT_CONFIG.install.fetchRetries],
      ["install.prefer-offline", DEFAULT_CONFIG.install.preferOffline],
      ["install.network-timeout-ms", DEFAULT_CONFIG.install.networkTimeoutMs],
      ["agents.data-dir", DEFAULT_CONFIG.agents.dataDir],
    ] as const;

    for (const [path, expectedDefault] of expectedDefaults) {
      const guidance = findConfigGuidance(path);
      assert.ok(guidance, `missing guidance for ${path}`);
      assert.equal(guidance.defaultBehavior?.includes(`\`${String(expectedDefault)}\``), true);
    }
  });

  it("explains a registered agent env path from env declarations", () => {
    const previousCwd = process.cwd();
    const cwd = makeTmpDir();
    try {
      process.chdir(cwd);
      const dataDir = resolve(cwd, "agents-data");
      writeFileSync(
        resolve(cwd, "roll.config.yaml"),
        `llm:
  default-provider: anthropic
  default-model: test
  providers: {}
ask: {}
agents:
  data-dir: ${dataDir}
  env:
    fixture-agent:
      API_URL: https://configured.example.com
`,
        "utf-8",
      );
      const store = new AgentStore(dataDir);
      store.add(makeAgent("fixture-agent"));

      explainConfig("agents.env.fixture-agent.API_URL");

      const output = stdout.join("\n");
      assert.match(output, /Agent 环境变量: API_URL/);
      assert.match(output, /用途: Upstream API base URL/);
      assert.match(output, /当前来源: agents.env/);
      assert.match(output, /当前 YAML: 已配置/);
    } finally {
      process.chdir(previousCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports unknown config paths", () => {
    explainConfig("unknown.path");

    assert.equal(process.exitCode, 1);
    assert.match(stderr.join("\n"), /未找到配置说明/);
  });
});
