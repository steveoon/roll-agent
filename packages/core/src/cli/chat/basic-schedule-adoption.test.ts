import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ThreadStore, type AgentSession, type SessionEvent } from "@roll-agent/runtime";
import { runRepl } from "../commands/chat.ts";
import type { ScheduleBrowserPort } from "./schedule-browser.ts";

async function waitFor(check: () => void): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(10);
    }
  }
}

test("basic /schedule keeps an adopted discussion usable when retiring the original session rejects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-schedule-adoption-"));
  const store = new ThreadStore(dir);
  const priorId = store.createThread({ title: "原聊天" });
  const forkId = store.createThread({ title: "新讨论" });
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
  const abort = new AbortController();
  const sent: Array<{ id: string; text: string }> = [];
  const adopted: string[] = [];
  const userInput = new Map<string, boolean>();
  let adoptionSeenAtClose = false;
  const makeSession = (id: string): AgentSession =>
    ({
      id,
      getContextWindow: () => undefined,
      getSkillSummaries: () => [],
      setUserInputAvailable: (available: boolean) => {
        userInput.set(id, available);
      },
      async *send(text: string): AsyncGenerator<SessionEvent> {
        sent.push({ id, text });
        yield { type: "message-finish", text: "" };
      },
      async close() {
        if (id === priorId) {
          adoptionSeenAtClose = adopted.includes(forkId);
          throw new Error("injected original close failure");
        }
      },
    }) as unknown as AgentSession;
  const fork = makeSession(forkId);
  const port: ScheduleBrowserPort = {
    async listTasks() {
      return [{ id: "task", name: "定时检查", trigger: "每天", status: "active", removed: false }];
    },
    async listRuns() {
      return {
        items: [
          { id: "run", scheduledAt: "今天", mode: "scheduled", status: "completed", attempts: [1] },
        ],
      };
    },
    async inspect() {
      return {
        invocationId: "run",
        taskName: "定时检查",
        attempt: 1,
        attempts: [1],
        cwd: "/original",
        mode: "scheduled",
        status: "completed",
        canContinue: true,
        sessionId: "execution",
      };
    },
    async readTranscript() {
      return { text: "只读执行证据" };
    },
    async continueRun() {
      return fork;
    },
  };
  const deadline = setTimeout(() => abort.abort(), 8000);
  const done = runRepl(makeSession(priorId), store, false, {
    input,
    output,
    signal: abort.signal,
    scheduleBrowser: port,
    onActiveSessionChange: (session) => adopted.push(session.id),
  });
  let failure: unknown;
  done.catch((error: unknown) => {
    failure = error;
  });
  try {
    await waitFor(() => assert.match(outputText, /› /));
    input.write("/schedule\r");
    await waitFor(() => assert.match(outputText, /定时任务/));
    input.write("\r");
    await waitFor(() => assert.match(outputText, /运行记录/));
    input.write("\r");
    await waitFor(() => assert.match(outputText, /只读执行证据/));
    const detailEnd = outputText.length;
    input.write("\r");
    await waitFor(() => {
      if (failure !== undefined) throw failure;
      assert.deepEqual(adopted, [forkId]);
      assert.match(outputText.slice(detailEnd), /› /);
    });
    assert.equal(adoptionSeenAtClose, true);
    assert.equal(userInput.get(priorId), false);
    assert.equal(userInput.get(forkId), true);
    assert.deepEqual(sent, []);
    const sendEnd = outputText.length;
    input.write("继续排查\r");
    await waitFor(() => {
      assert.deepEqual(sent, [{ id: forkId, text: "继续排查" }]);
      assert.match(outputText.slice(sendEnd), /› /);
    });
    input.write("exit\r");
    await done;
    assert.equal(abort.signal.aborted, false);
    assert.equal(userInput.get(forkId), false);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    assert.equal(input.destroyed, false);
  } finally {
    clearTimeout(deadline);
    abort.abort();
    await done.catch(() => {});
    input.destroy();
    output.destroy();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
