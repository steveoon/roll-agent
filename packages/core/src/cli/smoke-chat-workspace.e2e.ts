import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { ScheduleStore, ThreadStore } from "@roll-agent/runtime";
import {
  cleanupSpawnedRollProcess,
  exitRollChat,
  formatSpawnedRollProcess,
  waitForSmokeCondition,
  waitForSpawnedRollExit,
  type SpawnedRollProcess,
} from "./smoke.e2e-harness.ts";
import { encodeScheduleHostContext } from "../scheduler-host/config-context.ts";
import { DatabaseSync } from "../scheduler-host/database-fixture.test.ts";

const requestSchema = z.object({
  model: z.string(),
  stream: z.boolean().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).passthrough()),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
});
const completedSchema = z.object({ status: z.literal("completed"), sessionId: z.string() });
const listedSchema = z.array(z.object({ id: z.string(), workspace: z.string().optional() }));

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roll chat workspace-")));
  const home = join(root, "home");
  const source = join(root, "selected source");
  const a = join(root, "project-a");
  const b = join(root, "project-b");
  const c = join(root, "project-c");
  for (const directory of [home, source, a, b, c, join(a, "src")]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const project of [a, b, c]) mkdirSync(join(project, ".git"));
  mkdirSync(join(home, ".agents", "skills"), { recursive: true });
  const preload = join(root, "local-only.mjs");
  const catalog = resolve(import.meta.dirname, "../../../runtime/src/engine/model-catalog.ts");
  writeFileSync(
    preload,
    `import { ModelCatalog } from ${JSON.stringify(pathToFileURL(catalog).href)};
ModelCatalog.prototype.refreshIfStale = async () => 'skipped';
const original = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  if (url.hostname !== '127.0.0.1') throw new Error('External network blocked');
  return original(input, options);
};\n`,
  );
  const requests: Array<z.infer<typeof requestSchema> & { path: string; authorization?: string }> =
    [];
  const failures: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
        requests.push({
          ...body,
          path: request.url ?? "",
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
        });
        const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
        const prompt = JSON.stringify(lastUser?.content ?? "");
        if (body.stream !== true) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              id: "sample",
              object: "chat.completion",
              created: 1,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: `sampled-${body.model}` },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
          return;
        }
        const scheduleTool = body.tools?.find((tool) =>
          tool.function.name.endsWith("schedule_create"),
        );
        const toolResult = body.messages.some((message) => message.role === "tool");
        const createSchedule = prompt.includes("CREATE_SCHEDULE") && !toolResult;
        if (createSchedule) {
          assert.ok(scheduleTool, "interactive chat must offer schedule creation");
        }
        const delta = createSchedule
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "workspace-schedule",
                  type: "function",
                  function: {
                    name: scheduleTool?.function.name,
                    arguments: JSON.stringify({
                      name: "chat-bound-schedule",
                      prompt: "scheduled-workspace-proof",
                      recurrence: { kind: "interval", every: "1h" },
                      startAt: null,
                      cwd: b,
                      rounds: 1,
                      maxRun: "1m",
                    }),
                  },
                },
              ],
            }
          : { content: `workspace-reply-${String(requests.length)}` };
        const frame = {
          id: "workspace-fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          [
            { ...frame, choices: [{ index: 0, delta, finish_reason: null }] },
            {
              ...frame,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: createSchedule ? "tool_calls" : "stop",
                },
              ],
            },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .join("") + "data: [DONE]\n\n",
        );
      } catch (error) {
        failures.push(String(error));
        response.writeHead(500);
        response.end("fixture failure");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const configPath = join(source, "roll.config.yaml");
  const config = {
    llm: {
      defaultProvider: "qwen",
      defaultModel: "qwen3.7-plus",
      providers: { qwen: { apiKey: "fixture-a", baseUrl: `http://127.0.0.1:${address.port}/a` } },
    },
    agents: { dataDir: "./agents" },
    runtime: {
      threadsDir: "./history",
      thinkingLevel: "off",
      compaction: { enabled: false },
      shell: { enabled: false },
      approval: { default: "auto" },
    },
    scheduler: { dataDir: "./ledger" },
    chat: { instructions: "off", screenMode: "inline" },
  };
  const save = (value: unknown = config) => writeFileSync(configPath, JSON.stringify(value));
  save();
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    NODE_OPTIONS: `--experimental-strip-types --experimental-sqlite --import=${pathToFileURL(preload).href}`,
    NODE_NO_WARNINGS: "1",
    NO_COLOR: "1",
    NO_PROXY: "127.0.0.1",
    TEMP: root,
    TMP: root,
    ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
    ...(process.env.WINDIR === undefined ? {} : { WINDIR: process.env.WINDIR }),
  };
  const processes: SpawnedRollProcess[] = [];
  const cli = resolve(import.meta.dirname, "index.ts");
  const startNode = (entry: string, args: string[], cwd = a): SpawnedRollProcess => {
    const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: "pipe" });
    const output = { stdout: "", stderr: "" };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output.stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      output.stderr += chunk;
    });
    child.stdin.on("error", () => {});
    const result = { child, output };
    processes.push(result);
    return result;
  };
  const chatArgs = ["chat", "--config", configPath, "--config-workspace", source];
  const startChat = (args: string[] = [], cwd = a) => startNode(cli, [...chatArgs, ...args], cwd);
  const run = async (args: string[], cwd = a) => {
    const child = startChat(args, cwd);
    child.child.stdin.end();
    const exit = await waitForSpawnedRollExit(child, "workspace CLI", 30_000);
    return { status: exit.code, ...child.output };
  };
  const wait = (child: SpawnedRollProcess, check: () => boolean, label: string) =>
    waitForSmokeCondition(
      label,
      () => {
        if (child.child.exitCode !== null || child.child.signalCode !== null) {
          throw new Error(formatSpawnedRollProcess(label, child));
        }
        return check();
      },
      () => formatSpawnedRollProcess(label, child),
      20_000,
    );
  const line = async (child: SpawnedRollProcess, input: string) => {
    const offset = child.output.stdout.length;
    child.child.stdin.write(`${input}\n`);
    await wait(
      child,
      () => child.output.stdout.slice(offset).includes("› "),
      `prompt after ${input}`,
    );
  };
  t.after(async () => {
    for (const child of processes.reverse()) {
      await cleanupSpawnedRollProcess(child, "workspace fixture");
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    source,
    a,
    b,
    c,
    config,
    configPath,
    save,
    requests,
    failures,
    startNode,
    startChat,
    run,
    wait,
    line,
    cli,
    history: join(source, "history"),
  };
}

test(
  "real CLI --last and history browsing stay in the current project even when B closes last",
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    const a = await f.run(["A-private-marker", "--json"]);
    assert.equal(a.status, 0, a.stderr);
    const aId = completedSchema.parse(JSON.parse(a.stdout)).sessionId;
    const b = await f.run(["B-private-marker", "--json"], f.b);
    assert.equal(b.status, 0, b.stderr);
    const bId = completedSchema.parse(JSON.parse(b.stdout)).sessionId;
    const before = f.requests.length;
    const resumed = await f.run(["A-followup-marker", "--last", "--json"], join(f.a, "src"));
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(completedSchema.parse(JSON.parse(resumed.stdout)).sessionId, aId);
    assert.equal(f.requests.length, before + 1);
    assert.match(JSON.stringify(f.requests.at(-1)?.messages), /A-private-marker/u);
    assert.doesNotMatch(JSON.stringify(f.requests.at(-1)?.messages), /B-private-marker/u);
    const legacy = new ThreadStore(f.history);
    const unclassified = legacy.createThread({ title: "newest unclassified" });
    legacy.close();
    const afterUnclassified = await f.run(["A-after-unclassified", "--last", "--json"]);
    assert.equal(afterUnclassified.status, 0, afterUnclassified.stderr);
    assert.equal(completedSchema.parse(JSON.parse(afterUnclassified.stdout)).sessionId, aId);
    assert.equal(f.requests.length, before + 2);
    const listed = await f.run(["--list", "--json"], join(f.a, "src"));
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(
      listedSchema.parse(JSON.parse(listed.stdout)).map((thread) => thread.id),
      [aId],
    );
    const all = await f.run(["--list", "--all-projects", "--json"]);
    assert.equal(all.status, 0, all.stderr);
    assert.deepEqual(
      new Set(listedSchema.parse(JSON.parse(all.stdout)).map((thread) => thread.id)),
      new Set([aId, bId, unclassified]),
    );
    const empty = await f.run(["should-not-run", "--last", "--json"], f.c);
    assert.equal(empty.status, 1, empty.stderr);
    assert.equal(
      f.requests.length,
      before + 2,
      "missing project must not fall back to global history",
    );
    assert.deepEqual(f.failures, []);
  },
);

test(
  "real CLI lists and views a peer-owned conversation without writing, and resumes only after release",
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const initial = await f.run(["occupied-history-marker", "--json"]);
    assert.equal(initial.status, 0, initial.stderr);
    const id = completedSchema.parse(JSON.parse(initial.stdout)).sessionId;
    const peerFile = join(f.root, "peer-owner.mts");
    const ownershipModule = resolve(import.meta.dirname, "../runtime-host/session-ownership.ts");
    const storeModule = resolve(import.meta.dirname, "../../../runtime/src/store/thread-store.ts");
    writeFileSync(
      peerFile,
      `import { ThreadStore } from ${JSON.stringify(pathToFileURL(storeModule).href)};
import { createSessionOwnershipHost } from ${JSON.stringify(pathToFileURL(ownershipModule).href)};
const store = new ThreadStore(${JSON.stringify(f.history)}, { ownership: createSessionOwnershipHost('runtime') });
const claim = store.retainThread(${JSON.stringify(id)});
process.stdout.write('PEER_OWNS_THREAD\\n');
process.stdin.once('data', () => { claim.release(); store.close(); process.stdin.destroy(); });\n`,
    );
    const peer = f.startNode(peerFile, []);
    await f.wait(peer, () => peer.output.stdout.includes("PEER_OWNS_THREAD"), "peer ownership");
    const database = join(f.history, "threads.db");
    const hash = () => createHash("sha256").update(readFileSync(database)).digest("hex");
    const digest = hash();
    const modified = statSync(database, { bigint: true }).mtimeNs;
    const listed = await f.run(["--list", "--json"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /occupied/u);
    const viewed = await f.run(["--view", id, "--json"]);
    assert.equal(viewed.status, 0, viewed.stderr);
    assert.match(viewed.stdout, /occupied-history-marker/u);
    assert.equal(hash(), digest);
    assert.equal(statSync(database, { bigint: true }).mtimeNs, modified);
    const calls = f.requests.length;
    const blocked = await f.run(["must-not-execute", "--session", id, "--json"]);
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /另一个客户端|session_occupied|两端请选择其一/u);
    assert.equal(f.requests.length, calls);
    peer.child.stdin.end("release\n");
    assert.equal((await waitForSpawnedRollExit(peer, "peer release", 15_000)).code, 0);
    const resumed = await f.run(["after-peer-release", "--session", id, "--json"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(completedSchema.parse(JSON.parse(resumed.stdout)).sessionId, id);
    assert.equal(f.requests.length, calls + 1);
    assert.deepEqual(f.failures, []);
  },
);

test(
  "real basic CLI handles model commands locally and can still send the next message",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const child = f.startChat(["--screen-mode", "inline"]);
    await f.wait(child, () => child.output.stdout.includes("› "), "basic prompt");
    await f.line(child, "/model");
    await f.line(child, "/model qwen/another-model");
    assert.equal(child.output.stderr.match(/基础模式不支持 \/model/gu)?.length, 2);
    assert.doesNotMatch(child.output.stderr, /未知 skill/u);
    assert.equal(f.requests.length, 0);
    await f.line(child, "ordinary message after model command");
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]?.model, "qwen3.7-plus");
    assert.doesNotMatch(JSON.stringify(f.requests[0]?.messages), /\/model/u);
    await exitRollChat(child, "basic model command");
    assert.deepEqual(f.failures, []);
  },
);

test(
  "basic REPL reload changes the actual endpoint/model and recovers from invalid or deleted bound source",
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const child = f.startChat(["--screen-mode", "inline"]);
    await f.wait(child, () => child.output.stdout.includes("› "), "initial REPL prompt");
    await f.line(child, "before-reload-marker");
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]?.model, "qwen3.7-plus");
    assert.match(f.requests[0]?.path ?? "", /^\/a\//u);
    const alternate = {
      ...f.config,
      llm: {
        ...f.config.llm,
        defaultModel: "qwen3.7-turbo",
        providers: {
          qwen: {
            apiKey: "fixture-b",
            baseUrl: f.config.llm.providers.qwen.baseUrl.replace("/a", "/b"),
          },
        },
      },
    };
    f.save(alternate);
    await f.line(child, "/reload");
    await f.wait(
      child,
      () =>
        child.output.stderr.includes("qwen/qwen3.7-turbo") &&
        child.output.stderr.includes("修订 1"),
      "model reload application",
    );
    await f.line(child, "after-reload-marker");
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1]?.model, "qwen3.7-turbo");
    assert.equal(f.requests[1]?.authorization, "Bearer fixture-b");
    assert.match(f.requests[1]?.path ?? "", /^\/b\//u);
    assert.match(JSON.stringify(f.requests[1]?.messages), /before-reload-marker/u);
    writeFileSync(f.configPath, "runtime: [not-valid");
    await f.line(child, "/reload");
    await f.wait(
      child,
      () => child.output.stderr.includes("配置读取或模型解析失败"),
      "invalid source refusal",
    );
    await f.line(child, "blocked-invalid-marker");
    assert.equal(f.requests.length, 2);
    unlinkSync(f.configPath);
    writeFileSync(join(f.a, "roll.config.yaml"), JSON.stringify(f.config));
    await f.line(child, "/reload");
    await f.line(child, "blocked-missing-marker");
    assert.equal(
      f.requests.length,
      2,
      "deleted bound source must not discover the project fallback",
    );
    f.save(alternate);
    await f.line(child, "/reload");
    await f.wait(
      child,
      () => child.output.stderr.includes("修订 4"),
      "repaired source application",
    );
    await f.line(child, "after-recovery-marker");
    assert.equal(f.requests.length, 3);
    assert.match(JSON.stringify(f.requests[2]?.messages), /before-reload-marker/u);
    assert.match(JSON.stringify(f.requests[2]?.messages), /after-reload-marker/u);
    assert.doesNotMatch(
      JSON.stringify(f.requests[2]?.messages),
      /blocked-(invalid|missing)-marker/u,
    );
    await exitRollChat(child, "reload REPL");
    const store = new ThreadStore(f.history, { readOnly: true });
    try {
      assert.equal(store.listThreads({ workspace: f.a }).length, 1);
      assert.match(
        JSON.stringify(store.getMessages(store.listThreads()[0]?.id ?? "")),
        /after-recovery-marker/u,
      );
    } finally {
      store.close();
    }
    assert.deepEqual(f.failures, []);
  },
);

test(
  "ordinary chat-created schedules persist the chosen config and execute it in a different task directory",
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const child = f.startChat(["--screen-mode", "inline"]);
    await f.wait(child, () => child.output.stdout.includes("› "), "schedule chat prompt");
    await f.line(child, "CREATE_SCHEDULE");
    const ledgerDir = join(f.source, "ledger");
    const store = new ScheduleStore(ledgerDir);
    try {
      const schedule = store.listSchedules()[0];
      assert.ok(schedule, formatSpawnedRollProcess("schedule creation", child));
      assert.equal(schedule.cwd, f.b);
      assert.equal(
        schedule.hostContext,
        encodeScheduleHostContext({
          version: 1,
          configPath: f.configPath,
          configWorkspace: f.source,
        }),
      );
      await exitRollChat(child, "schedule chat");
      writeFileSync(
        join(f.b, "roll.config.yaml"),
        JSON.stringify({ runtime: { threadsDir: join(f.b, "wrong-history") } }),
      );
      const db = new DatabaseSync(join(ledgerDir, "schedules.db"));
      db.prepare("UPDATE schedules SET next_run_at=? WHERE id=?").run(
        Date.now() - 1000,
        schedule.id,
      );
      db.close();
      const calls = f.requests.length;
      const daemon = f.startNode(
        f.cli,
        [
          "schedule",
          "daemon",
          "--foreground",
          "--data-dir",
          ledgerDir,
          "--max-concurrent-runs",
          "1",
        ],
        f.b,
      );
      await f.wait(
        daemon,
        () =>
          store
            .listInvocations(schedule.id)
            .some((invocation) => invocation.status === "completed"),
        "bound schedule execution",
      );
      assert.equal(f.requests.length, calls + 1);
      assert.match(f.requests.at(-1)?.path ?? "", /^\/a\//u);
      assert.match(JSON.stringify(f.requests.at(-1)?.messages), /scheduled-workspace-proof/u);
      assert.deepEqual(f.failures, []);
    } finally {
      store.close();
    }
  },
);
