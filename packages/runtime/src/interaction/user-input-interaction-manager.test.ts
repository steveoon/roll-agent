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
