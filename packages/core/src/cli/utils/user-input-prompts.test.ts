import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createUserInputPromptAdapter,
  type ChatUserInputForm,
  type UserInputBooleanPromptOptions,
  type UserInputMultiselectPromptOptions,
  type UserInputPromptAnswer,
  type UserInputPromptDriver,
  type UserInputSelectPromptOptions,
  type UserInputTextPromptOptions,
} from "./user-input-prompts.ts";

function answer<TValue>(value: TValue): UserInputPromptAnswer<TValue> {
  return { status: "answered", value };
}

const cancelled = { status: "cancelled" } as const;

class ScriptedUserInputDriver implements UserInputPromptDriver {
  readonly textCalls: UserInputTextPromptOptions[] = [];
  readonly multilineCalls: UserInputTextPromptOptions[] = [];
  readonly confirmCalls: UserInputBooleanPromptOptions[] = [];
  readonly selectCalls: UserInputSelectPromptOptions[] = [];
  readonly multiselectCalls: UserInputMultiselectPromptOptions[] = [];

  private readonly textAnswers: UserInputPromptAnswer<string>[];
  private readonly multilineAnswers: UserInputPromptAnswer<string>[];
  private readonly confirmAnswers: UserInputPromptAnswer<boolean>[];
  private readonly selectAnswers: UserInputPromptAnswer<string | undefined>[];
  private readonly multiselectAnswers: UserInputPromptAnswer<readonly string[]>[];

  constructor(options: {
    readonly text?: readonly UserInputPromptAnswer<string>[];
    readonly multiline?: readonly UserInputPromptAnswer<string>[];
    readonly confirm?: readonly UserInputPromptAnswer<boolean>[];
    readonly select?: readonly UserInputPromptAnswer<string | undefined>[];
    readonly multiselect?: readonly UserInputPromptAnswer<readonly string[]>[];
  }) {
    this.textAnswers = [...(options.text ?? [])];
    this.multilineAnswers = [...(options.multiline ?? [])];
    this.confirmAnswers = [...(options.confirm ?? [])];
    this.selectAnswers = [...(options.select ?? [])];
    this.multiselectAnswers = [...(options.multiselect ?? [])];
  }

  async text(options: UserInputTextPromptOptions): Promise<UserInputPromptAnswer<string>> {
    this.textCalls.push(options);
    return this.next(this.textAnswers, "text");
  }

  async multiline(options: UserInputTextPromptOptions): Promise<UserInputPromptAnswer<string>> {
    this.multilineCalls.push(options);
    return this.next(this.multilineAnswers, "multiline");
  }

  async confirm(options: UserInputBooleanPromptOptions): Promise<UserInputPromptAnswer<boolean>> {
    this.confirmCalls.push(options);
    return this.next(this.confirmAnswers, "confirm");
  }

  async select(
    options: UserInputSelectPromptOptions,
  ): Promise<UserInputPromptAnswer<string | undefined>> {
    this.selectCalls.push(options);
    return this.next(this.selectAnswers, "select");
  }

  async multiselect(
    options: UserInputMultiselectPromptOptions,
  ): Promise<UserInputPromptAnswer<readonly string[]>> {
    this.multiselectCalls.push(options);
    return this.next(this.multiselectAnswers, "multiselect");
  }

  private next<TValue>(
    answers: UserInputPromptAnswer<TValue>[],
    prompt: string,
  ): UserInputPromptAnswer<TValue> {
    const scripted = answers.shift();
    if (scripted === undefined) {
      throw new Error(`Missing scripted ${prompt} answer`);
    }
    return scripted;
  }
}

test("typed user input maps all controls to their clack prompt shapes", async () => {
  const form = {
    title: "部署设置",
    description: "补全本次发布需要的参数",
    controls: [
      {
        type: "text",
        id: "owner",
        label: "负责人",
        required: true,
        minLength: 2,
      },
      {
        type: "multiline",
        id: "notes",
        label: "发布说明",
        required: false,
      },
      {
        type: "number",
        id: "replicas",
        label: "副本数",
        required: true,
        integer: true,
        min: 1,
        max: 10,
      },
      {
        type: "boolean",
        id: "canary",
        label: "启用灰度",
        required: true,
      },
      {
        type: "choice",
        id: "region",
        label: "部署区域",
        required: true,
        multiple: false,
        options: [
          { id: "sg", label: "Singapore" },
          { id: "us", label: "United States" },
        ],
      },
      {
        type: "choice",
        id: "workspaces",
        label: "目标 Workspace",
        required: true,
        multiple: true,
        minSelections: 1,
        maxSelections: 2,
        options: [
          { id: "frontend", label: "Frontend" },
          { id: "backend", label: "Backend" },
          { id: "docs", label: "Docs" },
        ],
      },
    ],
  } satisfies ChatUserInputForm;
  const driver = new ScriptedUserInputDriver({
    text: [answer("Alice"), answer("3")],
    multiline: [answer("ship\nnow")],
    confirm: [answer(true)],
    select: [answer("sg")],
    multiselect: [answer(["frontend", "backend"])],
  });

  const result = await createUserInputPromptAdapter(driver).request(form);

  assert.deepEqual(result, {
    status: "submitted",
    values: [
      { id: "owner", value: "Alice" },
      { id: "notes", value: "ship\nnow" },
      { id: "replicas", value: 3 },
      { id: "canary", value: true },
      { id: "region", value: "sg" },
      { id: "workspaces", value: ["frontend", "backend"] },
    ],
  });
  assert.equal(driver.textCalls.length, 2);
  assert.equal(driver.multilineCalls.length, 1);
  assert.equal(driver.confirmCalls.length, 1);
  assert.equal(driver.selectCalls.length, 1);
  assert.equal(driver.multiselectCalls.length, 1);
  assert.match(driver.textCalls[0]?.message ?? "", /部署设置/u);
  assert.match(driver.textCalls[0]?.validate("x".repeat(10_001)) ?? "", /10000/u);
  assert.match(driver.selectCalls[0]?.message ?? "", /部署区域/u);
  assert.equal(driver.selectCalls[0]?.optional, false);
});

test("number conversion and multiple-choice bounds are validated before submission", async () => {
  const form = {
    controls: [
      {
        type: "number",
        id: "replicas",
        label: "副本数",
        required: true,
        integer: true,
        min: 2,
        max: 8,
      },
      {
        type: "choice",
        id: "workspaces",
        label: "目标 Workspace",
        required: true,
        multiple: true,
        minSelections: 1,
        maxSelections: 2,
        options: [
          { id: "frontend", label: "Frontend" },
          { id: "backend", label: "Backend" },
          { id: "docs", label: "Docs" },
        ],
      },
    ],
  } satisfies ChatUserInputForm;
  const driver = new ScriptedUserInputDriver({
    text: [answer("1.5"), answer("4")],
    multiselect: [
      answer([]),
      answer(["frontend", "backend", "docs"]),
      answer(["frontend", "backend"]),
    ],
  });

  const result = await createUserInputPromptAdapter(driver).request(form);

  assert.deepEqual(result, {
    status: "submitted",
    values: [
      { id: "replicas", value: 4 },
      { id: "workspaces", value: ["frontend", "backend"] },
    ],
  });
  assert.equal(driver.textCalls.length, 2);
  assert.match(driver.textCalls[1]?.message ?? "", /请输入整数/u);
  assert.equal(driver.multiselectCalls.length, 3);
  assert.match(driver.multiselectCalls[1]?.message ?? "", /至少选择 1 项/u);
  assert.match(driver.multiselectCalls[2]?.message ?? "", /最多选择 2 项/u);
});

test("optional controls can be omitted without synthetic values", async () => {
  const form = {
    controls: [
      {
        type: "text",
        id: "alias",
        label: "别名",
        required: false,
        minLength: 3,
      },
      {
        type: "multiline",
        id: "notes",
        label: "发布说明",
        required: false,
        minLength: 3,
      },
      {
        type: "number",
        id: "budget",
        label: "预算",
        required: false,
      },
      {
        type: "choice",
        id: "region",
        label: "部署区域",
        required: false,
        multiple: false,
        options: [{ id: "sg", label: "Singapore" }],
      },
    ],
  } satisfies ChatUserInputForm;
  const driver = new ScriptedUserInputDriver({
    text: [answer(""), answer("")],
    multiline: [answer("")],
    select: [answer(undefined)],
  });

  const result = await createUserInputPromptAdapter(driver).request(form);

  assert.deepEqual(result, { status: "submitted", values: [] });
  assert.equal(driver.textCalls[0]?.validate(""), undefined);
  assert.equal(driver.multilineCalls[0]?.validate(""), undefined);
  assert.equal(driver.selectCalls[0]?.optional, true);
});

test("Esc and shutdown are normal cancelled results", async () => {
  const form = {
    controls: [
      {
        type: "text",
        id: "owner",
        label: "负责人",
        required: true,
      },
    ],
  } satisfies ChatUserInputForm;
  const escapedDriver = new ScriptedUserInputDriver({ text: [cancelled] });

  assert.deepEqual(await createUserInputPromptAdapter(escapedDriver).request(form), {
    status: "cancelled",
    reason: "用户取消",
  });

  const controller = new AbortController();
  controller.abort(new Error("shutdown"));
  const shutdownDriver = new ScriptedUserInputDriver({});
  assert.deepEqual(
    await createUserInputPromptAdapter(shutdownDriver).request(form, controller.signal),
    {
      status: "cancelled",
      reason: "会话正在关闭",
    },
  );
  assert.equal(shutdownDriver.textCalls.length, 0);
});

test("optional boolean controls prompt as a skippable select", async () => {
  const form = {
    controls: [
      { type: "boolean", id: "notify", label: "发送通知", required: false },
      { type: "boolean", id: "canary", label: "启用灰度", required: false },
    ],
  } satisfies ChatUserInputForm;
  const driver = new ScriptedUserInputDriver({
    select: [answer(undefined), answer("false")],
  });

  const result = await createUserInputPromptAdapter(driver).request(form);

  assert.deepEqual(result, {
    status: "submitted",
    values: [{ id: "canary", value: false }],
  });
  assert.equal(driver.confirmCalls.length, 0);
  assert.equal(driver.selectCalls.length, 2);
  assert.equal(driver.selectCalls[0]?.optional, true);
  assert.deepEqual(
    driver.selectCalls[0]?.options.map((option) => option.label),
    ["是", "否"],
  );
});
