import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelConfigController } from "@roll-agent/runtime";
import { rollConfigSchema } from "../../config/schema.ts";
import { createChatConfigurationControl } from "./configuration-control.ts";

function config() {
  return rollConfigSchema.parse({
    llm: {
      defaultProvider: "openai",
      defaultModel: "old",
      providers: { openai: { apiKey: "private" } },
    },
    agents: { dataDir: "/isolated/agents" },
    ask: {},
  });
}

test("chat reload waits for full operation, blocks admission after failure, and recovers", async () => {
  const startup = config();
  let latest = startup;
  let invalid = false;
  let applied = 0;
  const notices: string[] = [];
  const control = createChatConfigurationControl({
    runtime: { ModelConfigController },
    initial: { provider: "openai", model: "old" },
    startupConfig: startup,
    source: "/selected/config.yaml",
    workspace: "/project/a",
    read: () => {
      if (invalid) throw new Error("private-token-DO-NOT-LEAK");
      return latest;
    },
    getThinkingLevel: () => "medium",
    apply: async (selected, signal) => {
      signal?.throwIfAborted();
      applied++;
      return {
        status: "applied",
        model: { provider: "openai", model: selected.runtime.model ?? selected.llm.defaultModel },
      };
    },
  });
  const unsubscribe = control.subscribe((snapshot) => notices.push(snapshot.text));
  control.lifecycle.begin();
  latest = { ...startup, runtime: { ...startup.runtime, model: "new" } };
  assert.match(control.reload().text, /等待/u);
  assert.equal(applied, 0);
  assert.throws(() => control.lifecycle.begin(), /待应用/u);
  control.lifecycle.end();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(applied, 1);
  assert.equal(control.snapshot().model, "new");
  invalid = true;
  control.reload();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.throws(() => control.assertReady(), /失败/u);
  assert.equal(control.snapshot().model, "new");
  assert.equal(notices.join().includes("private-token"), false);
  invalid = false;
  control.reload();
  await new Promise<void>((resolve) => setImmediate(resolve));
  control.assertReady();
  latest = { ...latest, agents: { ...latest.agents, dataDir: "/changed" } };
  control.reload();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(control.snapshot().text, /重启/u);
  assert.equal(applied, 2);
  unsubscribe();
  control.close();
});

test("chat close aborts pending asynchronous preparation before model commit", async () => {
  const startup = config();
  let release: (() => void) | undefined;
  let applied = false;
  const control = createChatConfigurationControl({
    runtime: { ModelConfigController },
    initial: { provider: "openai", model: "old" },
    startupConfig: startup,
    source: "/selected",
    workspace: "/project",
    read: () => startup,
    getThinkingLevel: () => "medium",
    apply: async (_latest, signal) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      signal?.throwIfAborted();
      applied = true;
      return { status: "applied", model: { provider: "openai", model: "new" } };
    },
  });
  control.reload();
  control.close();
  release?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(applied, false);
});

test("a session model action prepared before reload cannot commit after it applied", async () => {
  const startup = config();
  const control = createChatConfigurationControl({
    runtime: { ModelConfigController },
    initial: { provider: "openai", model: "old" },
    startupConfig: startup,
    source: "/selected",
    workspace: "/project",
    read: () => startup,
    getThinkingLevel: () => "medium",
    apply: async () => ({ status: "applied", model: { provider: "openai", model: "new" } }),
  });
  const commitOldAction = control.guard();
  control.reload();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.throws(commitOldAction, /已变化/u);
  control.guard()();
  control.close();
});

test("reload without a bound source reports unavailability without changing admission or active identity", () => {
  const startup = config();
  const control = createChatConfigurationControl({
    runtime: { ModelConfigController },
    initial: { provider: "openai", model: "old" },
    startupConfig: startup,
    source: "内置默认配置",
    workspace: "/project",
    getThinkingLevel: () => "medium",
    apply: async () => {
      throw new Error("must never apply without a selected source");
    },
  });
  try {
    const before = control.snapshot();
    const validateSelection = control.guard();
    assert.throws(() => control.reload(), /未绑定配置文件/u);
    assert.deepEqual(control.snapshot(), before);
    validateSelection();
    control.lifecycle.begin();
    control.lifecycle.end();
    control.adoptActive({ provider: "openai", model: "session-model" });
    assert.equal(control.snapshot().model, "session-model");
    assert.throws(() => control.reload(), /未绑定配置文件/u);
    control.assertReady();
  } finally {
    control.close();
  }
});
