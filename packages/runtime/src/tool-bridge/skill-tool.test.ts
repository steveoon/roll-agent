import { test } from "node:test";
import assert from "node:assert/strict";
import { asSchema, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { SkillLibrary } from "../skills/contracts.ts";
import { AgentSession } from "../engine/agent-session.ts";
import type { SessionEvent } from "../types/events.ts";
import { buildSkillToolset, executeSkillTool, type SkillToolInput } from "./skill-tool.ts";
import { ToolRegistry } from "./naming.ts";
import type { NormalizedToolResult } from "./normalize-result.ts";

function stubLibrary(): SkillLibrary {
  return {
    list: () => [{ name: "demo", description: "演示 skill", source: "user" }],
    load: (name) =>
      name === "demo"
        ? {
            summary: { name: "demo", description: "演示 skill", source: "user" },
            content: "# Demo\n\n按流程操作。",
            referencePaths: ["references/guide.md"],
            skillRoot: "/skills/demo",
          }
        : undefined,
    loadReference: (name, referencePath) =>
      name === "demo" && referencePath === "references/guide.md" ? "指南正文" : undefined,
    loadReferenceDocument: (name, referencePath) =>
      name === "demo" && referencePath === "references/guide.md"
        ? { content: "指南正文", skillRoot: "/skills/demo" }
        : undefined,
  };
}

function runSkillTool(input: SkillToolInput): NormalizedToolResult {
  return executeSkillTool(stubLibrary(), input);
}

function libraryWithNames(names: readonly string[]): SkillLibrary {
  const source = stubLibrary();
  const summaries = names.map((name) => ({ name, description: name, source: "user" as const }));
  return {
    ...source,
    list: () => summaries,
    load: (name) => (names.includes(name) ? source.load(name) : undefined),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSkillNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function readSkillNameError(output: unknown) {
  assert.ok(isRecord(output));
  assert.equal(output.type, "error-json");
  const value = output.value;
  assert.ok(isRecord(value));
  assert.equal(value.code, "invalid_input");
  assert.equal(value.field, "name");
  assert.ok(isSkillNameList(value.availableNames));
  return value;
}

test("skill 工具注册为 roll__skill 且路由到 roll.skill", () => {
  const registry = new ToolRegistry();
  buildSkillToolset(stubLibrary(), registry);
  assert.deepEqual(registry.resolve("roll__skill"), { agentName: "roll", toolName: "skill" });
});

test("skill 模型 schema 使用完整目录枚举、strict 和 nullable reference", async () => {
  const names = ["demo", "changeset-workflow", "lark-im"];
  const built = buildSkillToolset(libraryWithNames(names), new ToolRegistry());
  const tool = built["roll__skill"];
  assert.ok(tool);
  assert.equal(tool.strict, true);
  const schema = asSchema(tool.inputSchema);
  const wire = await schema.jsonSchema;
  assert.deepEqual(wire.properties?.["name"], {
    type: "string",
    enum: names,
    description: "从当前 Skills 目录选择名称并原样传入，不要附加说明文字",
  });
  assert.deepEqual(wire.required, ["name", "reference"]);
  assert.equal(wire.additionalProperties, false);
  assert.ok(schema.validate);
  for (const name of ["changeset-workflow tools are not instructions", "lark-im牡"]) {
    assert.equal((await schema.validate({ name, reference: null })).success, false);
  }
  assert.equal((await schema.validate({ name: "demo", reference: null })).success, true);
  assert.deepEqual(buildSkillToolset(libraryWithNames([]), new ToolRegistry()), {});
});

test("加载 skill 返回正文与 references 列表", () => {
  const result = runSkillTool({ name: "demo" });
  assert.equal(result.isError, false);
  assert.ok(String(result.output).includes("按流程操作"));
  assert.ok(String(result.output).includes("references/guide.md"));
  assert.ok(String(result.output).includes("SKILL_ROOT=/skills/demo"));
  assert.ok(String(result.output).includes("workdir"));
});

test("空 reference 与主 SKILL.md 别名都加载正文", () => {
  for (const reference of ["", "   ", ".", "./", "/", "SKILL.md", "./SKILL.md"]) {
    const result = runSkillTool({ name: "demo", reference });
    assert.equal(result.isError, false, `reference=${JSON.stringify(reference)}`);
    assert.ok(String(result.output).includes("按流程操作"));
  }
});

test("加载 reference 返回文件内容", () => {
  const result = runSkillTool({ name: "demo", reference: "references/guide.md" });
  assert.equal(result.isError, false);
  assert.ok(String(result.output).includes("SKILL_ROOT=/skills/demo"));
  assert.ok(String(result.output).endsWith("指南正文"));
});

test("加载 reference 不重复加载 SKILL.md 正文", () => {
  const library: SkillLibrary = {
    ...stubLibrary(),
    load: () => {
      throw new Error("reference 加载不应读取 SKILL.md");
    },
  };
  const result = executeSkillTool(library, {
    name: "demo",
    reference: "references/guide.md",
  });
  assert.equal(result.isError, false);
  assert.ok(String(result.output).endsWith("指南正文"));
});

test("带位置接口未命中时不回退重复读取 reference", () => {
  let legacyLoads = 0;
  const library: SkillLibrary = {
    ...stubLibrary(),
    loadReference: () => {
      legacyLoads += 1;
      return undefined;
    },
    loadReferenceDocument: () => undefined,
  };
  const result = executeSkillTool(library, {
    name: "demo",
    reference: "references/nope.md",
  });
  assert.equal(result.isError, true);
  assert.equal(legacyLoads, 0);
});

test("旧 SkillLibrary 仅实现 loadReference 时保持兼容", () => {
  const source = stubLibrary();
  const library: SkillLibrary = {
    list: source.list,
    load: source.load,
    loadReference: source.loadReference,
  };
  const result = executeSkillTool(library, {
    name: "demo",
    reference: "references/guide.md",
  });
  assert.equal(result.isError, false);
  assert.equal(result.output, "指南正文");
});

test("未知 skill 与未知 reference 返回错误并列出可用项", () => {
  const missing = runSkillTool({ name: "nope", reference: "references/guide.md" });
  assert.equal(missing.isError, true);
  assert.ok(String(missing.output).includes("demo"));
  assert.match(String(missing.output), /skill "nope" 不存在/);

  const missingRef = runSkillTool({ name: "demo", reference: "references/nope.md" });
  assert.equal(missingRef.isError, true);
  assert.match(String(missingRef.output), /不存在 reference/);
  assert.match(String(missingRef.output), /加载主 SKILL\.md 时请省略 reference/);
});

test("未知 skill 的主文档和 reference 调用都返回结构化名称错误", () => {
  for (const reference of ["", "references/guide.md"]) {
    const result = runSkillTool({ name: "demo指南?", reference });
    assert.deepEqual(result.outcome, { kind: "invalid_input" });
    const error = readSkillNameError(result.model);
    assert.equal(error.receivedName, "demo指南?");
    assert.match(String(error.message), /原样传入/);
    assert.match(String(error.message), /不要原样重试/);
    assert.match(String(error.availableNamesOrder), /不代表该 skill 一定适合/);
    assert.deepEqual(error.availableNames, ["demo"]);
    assert.equal("suggestedInput" in error, false);
  }
});

test("真实误传样例按名称距离排序并保留整个目录", () => {
  const names = [
    "writing-plans",
    "gitnexus-guide",
    "documentation",
    "gitnexus-exploring",
    "gitnexus-debugging",
  ];
  const library = libraryWithNames(names);
  const cases = [
    { input: "gitnexus-debugging指南?", first: "gitnexus-debugging" },
    { input: "gitnexus-debugging script?", first: "gitnexus-debugging" },
    { input: "gitnexus-debugging lite?", first: "gitnexus-debugging" },
    { input: "documentation lite", first: "documentation" },
    { input: "gitnexsu-debugging", first: "gitnexus-debugging" },
    { input: "  gitnexus-debugging指南?  ", first: "gitnexus-debugging" },
  ];
  for (const { input, first } of cases) {
    const error = readSkillNameError(executeSkillTool(library, { name: input }).model);
    assert.ok(isSkillNameList(error.availableNames));
    assert.equal(error.availableNames[0], first, input);
    assert.deepEqual([...error.availableNames].sort(), [...names].sort());
    assert.deepEqual(
      library.list().map((skill) => skill.name),
      names,
    );
  }
});

test("排序比较完整名称，不剥离 lite 后缀或优先短前缀", () => {
  const names = ["gitnexus-debugging", "gitnexus-debugging-lite", "gitnexus"];
  const error = readSkillNameError(
    executeSkillTool(libraryWithNames(names), { name: "gitnexus-debugging lite?" }).model,
  );
  assert.deepEqual(error.availableNames, [
    "gitnexus-debugging-lite",
    "gitnexus-debugging",
    "gitnexus",
  ]);
});

test("标准化距离决定顺序，同分保留目录顺序并按 Unicode 字符计数", () => {
  const cases = [
    { input: "abc", names: ["a", "abcdef"], expected: ["abcdef", "a"] },
    { input: "ab", names: ["abcd", "a"], expected: ["abcd", "a"] },
    { input: "demo", names: ["demu", "dema", "demi"], expected: ["demu", "dema", "demi"] },
    { input: "🤖a", names: ["a", "🤖b"], expected: ["a", "🤖b"] },
    { input: "未知", names: ["long-skill-name", "a"], expected: ["long-skill-name", "a"] },
  ];
  for (const { input, names, expected } of cases) {
    const error = readSkillNameError(
      executeSkillTool(libraryWithNames(names), { name: input }).model,
    );
    assert.deepEqual(error.availableNames, expected, input);
  }
});

test("空目录返回空名称列表，已发现但不可读的 skill 保持加载失败", () => {
  const missing = executeSkillTool(libraryWithNames([]), { name: "demo?" });
  assert.deepEqual(readSkillNameError(missing.model).availableNames, []);

  const unreadable = executeSkillTool(
    { ...stubLibrary(), load: () => undefined },
    { name: "demo" },
  );
  assert.deepEqual(unreadable.outcome, { kind: "tool_failed" });
  assert.match(String(unreadable.output), /已发现，但主文档加载失败/);
});

test("AgentSession 将超过 128 项的完整错误目录发回模型，由模型显式修正后重试", async () => {
  const names = [...Array.from({ length: 160 }, (_, index) => `skill-${String(index)}`), "demo"];
  const source = libraryWithNames(names);
  const loadedNames: string[] = [];
  const library: SkillLibrary = {
    ...source,
    load: (name) => {
      loadedNames.push(name);
      return source.load(name);
    },
  };
  const captured: LanguageModelV4CallOptions[] = [];
  const inputs = [
    { name: "demo指南?", reference: "" },
    { name: "demo", reference: "" },
  ];
  let step = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      captured.push(options);
      const input = inputs[step];
      const toolCallId = `skill-${String(step)}`;
      step += 1;
      const chunks: LanguageModelV4StreamPart[] = [
        { type: "stream-start", warnings: [] },
        ...(input === undefined
          ? [
              { type: "text-start", id: "text" } as const,
              { type: "text-delta", id: "text", delta: "已读取" } as const,
              { type: "text-end", id: "text" } as const,
            ]
          : [
              {
                type: "tool-call",
                toolCallId,
                toolName: "roll__skill",
                input: JSON.stringify(input),
              } as const,
            ]),
        {
          type: "finish",
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          finishReason: {
            unified: input === undefined ? "stop" : "tool-calls",
            raw: input === undefined ? "stop" : "tool-calls",
          },
        },
      ];
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
  const session = new AgentSession({
    id: "skill-retry",
    model,
    sources: [],
    maxSteps: 5,
    skillLibrary: library,
  });
  const events: SessionEvent[] = [];
  try {
    for await (const event of session.send("加载 demo skill")) events.push(event);
  } finally {
    await session.close();
  }

  const errorPart = captured[1]?.prompt
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .find((part) => part.type === "tool-result" && part.toolCallId === "skill-0");
  assert.ok(errorPart?.type === "tool-result");
  const error = readSkillNameError(errorPart.output);
  assert.ok(isSkillNameList(error.availableNames));
  assert.equal(error.availableNames[0], "demo");
  assert.equal(error.availableNames.length, names.length);
  assert.deepEqual([...error.availableNames].sort(), [...names].sort());
  assert.deepEqual(loadedNames, ["demo"], "错误名称在执行前被拒绝，仍保留完整错误反馈");
  const results = events.filter((event) => event.type === "tool-result");
  assert.equal(results.length, 2);
  assert.equal(results[0]?.isError, true);
  assert.equal(results[1]?.isError, false);
  assert.match(JSON.stringify(captured[2]?.prompt), /按流程操作/);
});

test("AgentSession 集成：模型调用 roll__skill 并收到 skill 内容", async () => {
  const captured: LanguageModelV4CallOptions[] = [];
  let step = 0;
  const steps: LanguageModelV4StreamPart[][] = [
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "roll__skill",
        input: JSON.stringify({ name: "demo", reference: "" }),
      },
      {
        type: "finish",
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
      },
    ],
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "已读取" },
      { type: "text-end", id: "t" },
      {
        type: "finish",
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        finishReason: { unified: "stop", raw: "stop" },
      },
    ],
  ];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      captured.push(options);
      const chunks = steps[step] ?? [];
      step += 1;
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });

  const session = new AgentSession({
    id: "s1",
    model,
    sources: [],
    maxSteps: 5,
    skillLibrary: stubLibrary(),
    systemPrompt: "PROMPT-WITH-SKILLS",
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("加载 demo skill")) {
    events.push(event);
  }

  const toolCall = events.find((event) => event.type === "tool-call");
  assert.equal(toolCall?.type, "tool-call");
  assert.equal(toolCall.agentName, "roll");
  assert.equal(toolCall.toolName, "skill");

  const toolResult = events.find((event) => event.type === "tool-result");
  assert.equal(toolResult?.type, "tool-result");
  assert.equal(toolResult.isError, false);
  assert.ok(JSON.stringify(toolResult.output).includes("按流程操作"));

  const system = captured[0]?.prompt.find((message) => message.role === "system");
  assert.ok(system);
  assert.match(system.content, /# 工具使用纪律/u);
  assert.match(system.content, /# Skills/u);
  assert.match(system.content, /# 附加会话指令/u);
  assert.match(system.content, /PROMPT-WITH-SKILLS/u);
});
