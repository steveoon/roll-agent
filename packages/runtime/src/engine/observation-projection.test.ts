import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import {
  canonicalObservationOutput,
  currentObservationModelOutput,
  projectObservationMessages,
} from "./observation-projection.ts";

const declaration = { kind: "browser-ax-snapshot" } as const;
const declarations = new Map([["browser__snapshot", declaration]]);

function payload(
  index: number,
  options: {
    readonly browser?: string;
    readonly page?: string;
    readonly document?: string;
    readonly scope?: string;
    readonly truncated?: boolean;
    readonly missingIdentity?: boolean;
  } = {},
) {
  return {
    page: { url: "https://example.test/form" },
    snapshot: {
      snapshotId: `snapshot-${index}`,
      ...(!options.missingIdentity ? { browserInstance: options.browser ?? "browser-a" } : {}),
      pageId: options.page ?? "page-a",
      documentId: options.document ?? "document-a",
      ...(options.scope ? { scope: options.scope } : {}),
      coverageWarnings: options.truncated ? ["unvisited region"] : [],
      nodes: [
        {
          role: "textbox",
          name: `Field ${index} ${"detail".repeat(200)}`,
          ref: "@e1",
          frameId: "frame-a",
          depth: 0,
          ignored: false,
          properties: { required: true },
        },
      ],
      refs: [
        {
          ref: "@e1",
          role: "textbox",
          name: `Field ${index} ${"detail".repeat(200)}`,
          frameId: "frame-a",
          nth: 0,
          disabled: false,
          locator: { css: "#field" },
        },
      ],
      nodeCount: 1,
      truncated: options.truncated ?? false,
      maxNodes: 100,
      interactiveOnly: true,
    },
  };
}

function result(index: number, value: unknown, toolName = "browser__snapshot"): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: `call-${index}`,
        toolName,
        output: { type: "content", value: [{ type: "text", text: JSON.stringify(value) }] },
      },
    ],
  };
}

test("80 次同文档观察在每次投影后有界，规范历史和配对不变", () => {
  const messages: ModelMessage[] = [];
  for (let index = 0; index < 80; index += 1) {
    messages.push({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `call-${index}`,
          toolName: "browser__snapshot",
          input: {},
        },
      ],
    });
    messages.push(result(index, payload(index, { page: index % 2 === 0 ? "page-a" : "page-b" })));
  }
  const original = JSON.stringify(messages);
  const projected = projectObservationMessages(messages, {
    declarations,
    resultId: (callId) => `result-${callId}`,
  });
  const wire = JSON.stringify(projected);
  assert.ok(wire.length < original.length / 4, `${wire.length} vs ${original.length}`);
  assert.equal(JSON.stringify(messages), original);
  assert.equal(projected.filter((message) => message.role === "tool").length, 80);
  assert.equal(projected.filter((message) => message.role === "assistant").length, 80);
  assert.match(wire, /result-call-0/u);
  assert.match(wire, /snapshot-78/u);
  assert.match(wire, /snapshot-79/u);
});

test("局部与截断的新观察保留旧完整覆盖为失效引用证据", () => {
  const messages = [
    result(0, payload(0)),
    result(1, payload(1, { scope: "#dialog", truncated: true })),
  ];
  const projected = projectObservationMessages(messages, { declarations });
  const old = JSON.stringify(projected[0]);
  const latest = JSON.stringify(projected[1]);
  assert.match(old, /historicalEvidenceOnly/u);
  assert.doesNotMatch(old, /"ref":"@e1"/u);
  assert.match(latest, /"ref":"@e1"/u);
  assert.match(latest, /unvisited region/u);
});

test("失败、缺身份、不同 browser/page 不被猜测合并，旧 document 的引用失效", () => {
  const messages = [
    result(0, payload(0, { missingIdentity: true })),
    result(1, { error: "failed" }),
    result(2, payload(2, { browser: "other" })),
    result(3, payload(3, { page: "other" })),
    result(4, payload(4, { document: "other" })),
    result(5, payload(5), "browser__operate"),
    result(6, payload(6)),
  ];
  const projected = projectObservationMessages(messages, { declarations });
  assert.deepEqual(projected[0], messages[0]);
  assert.deepEqual(projected[1], messages[1]);
  assert.deepEqual(projected[5], messages[5]);
  for (const item of projected.slice(2, 4)) {
    assert.doesNotMatch(JSON.stringify(item), /historicalObservation/u);
  }
  assert.match(JSON.stringify(projected[4]), /"documentStale":true/u);
  assert.doesNotMatch(JSON.stringify(projected[4]), /"ref":"@e1"/u);
});

test("跨文档导航只保留同一 browser/page 最新文档的可执行引用", () => {
  const messages = Array.from({ length: 80 }, (_, index) =>
    result(index, payload(index, { document: `document-${index}` })),
  );
  const projected = projectObservationMessages(messages, { declarations });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.match(/"ref":"@e1"/gu)?.length, 1);
  assert.equal(serialized.match(/"documentStale":true/gu)?.length, 79);
  assert.match(serialized, /snapshot-79/u);
  assert.doesNotMatch(serialized, /Field 0 detail/u);
});

test("单个超长字段和宽节点树均有结构化模型上限及回查提示", () => {
  const original = payload(0);
  const oversized = {
    ...original,
    snapshot: {
      ...original.snapshot,
      nodes: Array.from({ length: 200 }, (_, index) => ({
        role: "textbox",
        ref: `@e${index}`,
        name: `Field ${index} ${"x".repeat(100_000)}`,
        depth: 0,
      })),
      refs: [],
      nodeCount: 200,
    },
  };
  const raw = { content: [{ type: "text", text: JSON.stringify(oversized) }] };
  const model = currentObservationModelOutput(raw, declaration);
  assert.equal(model?.type, "json");
  const serialized = JSON.stringify(model);
  assert.ok(serialized.length <= 50_000, String(serialized.length));
  assert.match(serialized, /"modelProjectionTruncated":true/u);
  assert.match(serialized, /modelProjectionOmittedNodes/u);
  assert.match(serialized, /snapshot-0/u);
  assert.doesNotMatch(serialized, /x{2000}/u);
  assert.equal(JSON.stringify(oversized).length > serialized.length * 100, true);
  const canonical = canonicalObservationOutput(raw, declaration);
  assert.match(JSON.stringify(canonical), /x{2000}/u);
});

test("紧凑当前快照保留层级、frame、控件状态、表单上下文与覆盖警告", () => {
  const base = payload(1, { truncated: true });
  const nodes = [
    {
      role: "form",
      name: "Signup",
      depth: 0,
      ignored: false,
      children: [
        {
          role: "textbox",
          name: "Email",
          value: "draft@example.test",
          ref: "@e1",
          frameId: "frame-a",
          depth: 1,
          ignored: false,
          properties: { required: true },
        },
      ],
    },
  ];
  const refs = [
    {
      ref: "@e1",
      role: "textbox",
      name: "Email",
      frameId: "frame-a",
      nth: 0,
      disabled: false,
      context: { form: "Signup", dialog: "Verify" },
      locator: { css: "#email" },
    },
  ];
  const value = { ...base, snapshot: { ...base.snapshot, nodes, refs } };
  const model = currentObservationModelOutput(
    { content: [{ type: "text", text: JSON.stringify(value) }] },
    declaration,
  );
  assert.equal(model?.type, "json");
  if (model?.type !== "json") return;
  const output = JSON.stringify(model.value);
  for (const expected of [
    "Signup",
    "Verify",
    "frame-a",
    "required",
    "draft@example.test",
    "unvisited region",
    "#email",
    "@e1",
  ]) {
    assert.ok(output.includes(expected), expected);
  }
});

test("structuredContent 不把完整快照追加到紧凑模型结果，规范输出仍完整", () => {
  const observation = payload(1);
  const raw = {
    content: [{ type: "text", text: JSON.stringify(observation) }],
    structuredContent: observation,
  };
  const model = currentObservationModelOutput(raw, declaration);
  assert.equal(model?.type, "json");
  assert.doesNotMatch(JSON.stringify(model), /\[structuredContent\]/u);
  assert.doesNotMatch(JSON.stringify(model), /"refs":\[/u);
  const canonical = canonicalObservationOutput(raw, declaration);
  assert.equal(canonical?.type, "content");
  assert.equal(
    canonical?.type === "content" && canonical.value[0]?.type === "text"
      ? JSON.parse(canonical.value[0].text).snapshot.refs.length
      : 0,
    1,
  );
});

test("历史回查只在当前轮暂存，下一用户轮次压成短提示", () => {
  const recall: ModelMessage = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "read-1",
        toolName: "roll__observation",
        output: { type: "text", value: "sensitive historical evidence ".repeat(300) },
      },
    ],
  };
  const current = projectObservationMessages([{ role: "user", content: "read" }, recall], {
    declarations,
    recallToolId: "roll__observation",
  });
  assert.match(JSON.stringify(current), /sensitive historical evidence/u);
  const next = projectObservationMessages(
    [{ role: "user", content: "read" }, recall, { role: "user", content: "next task" }],
    { declarations, recallToolId: "roll__observation" },
  );
  assert.doesNotMatch(JSON.stringify(next), /sensitive historical evidence/u);
  assert.match(JSON.stringify(next), /历史观察回查/u);
});

test("最近一批并行回查的全部结果共同保留，后续批次和用户轮次再淘汰", () => {
  const recall = (toolCallId: string, value: string, failed = false): ModelMessage => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName: "roll__observation",
        output: failed ? { type: "error-text", value } : { type: "text", value },
      },
    ],
  });
  const oldBatch: ModelMessage[] = [
    { role: "user", content: "compare" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "a", toolName: "roll__observation", input: {} },
        { type: "tool-call", toolCallId: "fail", toolName: "roll__observation", input: {} },
        { type: "tool-call", toolCallId: "b", toolName: "roll__observation", input: {} },
      ],
    },
    recall("a", "ONLY_A"),
    recall("fail", "FAILED_LOOKUP", true),
    recall("b", "ONLY_B"),
  ];
  const options = { declarations, recallToolId: "roll__observation" };
  const first = JSON.stringify(projectObservationMessages(oldBatch, options));
  assert.match(first, /ONLY_A/u);
  assert.match(first, /ONLY_B/u);
  assert.match(first, /FAILED_LOOKUP/u);
  assert.doesNotMatch(first, /历史观察回查/u);

  const combined: ModelMessage[] = [
    { role: "user", content: "compare" },
    { role: "assistant", content: "read both" },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "a",
          toolName: "roll__observation",
          output: { type: "text", value: "ONLY_A" },
        },
        {
          type: "tool-result",
          toolCallId: "b",
          toolName: "roll__observation",
          output: { type: "text", value: "ONLY_B" },
        },
      ],
    },
  ];
  const sameMessage = JSON.stringify(projectObservationMessages(combined, options));
  assert.match(sameMessage, /ONLY_A/u);
  assert.match(sameMessage, /ONLY_B/u);

  const laterBatch = [
    ...oldBatch,
    { role: "assistant" as const, content: "compare one more" },
    recall("c", "ONLY_C"),
  ];
  const later = JSON.stringify(projectObservationMessages(laterBatch, options));
  assert.doesNotMatch(later, /ONLY_A|ONLY_B|FAILED_LOOKUP/u);
  assert.match(later, /ONLY_C/u);
  const nextTurn = JSON.stringify(
    projectObservationMessages([...oldBatch, { role: "user", content: "next" }], options),
  );
  assert.doesNotMatch(nextTurn, /ONLY_A|ONLY_B|FAILED_LOOKUP/u);
});

test("absent optional metadata does not claim projection loss; real clipping still does", () => {
  const original = {
    page: { url: "https://example.test/form" },
    snapshot: {
      snapshotId: "short",
      browserInstance: "b",
      pageId: "p",
      documentId: "d",
      nodes: [{ ref: "@e1", role: "button", name: "Open salary details" }],
      refs: [],
      truncated: false,
    },
  };
  const before = structuredClone(original);
  const output = currentObservationModelOutput({ structuredContent: original }, declaration);
  assert.equal(output?.type, "json");
  const text = JSON.stringify(output);
  assert.ok(!text.includes("modelProjectionTruncated"));
  assert.ok(text.includes("Open salary details"));
  assert.deepEqual(original, before);
  const long = structuredClone(original);
  long.snapshot.nodes[0]!.name = "x".repeat(2000);
  assert.match(
    JSON.stringify(currentObservationModelOutput({ structuredContent: long }, declaration)),
    /modelProjectionTruncated/,
  );
});
