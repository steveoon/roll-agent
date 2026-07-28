import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createChatEngineSignalScope,
  type ChatEngineShutdownSignal,
} from "./engine-signal-scope.ts";

class FakeSignalSource extends EventEmitter {
  emitSignal(signal: ChatEngineShutdownSignal): void {
    this.emit(signal, signal);
  }
}

test("Chat Engine signal scope 首个信号立即且仅一次触发 dispose", async () => {
  const signalSource = new FakeSignalSource();
  const disposeFinished = Promise.withResolvers<void>();
  const signals: ChatEngineShutdownSignal[] = [];
  let disposeCalls = 0;
  const scope = createChatEngineSignalScope({
    signalSource,
    onSignal: (signal) => signals.push(signal),
  });
  scope.setEngine({
    dispose: async () => {
      disposeCalls += 1;
      disposeFinished.resolve();
    },
  });

  signalSource.emitSignal("SIGTERM");
  signalSource.emitSignal("SIGINT");
  await disposeFinished.promise;

  assert.equal(scope.receivedSignal, "SIGTERM");
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(disposeCalls, 1);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("Chat Engine signal scope 记住 Engine 绑定前到达的信号", async () => {
  const signalSource = new FakeSignalSource();
  const disposeFinished = Promise.withResolvers<void>();
  let disposeCalls = 0;
  const scope = createChatEngineSignalScope({ signalSource });

  signalSource.emitSignal("SIGINT");
  assert.equal(scope.receivedSignal, "SIGINT");

  scope.setEngine({
    dispose: async () => {
      disposeCalls += 1;
      disposeFinished.resolve();
    },
  });
  await disposeFinished.promise;

  assert.equal(disposeCalls, 1);
});

test("Chat Engine signal scope 在当前 signal dispatch 结束后再移除监听", async () => {
  const signalSource = new FakeSignalSource();
  const observedListenerCounts: number[] = [];
  const scope = createChatEngineSignalScope({ signalSource });
  scope.setEngine({ dispose: async () => {} });
  signalSource.on("SIGTERM", () => {
    observedListenerCounts.push(signalSource.listenerCount("SIGTERM"));
  });

  signalSource.emitSignal("SIGTERM");

  assert.deepEqual(observedListenerCounts, [2]);
  await Promise.resolve();
  assert.equal(signalSource.listenerCount("SIGTERM"), 1);
  scope.dispose();
});

test("Chat Engine signal scope dispose 仅移除监听，不关闭 Engine", () => {
  const signalSource = new FakeSignalSource();
  let disposeCalls = 0;
  const scope = createChatEngineSignalScope({ signalSource });
  scope.setEngine({
    dispose: async () => {
      disposeCalls += 1;
    },
  });

  scope.dispose();
  signalSource.emitSignal("SIGTERM");

  assert.equal(scope.receivedSignal, undefined);
  assert.equal(disposeCalls, 0);
});

test("Chat Engine signal scope 报告异步 dispose 失败", async () => {
  const signalSource = new FakeSignalSource();
  const reported = Promise.withResolvers<unknown>();
  const failure = new Error("dispose failed");
  const scope = createChatEngineSignalScope({
    signalSource,
    onDisposeError: (error) => reported.resolve(error),
  });
  scope.setEngine({
    dispose: async () => {
      throw failure;
    },
  });

  signalSource.emitSignal("SIGTERM");

  assert.equal(await reported.promise, failure);
});
