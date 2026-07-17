import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  readToolOutcome,
  successfulToolResult,
} from "./normalize-result.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  ToolExecutionCoordinator,
  type ToolExecutionPlan,
} from "./tool-execution-coordinator.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resourcePlan(key: string, mode: "read" | "write"): ToolExecutionPlan {
  return { resources: () => [{ key, mode }] };
}

async function maxConcurrency(left: ToolExecutionPlan, right: ToolExecutionPlan): Promise<number> {
  const coordinator = new ToolExecutionCoordinator();
  coordinator.register("left", left);
  coordinator.register("right", right);
  coordinator.startBatch("batch");
  await coordinator.prepare("c1", "left", {});
  await coordinator.prepare("c2", "right", {});
  coordinator.sealBatch("batch");
  let active = 0;
  let maxActive = 0;
  const run = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(20);
    active -= 1;
    return successfulToolResult("ok");
  };
  await Promise.all([
    coordinator.execute("c1", "left", {}, undefined, run),
    coordinator.execute("c2", "right", {}, undefined, run),
  ]);
  return maxActive;
}

test("ToolExecutionCoordinator 同资源 read/read 并行", async () => {
  assert.equal(
    await maxConcurrency(
      resourcePlan("browser:session", TOOL_RESOURCE_ACCESS_MODES.read),
      resourcePlan("browser:session", TOOL_RESOURCE_ACCESS_MODES.read),
    ),
    2,
  );
});

test("ToolExecutionCoordinator 同资源 write/write 串行", async () => {
  assert.equal(
    await maxConcurrency(
      resourcePlan("browser:session", TOOL_RESOURCE_ACCESS_MODES.write),
      resourcePlan("browser:session", TOOL_RESOURCE_ACCESS_MODES.write),
    ),
    1,
  );
});

test("ToolExecutionCoordinator 同资源 read/write 串行", async () => {
  assert.equal(
    await maxConcurrency(
      resourcePlan("browser:session", TOOL_RESOURCE_ACCESS_MODES.read),
      resourcePlan("browser:session", TOOL_RESOURCE_ACCESS_MODES.write),
    ),
    1,
  );
});

test("ToolExecutionCoordinator 不同资源 write/write 并行", async () => {
  assert.equal(
    await maxConcurrency(
      resourcePlan("conversation:a", TOOL_RESOURCE_ACCESS_MODES.write),
      resourcePlan("conversation:b", TOOL_RESOURCE_ACCESS_MODES.write),
    ),
    2,
  );
});

test("ToolExecutionCoordinator Unicode 等价反序多锁使用严格全序且不会死锁", async () => {
  const nfcKey = "custom:\u00e9";
  const nfdKey = "custom:e\u0301";
  assert.notEqual(nfcKey, nfdKey);
  assert.equal(nfcKey.localeCompare(nfdKey), 0);
  const plan = (keys: readonly string[]): ToolExecutionPlan => ({
    resources: () => keys.map((key) => ({ key, mode: TOOL_RESOURCE_ACCESS_MODES.write })),
  });

  const result = await Promise.race([
    maxConcurrency(plan([nfcKey, nfdKey]), plan([nfdKey, nfcKey])).then((maxActive) => ({
      kind: "completed" as const,
      maxActive,
    })),
    delay(200).then(() => ({ kind: "timeout" as const })),
  ]);

  assert.deepEqual(result, { kind: "completed", maxActive: 1 });
});

test("ToolExecutionCoordinator describeResources 复用执行计划且观察失败不阻断事件流", () => {
  const coordinator = new ToolExecutionCoordinator();
  coordinator.register("known", {
    resources: (input) => [
      {
        key: `file:${String((input as { readonly path: string }).path)}`,
        mode: TOOL_RESOURCE_ACCESS_MODES.write,
      },
    ],
  });
  coordinator.register("broken", {
    resources: () => {
      throw new Error("planner failed");
    },
  });

  assert.deepEqual(coordinator.describeResources("known", { path: "/tmp/a" }), [
    { key: "file:/tmp/a", mode: TOOL_RESOURCE_ACCESS_MODES.write },
  ]);
  assert.deepEqual(coordinator.describeResources("missing", {}), []);
  assert.deepEqual(coordinator.describeResources("broken", {}), []);
});

test("ToolExecutionCoordinator 串行完成整批准入后才允许副作用", async () => {
  const coordinator = new ToolExecutionCoordinator();
  const firstGate = Promise.withResolvers<void>();
  const order: string[] = [];
  coordinator.register("first", {
    prepare: async () => {
      order.push("prepare:first:start");
      await firstGate.promise;
      order.push("prepare:first:end");
      return undefined;
    },
    resources: () => [],
  });
  coordinator.register("second", {
    prepare: () => {
      order.push("prepare:second");
      return undefined;
    },
    resources: () => [],
  });
  coordinator.startBatch("batch");
  const first = coordinator.prepare("c1", "first", {});
  const second = coordinator.prepare("c2", "second", {});
  await delay(0);
  assert.deepEqual(order, ["prepare:first:start"]);
  firstGate.resolve();
  await Promise.all([first, second]);
  coordinator.sealBatch("batch");
  assert.deepEqual(order, ["prepare:first:start", "prepare:first:end", "prepare:second"]);
});

test("ToolExecutionCoordinator execute 在 batch seal 前不会启动副作用", async () => {
  const coordinator = new ToolExecutionCoordinator();
  coordinator.register("tool", { resources: () => [] });
  coordinator.startBatch("batch");
  await coordinator.prepare("c1", "tool", {});
  let sideEffects = 0;
  const execution = coordinator.execute("c1", "tool", {}, undefined, async () => {
    sideEffects += 1;
    return successfulToolResult("ok");
  });

  await delay(0);
  assert.equal(sideEffects, 0);

  coordinator.sealBatch("batch", [{ toolCallId: "c1", toolId: "tool" }]);
  assert.equal(readToolOutcome(await execution).kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(sideEffects, 1);
});

test("ToolExecutionCoordinator seal-before-late-prepare 仍等待全部 tracked prepare", async () => {
  const coordinator = new ToolExecutionCoordinator();
  const releaseSecondPrepare = Promise.withResolvers<void>();
  coordinator.register("first", { resources: () => [] });
  coordinator.register("second", {
    prepare: async () => {
      await releaseSecondPrepare.promise;
      return undefined;
    },
    resources: () => [],
  });
  coordinator.startBatch("batch");
  coordinator.sealBatch("batch", [
    { toolCallId: "c1", toolId: "first" },
    { toolCallId: "c2", toolId: "second" },
  ]);
  await coordinator.prepare("c1", "first", {});
  let firstSideEffects = 0;
  const firstExecution = coordinator.execute("c1", "first", {}, undefined, async () => {
    firstSideEffects += 1;
    return successfulToolResult("first");
  });
  const secondPreparation = coordinator.prepare("c2", "second", {});

  await delay(0);
  assert.equal(firstSideEffects, 0);

  releaseSecondPrepare.resolve();
  await secondPreparation;
  assert.equal(readToolOutcome(await firstExecution).kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(firstSideEffects, 1);
  const second = await coordinator.execute("c2", "second", {}, undefined, async () =>
    successfulToolResult("second"),
  );
  assert.equal(readToolOutcome(second).kind, TOOL_OUTCOME_KINDS.success);
});

test("ToolExecutionCoordinator admission 等待可取消且不会阻塞同批其他调用", async () => {
  const coordinator = new ToolExecutionCoordinator();
  coordinator.register("first", { resources: () => [] });
  coordinator.register("second", { resources: () => [] });
  coordinator.startBatch("batch");
  coordinator.sealBatch("batch", [
    { toolCallId: "c1", toolId: "first" },
    { toolCallId: "c2", toolId: "second" },
  ]);
  await coordinator.prepare("c1", "first", {});
  const controller = new AbortController();
  const firstExecution = coordinator.execute("c1", "first", {}, controller.signal, async () =>
    successfulToolResult("unexpected"),
  );

  await delay(0);
  controller.abort(new Error("cancel admission wait"));
  await assert.rejects(firstExecution, /cancel admission wait/u);

  await coordinator.prepare("c2", "second", {});
  const second = await coordinator.execute("c2", "second", {}, undefined, async () =>
    successfulToolResult("second"),
  );
  assert.equal(readToolOutcome(second).kind, TOOL_OUTCOME_KINDS.success);
});

test("ToolExecutionCoordinator finishTurn 释放未 seal 的 admission waiter", async () => {
  const coordinator = new ToolExecutionCoordinator();
  coordinator.register("tool", { resources: () => [] });
  coordinator.startBatch("batch");
  await coordinator.prepare("c1", "tool", {});
  let sideEffects = 0;
  const execution = coordinator.execute("c1", "tool", {}, undefined, async () => {
    sideEffects += 1;
    return successfulToolResult("unexpected");
  });

  await delay(0);
  coordinator.finishTurn();

  assert.equal(readToolOutcome(await execution).kind, TOOL_OUTCOME_KINDS.cancelled);
  assert.equal(sideEffects, 0);
});

test("ToolExecutionCoordinator 迟到旧 prepare 不会清理复用同 identity 的新 batch", async () => {
  const coordinator = new ToolExecutionCoordinator();
  const releaseOldPrepare = Promise.withResolvers<void>();
  let prepareCalls = 0;
  coordinator.register("tool", {
    prepare: async () => {
      prepareCalls += 1;
      if (prepareCalls === 1) {
        await releaseOldPrepare.promise;
      }
      return undefined;
    },
    resources: () => [],
  });
  coordinator.startBatch("reused-batch");
  const oldPrepare = coordinator.prepare("c1", "tool", {});
  coordinator.sealBatch("reused-batch", [{ toolCallId: "c1", toolId: "tool" }]);
  let oldSideEffects = 0;
  const oldExecution = coordinator.execute("c1", "tool", {}, undefined, async () => {
    oldSideEffects += 1;
    return successfulToolResult("unexpected");
  });

  await delay(0);
  coordinator.finishTurn();
  assert.equal(readToolOutcome(await oldExecution).kind, TOOL_OUTCOME_KINDS.cancelled);
  assert.equal(oldSideEffects, 0);

  coordinator.startBatch("reused-batch");
  await coordinator.prepare("c1", "tool", {});
  coordinator.sealBatch("reused-batch", [{ toolCallId: "c1", toolId: "tool" }]);

  releaseOldPrepare.resolve();
  await oldPrepare;

  let freshSideEffects = 0;
  const fresh = await coordinator.execute("c1", "tool", {}, undefined, async () => {
    freshSideEffects += 1;
    return successfulToolResult("fresh");
  });
  assert.equal(readToolOutcome(fresh).kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(prepareCalls, 2);
  assert.equal(freshSideEffects, 1);
});

test("ToolExecutionCoordinator 任一 user_rejected 使整批零副作用", async () => {
  const coordinator = new ToolExecutionCoordinator();
  coordinator.register("allowed", { resources: () => [] });
  coordinator.register("rejected", {
    prepare: () =>
      failedToolResult(TOOL_OUTCOME_KINDS.userRejected, "用户拒绝", {
        reason: "用户拒绝",
      }),
    resources: () => [],
  });
  coordinator.startBatch("batch");
  await coordinator.prepare("c1", "allowed", {});
  await coordinator.prepare("c2", "rejected", {});
  coordinator.sealBatch("batch");
  let sideEffects = 0;
  const invoke = async () => {
    sideEffects += 1;
    return successfulToolResult("unexpected");
  };
  const [allowed, rejected] = await Promise.all([
    coordinator.execute("c1", "allowed", {}, undefined, invoke),
    coordinator.execute("c2", "rejected", {}, undefined, invoke),
  ]);
  assert.equal(sideEffects, 0);
  assert.equal(readToolOutcome(allowed).kind, TOOL_OUTCOME_KINDS.cancelled);
  assert.equal(readToolOutcome(rejected).kind, TOOL_OUTCOME_KINDS.userRejected);
});

test("ToolExecutionCoordinator policy_denied 只阻断目标调用", async () => {
  const coordinator = new ToolExecutionCoordinator();
  coordinator.register("allowed", { resources: () => [] });
  coordinator.register("denied", {
    prepare: () => failedToolResult(TOOL_OUTCOME_KINDS.policyDenied, "策略拒绝"),
    resources: () => [],
  });
  coordinator.startBatch("batch");
  await coordinator.prepare("c1", "allowed", {});
  await coordinator.prepare("c2", "denied", {});
  coordinator.sealBatch("batch");
  let sideEffects = 0;
  const allowed = await coordinator.execute("c1", "allowed", {}, undefined, async () => {
    sideEffects += 1;
    return successfulToolResult("ok");
  });
  const denied = await coordinator.execute("c2", "denied", {}, undefined, async () => {
    sideEffects += 1;
    return successfulToolResult("unexpected");
  });
  assert.equal(sideEffects, 1);
  assert.equal(readToolOutcome(allowed).kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readToolOutcome(denied).kind, TOOL_OUTCOME_KINDS.policyDenied);
});

test("ToolExecutionCoordinator lock waiter abort 后不泄漏资源", async () => {
  const coordinator = new ToolExecutionCoordinator();
  const plan = resourcePlan("shared", TOOL_RESOURCE_ACCESS_MODES.write);
  coordinator.register("tool", plan);
  const releaseFirst = Promise.withResolvers<void>();
  const first = coordinator.execute("c1", "tool", {}, undefined, async () => {
    await releaseFirst.promise;
    return successfulToolResult("first");
  });
  await delay(0);
  const controller = new AbortController();
  const abortReason = new Error("cancelled while waiting");
  const second = coordinator.execute("c2", "tool", {}, controller.signal, async () =>
    successfulToolResult("unexpected"),
  );
  controller.abort(abortReason);
  await assert.rejects(second, /cancelled while waiting/u);
  releaseFirst.resolve();
  await first;
  const third = await coordinator.execute("c3", "tool", {}, undefined, async () =>
    successfulToolResult("third"),
  );
  assert.equal(readToolOutcome(third).kind, TOOL_OUTCOME_KINDS.success);
});
