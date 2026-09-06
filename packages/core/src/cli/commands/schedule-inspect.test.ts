import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ThreadStore, ScheduleStore, createIntervalTrigger } from "@roll-agent/runtime";

const run = promisify(execFile);
const cli = resolve(import.meta.dirname, "../index.ts");

function fixture(baseUrl = "http://127.0.0.1:1") {
  const root = mkdtempSync(join(tmpdir(), "roll-schedule-cli-"));
  const threadsDir = join(root, "threads");
  const ledgerDir = join(root, "scheduler");
  writeFileSync(
    join(root, "roll.config.yaml"),
    JSON.stringify({
      llm: {
        "default-provider": "deepseek",
        "default-model": "deepseek-chat",
        providers: { deepseek: { "api-key": "local-test", "base-url": baseUrl } },
      },
      agents: { "data-dir": join(root, "agents") },
      runtime: {
        "threads-dir": threadsDir,
        "thinking-level": "off",
        compaction: { enabled: false },
      },
      scheduler: { "data-dir": ledgerDir },
      chat: { instructions: "off" },
    }),
  );
  const threads = new ThreadStore(threadsDir);
  const schedules = new ScheduleStore(ledgerDir);
  const task = schedules.createSchedule(
    {
      name: "隔离检查",
      prompt: "原任务",
      cwd: "/original/task",
      trigger: createIntervalTrigger("1m"),
    },
    0,
  );
  const claim = schedules.claimDue({ workerId: "fixture", nowMs: 60_000, limit: 1 })[0];
  assert.ok(claim);
  schedules.beginInvocation(claim.invocation.id, claim.ownershipToken, 60_001);
  const source = threads.createThread({
    title: "原执行",
    model: "original-model",
    origin: {
      kind: "scheduled",
      scheduleId: task.id,
      invocationId: claim.invocation.id,
      attempt: 1,
      name: task.name,
      cwd: task.cwd,
      scheduledFor: new Date(60_000).toISOString(),
      ledgerDir,
    },
  });
  threads.appendMessages(source, [
    { role: "user", content: "原任务" },
    { role: "assistant", content: "原始执行结果" },
  ]);
  const ordinary = threads.createThread({ title: "日常对话" });
  schedules.registerThreadReference({
    invocationId: claim.invocation.id,
    expectedAttempt: 1,
    ownershipToken: claim.ownershipToken,
    threadId: source,
    threadsDir,
  });
  schedules.completeInvocation({
    id: claim.invocation.id,
    ownershipToken: claim.ownershipToken,
    status: "completed",
    nowMs: 60_010,
    threadId: source,
    outputExcerpt: "原始执行结果",
  });
  threads.close();
  schedules.close();
  const invoke = (...args: string[]) =>
    run(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", cli, ...args], {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  return {
    root,
    threadsDir,
    source,
    ordinary,
    taskId: task.id,
    invocation: claim.invocation.id,
    invoke,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("real CLI inspect is read-only and ordinary --list excludes scheduled records", async () => {
  const f = fixture();
  try {
    const before = statSync(join(f.threadsDir, "threads.db")).mtimeMs;
    const { stdout } = await f.invoke("schedule", "inspect", f.invocation, "--json");
    const detail = JSON.parse(stdout) as { sessionId: string; transcript: string[] };
    assert.equal(detail.sessionId, f.source);
    assert.match(detail.transcript.join("\n"), /原始执行结果/u);
    assert.equal(statSync(join(f.threadsDir, "threads.db")).mtimeMs, before);
    const listed = await f.invoke("chat", "--list", "--json");
    const rows = JSON.parse(listed.stdout) as Array<{ id: string }>;
    assert.deepEqual(
      rows.map((row) => row.id),
      [f.ordinary],
    );
  } finally {
    f.close();
  }
});

test("real CLI validates --from-run conflicts and attempt before model execution", async () => {
  const f = fixture();
  try {
    for (const args of [
      ["--from-run", f.invocation, "--last"],
      ["--from-run", f.invocation, "--attempt", "2x"],
      ["--attempt", "1"],
    ]) {
      await assert.rejects(f.invoke("chat", ...args), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /不能同时使用|必须是正整数|只能与/u);
        return true;
      });
    }
    const store = new ThreadStore(f.threadsDir, { readOnly: true });
    assert.equal(store.listThreads().length, 2);
    store.close();
  } finally {
    f.close();
  }
});

test("real CLI --from-run and --session fork source using current model and directory", async () => {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    requests.push(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = {
      id: "chatcmpl-local",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-chat",
    };
    response.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "新的讨论结果" }, finish_reason: null }] })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const f = fixture(`http://127.0.0.1:${String(address.port)}/v1`);
  try {
    for (const selector of [
      ["--from-run", f.invocation],
      ["--session", f.source],
    ]) {
      const result = await f.invoke("chat", "继续分析这个结果", ...selector, "--json");
      const output = JSON.parse(result.stdout) as {
        status: string;
        sessionId: string;
        output: string;
      };
      assert.equal(output.status, "completed", result.stderr);
      assert.notEqual(output.sessionId, f.source);
      assert.match(output.output, /新的讨论结果/u);
      const store = new ThreadStore(f.threadsDir, { readOnly: true });
      const fork = store.getThread(output.sessionId);
      assert.equal(fork?.origin.kind, "interactive");
      assert.equal(fork?.derivedFrom?.threadId, f.source);
      assert.equal(fork?.model, "deepseek-chat");
      assert.equal(store.countMessages(f.source), 2);
      assert.deepEqual(
        store
          .getMessages(output.sessionId)
          .filter((message) => message.role === "user")
          .map((message) => message.content),
        ["原任务", "继续分析这个结果"],
      );
      store.close();
    }
    assert.equal(requests.length, 2);
    for (const body of requests) {
      assert.match(body, /原始执行结果/u);
      assert.match(body, /继续分析这个结果/u);
      assert.ok(body.includes(f.root));
      assert.match(body, /original\/task/u);
    }
  } finally {
    f.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("inspect JSON keeps machine status/mode and explicit missing-history semantics", async () => {
  const f = fixture();
  const ledger = new ScheduleStore(join(f.root, "scheduler"));
  try {
    const failedTask = ledger.createSchedule(
      { name: "失败任务", prompt: "检查", cwd: f.root, trigger: createIntervalTrigger("1m") },
      0,
    );
    const failed = ledger.claimDue({ workerId: "fixture", nowMs: 60_000, limit: 1 })[0];
    assert.ok(failed);
    assert.equal(failed.schedule.id, failedTask.id);
    ledger.beginInvocation(failed.invocation.id, failed.ownershipToken, 60_001);
    ledger.failInvocation(
      failed.invocation.id,
      failed.ownershipToken,
      "provider unavailable",
      60_002,
      { terminal: true },
    );
    const inspected = JSON.parse(
      (await f.invoke("schedule", "inspect", failed.invocation.id, "--json")).stdout,
    ) as { status: unknown; mode: unknown; statusUnavailableReason?: unknown };
    const runs = JSON.parse(
      (await f.invoke("schedule", "runs", failedTask.id, "--json")).stdout,
    ) as Array<{ status: unknown }>;
    assert.equal(inspected.status, "failed");
    assert.equal(inspected.status, runs[0]?.status);
    assert.equal(inspected.mode, "scheduled");
    assert.equal(inspected.statusUnavailableReason, undefined);
    ledger.removeSchedule(f.taskId);
    const historical = JSON.parse(
      (await f.invoke("schedule", "inspect", f.invocation, "--json")).stdout,
    ) as { status: unknown; mode: unknown; statusUnavailableReason: unknown };
    assert.equal(historical.status, null);
    assert.equal(historical.statusUnavailableReason, "ledger_missing");
    assert.equal(historical.mode, "scheduled");
  } finally {
    ledger.close();
    f.close();
  }
});
