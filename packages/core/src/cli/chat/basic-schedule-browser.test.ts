import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";
import { getEventListeners } from "node:events";
import { runBasicScheduleBrowser } from "./basic-schedule-browser.ts";
import type { ScheduleBrowserPort } from "./schedule-browser.ts";

async function waitUntil(check: () => boolean): Promise<void> {
  const end = Date.now() + 2500;
  while (!check()) {
    if (Date.now() > end) assert.fail("prompt did not appear");
    await delay(10);
  }
}

for (const scenario of [
  {
    name: "active completed run",
    taskStatus: "active",
    runStatus: "completed",
    mode: "scheduled",
    removed: false,
    reason: undefined,
    taskLabel: "已启用",
    runLabel: "成功",
    modeLabel: "定时触发",
  },
  {
    name: "removed task with missing ledger",
    taskStatus: null,
    runStatus: null,
    mode: "manual",
    removed: true,
    reason: "ledger_missing",
    taskLabel: "已移除",
    runLabel: "历史状态不可用",
    modeLabel: "手动触发",
  },
] as const) {
  test(`basic viewer localizes ${scenario.name} and preserves stdin after keyboard navigation`, async () => {
    const input = new PassThrough();
    let outputText = "";
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        outputText += chunk.toString();
        callback();
      },
    });
    Object.assign(input, { isTTY: true, setRawMode() {} });
    Object.assign(output, { isTTY: true, columns: 100, rows: 30 });
    const rl = createInterface({ input, output });
    rl.pause();
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 4000);
    const port: ScheduleBrowserPort = {
      async listTasks() {
        return [
          {
            id: "t",
            name: "每日检查",
            trigger: "每天",
            status: scenario.taskStatus,
            lastRunStatus: scenario.runStatus,
            removed: scenario.removed,
          },
        ];
      },
      async listRuns() {
        return {
          items: [
            {
              id: "r",
              scheduledAt: "今天",
              mode: scenario.mode,
              status: scenario.runStatus,
              attempts: [1],
            },
          ],
        };
      },
      async inspect() {
        return {
          invocationId: "r",
          taskName: "每日检查",
          cwd: "/old",
          mode: scenario.mode,
          status: scenario.runStatus,
          ...(scenario.reason === undefined ? {} : { statusUnavailableReason: scenario.reason }),
          attempt: 1,
          attempts: [1],
          sessionId: "s",
          canContinue: true,
        };
      },
      async readTranscript() {
        return { text: "user: 请求\ntool: 归档完整证据\nassistant: 结果" };
      },
      async continueRun() {
        assert.fail("viewing must not create a session");
      },
    };
    const done = runBasicScheduleBrowser(port, { input, output, signal: abort.signal });
    try {
      await waitUntil(() => outputText.includes("定时任务"));
      assert.ok(outputText.includes(scenario.taskLabel));
      assert.ok(outputText.includes(`最近${scenario.runLabel}`));
      if (scenario.removed) assert.match(outputText, /历史任务 · 每日检查/);
      input.write("\r");
      await waitUntil(() => outputText.includes("运行记录"));
      assert.ok(outputText.includes(`${scenario.modeLabel} · ${scenario.runLabel}`));
      input.write("\r");
      await waitUntil(() => outputText.includes("归档完整证据"));
      assert.ok(outputText.includes(`触发方式：${scenario.modeLabel}`));
      if (scenario.reason !== undefined) assert.match(outputText, /运行账本记录已不可用/);
      assert.doesNotMatch(
        outputText,
        /\b(?:active|paused|scheduled|manual|completed|ledger_missing|null)\b/,
      );
      const detailEnd = outputText.length;
      input.write("\x1b");
      await waitUntil(() => outputText.slice(detailEnd).includes("运行记录"));
      const runsEnd = outputText.length;
      input.write("\x1b");
      await waitUntil(() => outputText.slice(runsEnd).includes("定时任务"));
      input.write("\x1b");
      assert.equal(await done, undefined);
      assert.equal(abort.signal.aborted, false, outputText);
      assert.equal(getEventListeners(abort.signal, "abort").length, 0);
      assert.equal(input.destroyed, false);
      rl.resume();
      const next = new Promise<string>((resolve) => rl.once("line", resolve));
      input.write("继续聊天\n");
      assert.equal(await next, "继续聊天");
      rl.close();
    } finally {
      clearTimeout(deadline);
      abort.abort();
      await done;
      rl.close();
      input.destroy();
      output.destroy();
    }
  });
}
