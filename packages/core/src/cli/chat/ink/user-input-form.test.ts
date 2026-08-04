import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import type { AgentSession, SessionEvent } from "@roll-agent/runtime";
import { UserInputForm } from "./user-input-form.ts";

type PendingUserInput = Extract<SessionEvent, { readonly type: "user-input-required" }>;
type UserInputResult = Parameters<AgentSession["resolveUserInput"]>[1];

function request(controls: PendingUserInput["form"]["controls"]): PendingUserInput {
  return {
    type: "user-input-required",
    requestId: "00000000-0000-4000-8000-000000000185" as PendingUserInput["requestId"],
    form: {
      title: "部署配置",
      description: "请确认目标环境",
      controls,
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

test("UserInputForm validates all five controls and submits values in definition order", async () => {
  const results: UserInputResult[] = [];
  const { stdin, lastFrame, unmount } = render(
    h(UserInputForm, {
      request: request([
        {
          type: "text",
          id: "workspace",
          label: "目标 Workspace",
          required: true,
          minLength: 3,
          maxLength: 12,
        },
        {
          type: "multiline",
          id: "notes",
          label: "发布说明",
          required: true,
          minLength: 3,
        },
        {
          type: "number",
          id: "replicas",
          label: "副本数",
          required: true,
          integer: true,
          min: 1,
          max: 9,
        },
        {
          type: "boolean",
          id: "dryRun",
          label: "仅预演",
          required: true,
        },
        {
          type: "choice",
          id: "regions",
          label: "部署区域",
          required: true,
          multiple: true,
          minSelections: 2,
          maxSelections: 2,
          options: [
            { id: "north", label: "北区" },
            { id: "south", label: "南区" },
            { id: "west", label: "西区" },
          ],
        },
      ]),
      width: 80,
      viewportRows: 30,
      maxRows: 12,
      onResolve: (result: UserInputResult) => results.push(result),
    }),
  );

  await delay(10);
  stdin.write("ab");
  stdin.write("\r");
  await delay(20);
  assert.match(lastFrame() ?? "", /至少输入 3 个字符/);
  stdin.write("c");
  stdin.write("\r");
  await delay(20);
  assert.match(lastFrame() ?? "", /发布说明/);

  stdin.write("第一行");
  stdin.write("\n");
  stdin.write("第二行");
  stdin.write("\r");
  await delay(20);
  assert.match(lastFrame() ?? "", /副本数/);

  stdin.write("1.5");
  stdin.write("\r");
  await delay(20);
  assert.match(lastFrame() ?? "", /请输入整数/);
  stdin.write("\x15");
  stdin.write("5");
  stdin.write("\r");
  await delay(20);
  assert.match(lastFrame() ?? "", /仅预演/);

  stdin.write("\x1b[B");
  await delay(10);
  stdin.write("\r");
  await delay(20);
  assert.match(lastFrame() ?? "", /部署区域/);

  stdin.write(" ");
  stdin.write("\x1b[B");
  await delay(10);
  stdin.write("\r");
  await delay(20);
  assert.match(lastFrame() ?? "", /至少选择 2 项/);
  stdin.write(" ");
  await delay(10);
  stdin.write("\r");
  await delay(20);

  assert.deepEqual(results, [
    {
      status: "submitted",
      values: [
        { id: "workspace", value: "abc" },
        { id: "notes", value: "第一行\n第二行" },
        { id: "replicas", value: 5 },
        { id: "dryRun", value: false },
        { id: "regions", value: ["north", "south"] },
      ],
    },
  ]);
  unmount();
});

test("UserInputForm skips optional controls and rejects text beyond its maximum", async () => {
  const results: UserInputResult[] = [];
  const { stdin, lastFrame, unmount } = render(
    h(UserInputForm, {
      request: request([
        {
          type: "text",
          id: "alias",
          label: "别名",
          required: false,
          minLength: 1,
          maxLength: 2,
        },
        {
          type: "multiline",
          id: "notes",
          label: "发布说明",
          required: false,
          minLength: 3,
        },
        {
          type: "boolean",
          id: "notify",
          label: "发送通知",
          required: false,
        },
        {
          type: "choice",
          id: "region",
          label: "部署区域",
          required: false,
          multiple: false,
          options: [{ id: "local", label: "本地" }],
        },
      ]),
      width: 80,
      viewportRows: 30,
      maxRows: 12,
      onResolve: (result: UserInputResult) => results.push(result),
    }),
  );

  await delay(10);
  stdin.write("abc");
  stdin.write("\r");
  await delay(20);
  assert.match(lastFrame() ?? "", /最多输入 2 个字符/);
  stdin.write("\x15");
  stdin.write("\r");
  await delay(20);
  stdin.write("\r");
  await delay(20);
  stdin.write("s");
  await delay(20);
  stdin.write("s");
  await delay(20);

  assert.deepEqual(results, [{ status: "submitted", values: [] }]);
  unmount();
});

test("UserInputForm does not coerce an empty required number to zero", async () => {
  const results: UserInputResult[] = [];
  const { stdin, lastFrame, unmount } = render(
    h(UserInputForm, {
      request: request([
        {
          type: "number",
          id: "replicas",
          label: "副本数",
          required: true,
        },
      ]),
      width: 80,
      viewportRows: 30,
      maxRows: 12,
      onResolve: (result: UserInputResult) => results.push(result),
    }),
  );

  await delay(10);
  stdin.write("\r");
  await delay(20);
  assert.match(lastFrame() ?? "", /请输入数字/);
  assert.deepEqual(results, []);

  stdin.write("0");
  stdin.write("\r");
  await delay(20);
  assert.deepEqual(results, [{ status: "submitted", values: [{ id: "replicas", value: 0 }] }]);
  unmount();
});

test("UserInputForm treats Esc as normal cancellation exactly once and ignores Shift+Tab", async () => {
  const results: UserInputResult[] = [];
  const { stdin, unmount } = render(
    h(UserInputForm, {
      request: request([
        {
          type: "text",
          id: "workspace",
          label: "目标 Workspace",
          required: true,
        },
      ]),
      width: 80,
      viewportRows: 30,
      maxRows: 12,
      onResolve: (result: UserInputResult) => results.push(result),
    }),
  );

  await delay(10);
  stdin.write("\x1b[Z");
  await delay(20);
  assert.deepEqual(results, []);
  stdin.write("\x1b");
  await delay(20);
  stdin.write("\x1b");
  await delay(20);
  assert.deepEqual(results, [{ status: "cancelled", reason: "用户取消" }]);
  unmount();
});
