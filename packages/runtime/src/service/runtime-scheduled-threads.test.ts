import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requestIdSchema, threadIdSchema, turnIdSchema } from "@roll-agent/protocol";
import { ThreadStore } from "../store/thread-store.ts";
import { scheduledThreadOriginSchema } from "../store/thread-origin.ts";
import { createToolExecutionRecord } from "../tool-bridge/tool-execution-record.ts";
import { successfulToolResult } from "../tool-bridge/normalize-result.ts";
import { RuntimeService } from "./runtime-service.ts";

test("Runtime filters scheduled records before pagination and opens originals without creating engine sessions or recovering tool gaps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-runtime-schedules-"));
  const store = new ThreadStore(dir);
  let resumes = 0;
  const runtime = new RuntimeService(
    {
      async createSession() {
        throw new Error("unexpected session creation");
      },
      async resumeSession() {
        resumes += 1;
        throw new Error("unexpected session resume");
      },
    },
    store,
  );
  try {
    const first = store.createThread({ title: "first" });
    const scheduled = [];
    for (let index = 0; index < 45; index += 1) {
      scheduled.push(
        store.createThread({
          origin: scheduledThreadOriginSchema.parse({
            kind: "scheduled",
            scheduleId: "schedule-a",
            invocationId: `run-${String(index)}`,
            attempt: 1,
            name: "Daily review",
            cwd: "/historical",
            ledgerDir: "/ledger",
            scheduledFor: new Date().toISOString(),
          }),
        }),
      );
    }
    const second = store.createThread({ title: "second" });
    const page1 = runtime.listThreads({ limit: 1 });
    assert.equal(page1.items[0]?.id, second);
    assert.equal(page1.nextCursor, "1");
    const page2 = runtime.listThreads({ limit: 1, cursor: "1" });
    assert.equal(page2.items[0]?.id, first);
    assert.equal(page2.nextCursor, null);
    const id = threadIdSchema.parse(scheduled[0]);
    store.appendMessages(id, [{ role: "user", content: "task" }]);
    store.appendToolExecution(
      id,
      createToolExecutionRecord({
        id: randomUUID(),
        toolCallId: "uncovered",
        agentName: "demo",
        toolName: "lookup",
        input: {},
        result: successfulToolResult("result"),
      }),
    );
    const before = store.readSnapshot(id);
    const result = await runtime.openThread({ threadId: id });
    assert.equal(result.thread.id, id);
    assert.equal(resumes, 0);
    assert.equal(store.listUncoveredToolExecutions(id).length, 1);
    assert.deepEqual(store.getThread(id), before.thread);
    assert.deepEqual(store.getMessages(id), before.messages);
    assert.equal(store.countRuntimeEvents(id), 0);
    await assert.rejects(
      runtime.startTurn({
        threadId: id,
        requestId: requestIdSchema.parse(randomUUID()),
        turnId: turnIdSchema.parse(randomUUID()),
        input: { text: "continue" },
      }),
      /只读记录/u,
    );
    assert.equal(resumes, 0);
    assert.equal(JSON.stringify(result).includes("/ledger"), false);
    assert.equal(JSON.stringify(result).includes("/historical"), false);
  } finally {
    await runtime.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
