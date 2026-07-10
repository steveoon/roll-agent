import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StructuredToolError } from "@roll-agent/sdk";
import { withBrowserInstanceLock } from "./browser-instance-lock.ts";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function createDeferred(): Deferred {
  let deferredResolve!: () => void;
  let deferredReject!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    deferredResolve = resolve;
    deferredReject = reject;
  });
  return { promise, resolve: deferredResolve, reject: deferredReject };
}

async function waitForMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("withBrowserInstanceLock", () => {
  it("serializes runs on the same instance", async () => {
    const events: string[] = [];
    const gate = createDeferred();

    const first = withBrowserInstanceLock("serial-same", async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    });
    const second = withBrowserInstanceLock("serial-same", async () => {
      events.push("second:start");
    });

    await waitForMicrotasks();
    assert.deepEqual(events, ["first:start"]);

    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
  });

  it("keeps different instances parallel", async () => {
    const events: string[] = [];
    const gate = createDeferred();

    const first = withBrowserInstanceLock("parallel-a", async () => {
      events.push("a:start");
      await gate.promise;
    });
    const second = withBrowserInstanceLock("parallel-b", async () => {
      events.push("b:start");
    });

    await waitForMicrotasks();
    assert.deepEqual(events, ["a:start", "b:start"]);

    gate.resolve();
    await Promise.all([first, second]);
  });

  it("lets queued runs proceed after a prior failure", async () => {
    const events: string[] = [];

    const first = withBrowserInstanceLock("serial-failure", async () => {
      throw new Error("first failed");
    });
    const second = withBrowserInstanceLock("serial-failure", async () => {
      events.push("second:start");
    });

    await assert.rejects(first, /first failed/);
    await second;
    assert.deepEqual(events, ["second:start"]);
  });

  it("discards a queued run when the signal aborts while waiting", async () => {
    const events: string[] = [];
    const gate = createDeferred();
    const controller = new AbortController();

    const first = withBrowserInstanceLock("abort-queued", async () => {
      events.push("first:start");
      await gate.promise;
    });
    const second = withBrowserInstanceLock(
      "abort-queued",
      async () => {
        events.push("second:start");
      },
      { signal: controller.signal },
    );

    await waitForMicrotasks();
    controller.abort();

    await assert.rejects(
      second,
      (error) =>
        error instanceof StructuredToolError && error.payload.code === "cancelled_while_queued",
    );

    gate.resolve();
    await first;

    // 被取消的排队者不能卡死队列：后续调用应正常执行
    const third = withBrowserInstanceLock("abort-queued", async () => {
      events.push("third:start");
    });
    await third;
    assert.deepEqual(events, ["first:start", "third:start"]);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let executed = false;

    await assert.rejects(
      withBrowserInstanceLock(
        "abort-upfront",
        async () => {
          executed = true;
        },
        { signal: controller.signal },
      ),
      (error) =>
        error instanceof StructuredToolError && error.payload.code === "cancelled_while_queued",
    );
    assert.equal(executed, false);
  });

  it("invokes onWait only under contention", async () => {
    const gate = createDeferred();
    const waits: number[] = [];

    const uncontended = withBrowserInstanceLock(
      "on-wait",
      async () => {
        await gate.promise;
      },
      { onWait: (waitedMs) => waits.push(waitedMs) },
    );
    assert.equal(waits.length, 0);

    const contended = withBrowserInstanceLock("on-wait", async () => {}, {
      onWait: (waitedMs) => waits.push(waitedMs),
    });

    gate.resolve();
    await Promise.all([uncontended, contended]);

    assert.equal(waits.length, 1);
    assert.ok(waits[0] !== undefined && waits[0] >= 0);
  });

  it("releases the lock even when the onWait callback throws", async () => {
    const gate = createDeferred();

    const first = withBrowserInstanceLock("on-wait-throw", async () => {
      await gate.promise;
    });
    const second = withBrowserInstanceLock("on-wait-throw", async () => {}, {
      onWait: () => {
        throw new Error("onWait failed");
      },
    });

    gate.resolve();
    await first;
    await assert.rejects(second, /onWait failed/);

    // onWait 抛错不能把锁留在占用状态，后续调用必须能正常执行
    let executed = false;
    await withBrowserInstanceLock("on-wait-throw", async () => {
      executed = true;
    });
    assert.equal(executed, true);
  });

  it("releases the tail so later calls run without contention", async () => {
    let contentionCount = 0;

    await withBrowserInstanceLock("tail-cleanup", async () => {});
    await withBrowserInstanceLock("tail-cleanup", async () => {}, {
      onWait: () => {
        contentionCount += 1;
      },
    });

    assert.equal(contentionCount, 0);
  });
});
