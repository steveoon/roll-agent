import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserInputForm } from "@roll-agent/protocol";
import { UserInputInteractionManager } from "./user-input-interaction-manager.ts";

const FORM: UserInputForm = {
  title: "选择部署区域",
  controls: [
    {
      type: "choice",
      id: "region",
      label: "部署区域",
      required: true,
      multiple: false,
      options: [
        { id: "east", label: "东区" },
        { id: "west", label: "西区" },
      ],
    },
  ],
};

test("UserInputInteractionManager settles once and rejects duplicate late settlement", async () => {
  const manager = new UserInputInteractionManager();
  const interaction = manager.request(FORM, new Date(Date.now() + 60_000).toISOString());

  assert.equal(
    manager.resolve(interaction.requestId, {
      status: "submitted",
      values: [{ id: "region", value: "east" }],
    }),
    true,
  );
  assert.equal(manager.cancel(interaction.requestId, "late cancellation"), false);
  assert.deepEqual(await interaction.result, {
    status: "submitted",
    values: [{ id: "region", value: "east" }],
  });
});

test("UserInputInteractionManager treats expiry and cancelAll as normal cancellation", async () => {
  const manager = new UserInputInteractionManager();
  const expired = manager.request(FORM, new Date(Date.now() - 1).toISOString());
  assert.deepEqual(await expired.result, {
    status: "cancelled",
    reason: "用户输入请求已超时",
  });

  const first = manager.request(FORM, new Date(Date.now() + 60_000).toISOString());
  const second = manager.request(FORM, new Date(Date.now() + 60_000).toISOString());
  manager.cancelAll("客户端断开连接");
  assert.deepEqual(await first.result, {
    status: "cancelled",
    reason: "客户端断开连接",
  });
  assert.deepEqual(await second.result, {
    status: "cancelled",
    reason: "客户端断开连接",
  });
});

test("UserInputInteractionManager rejects a response after the absolute deadline before the timer runs", async () => {
  let now = Date.parse("2026-08-04T10:00:00.000Z");
  const manager = new UserInputInteractionManager(() => now);
  const interaction = manager.request(FORM, "2026-08-04T10:00:01.000Z");

  now += 1_000;
  assert.equal(
    manager.resolve(interaction.requestId, {
      status: "submitted",
      values: [{ id: "region", value: "east" }],
    }),
    false,
  );
  assert.deepEqual(await interaction.result, {
    status: "cancelled",
    reason: "用户输入请求已超时",
  });
});

test("UserInputInteractionManager cancels a submission that violates the original form", async () => {
  const manager = new UserInputInteractionManager();
  const interaction = manager.request(FORM, new Date(Date.now() + 60_000).toISOString());

  assert.equal(
    manager.resolve(interaction.requestId, {
      status: "submitted",
      values: [{ id: "region", value: "north" }],
    }),
    false,
  );
  assert.deepEqual(await interaction.result, {
    status: "cancelled",
    reason: "用户输入不符合原始表单约束",
  });
  assert.equal(manager.cancel(interaction.requestId, "late cancellation"), false);
});

test("UserInputInteractionManager snapshots the form before exposing the interaction", async () => {
  const manager = new UserInputInteractionManager();
  const form: UserInputForm = {
    controls: [
      {
        type: "choice",
        id: "region",
        label: "部署区域",
        required: true,
        multiple: false,
        options: [{ id: "east", label: "东区" }],
      },
    ],
  };
  const interaction = manager.request(form, new Date(Date.now() + 60_000).toISOString());
  const sourceControl = form.controls[0];
  const exposedControl = interaction.form.controls[0];
  assert.ok(sourceControl?.type === "choice");
  assert.ok(exposedControl?.type === "choice");
  sourceControl.options.push({ id: "north", label: "北区" });
  exposedControl.options.push({ id: "north", label: "北区" });

  assert.equal(
    manager.resolve(interaction.requestId, {
      status: "submitted",
      values: [{ id: "region", value: "north" }],
    }),
    false,
  );
  assert.deepEqual(await interaction.result, {
    status: "cancelled",
    reason: "用户输入不符合原始表单约束",
  });
});

test("UserInputInteractionManager normalizes submitted values into form definition order", async () => {
  const manager = new UserInputInteractionManager();
  const form: UserInputForm = {
    controls: [
      { type: "text", id: "first", label: "第一项", required: true },
      { type: "boolean", id: "second", label: "第二项", required: true },
    ],
  };
  const interaction = manager.request(form, new Date(Date.now() + 60_000).toISOString());

  assert.equal(
    manager.resolve(interaction.requestId, {
      status: "submitted",
      values: [
        { id: "second", value: true },
        { id: "first", value: "值" },
      ],
    }),
    true,
  );
  assert.deepEqual(await interaction.result, {
    status: "submitted",
    values: [
      { id: "first", value: "值" },
      { id: "second", value: true },
    ],
  });
});
