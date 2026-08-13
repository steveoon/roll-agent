import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runRoll, buildConfigYaml } from "./smoke.e2e-harness.ts";

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
