import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { RollNodeClient } from "@roll-agent/client-node";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test, type TestContext } from "node:test";
import { z } from "zod";
import {
  ScheduleStore,
  SessionClaims,
  ThreadStore,
  inspectThreadLibrary,
} from "@roll-agent/runtime";
import { createSessionOwnershipHost } from "../runtime-host/session-ownership.ts";
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

const parsedConcurrency = Number.parseInt(process.env.ROLL_E2E_SUITE_CONCURRENCY ?? "", 10);
const suiteConcurrency =
  Number.isSafeInteger(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 2;

describe("chat workspace real execution", { concurrency: suiteConcurrency }, () => {
  test(
    "real stdio thread model isolation includes MCP Sampling, reload, reopen and CLI continuation",
    { timeout: 90_000 },
    async (t) => {
      const f = await fixture(t);
      const configured = {
        ...f.config,
        llm: {
          ...f.config.llm,
          providers: {
            qwen: {
              ...f.config.llm.providers.qwen,
              models: ["qwen3.7-plus", "qwen3.7-flash", "qwen3.8-flash"],
            },
          },
        },
      };
      f.save(configured);
      const initialBytes = readFileSync(f.configPath);
      const agent = join(f.root, "sampling-agent");
      mkdirSync(agent);
      const require = createRequire(import.meta.url);
      const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(require.resolve(name)).href);
      const entry = join(agent, "server.mjs");
      writeFileSync(
        entry,
        `
const {Server} = await import(${moduleUrl("@modelcontextprotocol/sdk/server/index.js")});
const {StdioServerTransport} = await import(${moduleUrl("@modelcontextprotocol/sdk/server/stdio.js")});
const {ListToolsRequestSchema,CallToolRequestSchema} = await import(${moduleUrl("@modelcontextprotocol/sdk/types.js")});
const server=new Server({name:"sampling-fixture",version:"1"},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:"sample",inputSchema:{type:"object",properties:{},additionalProperties:false}}]}));
server.setRequestHandler(CallToolRequestSchema,async()=>{
 const result=await server.createMessage({messages:[{role:"user",content:{type:"text",text:"SAMPLING_EVIDENCE"}}],maxTokens:64});
 return {content:[{type:"text",text:JSON.stringify(result)}]};
});
await server.connect(new StdioServerTransport());
`,
      );
      const agents = join(f.source, "agents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(
        join(agents, "agents.json"),
        JSON.stringify({
          agents: [
            {
              skill: {
                name: "sampling-fixture",
                description: "Local sampling evidence",
                metadata: {},
              },
              transport: { type: "stdio", command: process.execPath, args: [entry] },
              runtime: { ownership: "on-demand" },
              installPath: agent,
              registeredAt: new Date(0).toISOString(),
              status: "idle",
              source: { type: "local-path", path: agent },
            },
          ],
        }),
      );
      const connectRuntime = async () => {
        const child = f.startNode(f.cli, [
          "runtime",
          "serve",
          "--stdio",
          "--config",
          f.configPath,
          "--config-workspace",
          f.source,
        ]);
        const client = await RollNodeClient.connect({
          transport: {
            stdin: child.child.stdin,
            stdout: child.child.stdout,
            onExit: (listener) => {
              child.child.once("exit", listener);
            },
            close: () => {
              child.child.stdin.end();
            },
          },
        });
        return { child, client };
      };
      const { child, client } = await connectRuntime();
      const completed = new Set<string>();
      const off = client.onEvent((event) => {
        if (event.turnId && event.event.type === "turn.completed") completed.add(event.turnId);
      });
      const turn = async (threadId: string, text: string) => {
        const turnId = randomUUID();
        await client.request("turn.start", {
          requestId: randomUUID(),
          threadId,
          turnId,
          input: { text },
        });
        await f.wait(child, () => completed.has(turnId), `completed ${text}`);
      };
      let a = "";
      try {
        const catalog = await client.listModels();
        assert.equal(catalog.items.length, 3);
        assert.doesNotMatch(JSON.stringify(catalog), /fixture-a|baseUrl|apiKey/u);
        a = (await client.request("thread.create", { requestId: randomUUID(), title: "A" })).thread
          .id;
        const b = (await client.request("thread.create", { requestId: randomUUID(), title: "B" }))
          .thread.id;
        const params = {
          requestId: randomUUID(),
          threadId: a,
          expectedRevision: (await client.getThreadModel({ threadId: a })).revision,
          configRevision: catalog.configRevision,
          selection: { mode: "explicit", provider: "qwen", model: "qwen3.7-flash" } as const,
        };
        const database = new DatabaseSync(join(f.history, "threads.db"));
        const stored = () => database.prepare("SELECT * FROM threads ORDER BY id").all();
        const beforeSelection = stored();
        const selected = await client.setThreadModel(params);
        assert.deepEqual(
          stored(),
          beforeSelection,
          "model selection must not write thread metadata",
        );
        assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 12);
        assert.equal(
          database
            .prepare("PRAGMA table_info(threads)")
            .all()
            .some((row) => String(row.name).startsWith("model_selection")),
          false,
        );
        database.close();
        assert.equal(selected.status, "applied");
        assert.deepEqual(await client.setThreadModel(params), selected);
        await assert.rejects(client.setThreadModel({ ...params, selection: { mode: "default" } }));
        await assert.rejects(
          client.setThreadModel({ ...params, requestId: randomUUID(), configRevision: "stale" }),
        );
        await turn(a, "CALL_SAMPLING_A");
        await turn(b, "CALL_SAMPLING_B");
        const sampling = f.requests.filter(
          (request) =>
            JSON.stringify(request.messages).includes("SAMPLING_EVIDENCE") &&
            request.stream !== true,
        );
        assert.deepEqual(
          sampling.map((request) => request.model),
          ["qwen3.7-flash", "qwen3.7-plus"],
        );
        assert.deepEqual(readFileSync(f.configPath), initialBytes);
        await client.request("thread.detach", { requestId: randomUUID(), threadId: a });
        await assert.rejects(client.getThreadModel({ threadId: a }), /尚未打开|关闭/u);
        await assert.rejects(
          client.setThreadModel({ ...params, requestId: randomUUID() }),
          /尚未打开|关闭/u,
        );
        await assert.rejects(client.getThreadModel({ threadId: a }), /尚未打开|关闭/u);
        assert.equal(
          (await client.browseThreads()).items.find((item) => item.thread.id === a)?.occupancy
            .status,
          "available",
        );
        const peer = await f.run(["CLI after rejected late selection", "--session", a, "--json"]);
        assert.equal(peer.status, 0, peer.stderr);
        await client.request("thread.open", { threadId: a });
        assert.equal((await client.getThreadModel({ threadId: a })).active?.model, "qwen3.7-plus");
        await assert.rejects(client.setThreadModel({ ...params, requestId: randomUUID() }));
        // A third-party app can deliberately restore its own saved choice after opening.
        await client.setThreadModel({
          ...params,
          requestId: randomUUID(),
          expectedRevision: (await client.getThreadModel({ threadId: a })).revision,
        });
        f.save({ ...configured, llm: { ...configured.llm, defaultModel: "qwen3.8-flash" } });
        await client.request("runtime.modelConfig.reload", { requestId: randomUUID() });
        for (let i = 0; i < 100; i++) {
          if ((await client.request("runtime.modelConfig.get", {})).status !== "pending") break;
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.equal((await client.getThreadModel({ threadId: a })).active?.model, "qwen3.7-flash");
        assert.equal((await client.getThreadModel({ threadId: b })).active?.model, "qwen3.8-flash");
        await turn(a, "after default reload");
        const latest = await client.listModels();
        const status = await client.getThreadModel({ threadId: a });
        assert.equal(
          (
            await client.setThreadModel({
              requestId: randomUUID(),
              threadId: a,
              expectedRevision: status.revision,
              configRevision: latest.configRevision,
              selection: { mode: "default" },
            })
          ).active?.model,
          "qwen3.8-flash",
        );
        await client.setThreadModel({
          requestId: randomUUID(),
          threadId: a,
          expectedRevision: (await client.getThreadModel({ threadId: a })).revision,
          configRevision: latest.configRevision,
          selection: params.selection,
        });
      } finally {
        off();
        await client.shutdown();
      }
      const restarted = await connectRuntime();
      try {
        await restarted.client.request("thread.open", { threadId: a });
        const fresh = await restarted.client.getThreadModel({ threadId: a });
        assert.deepEqual(fresh.selection, { mode: "default" });
        assert.equal(fresh.active?.model, "qwen3.8-flash");
      } finally {
        await restarted.client.shutdown();
      }
      const continued = await f.run(["CLI continuation", "--session", a, "--json"]);
      assert.equal(continued.status, 0, continued.stderr);
      assert.equal(f.requests.at(-1)?.model, "qwen3.8-flash");
      assert.match(JSON.stringify(f.requests.at(-1)?.messages), /CALL_SAMPLING_A/u);
      const temporary = await f.run([
        "CLI temporary override",
        "--session",
        a,
        "--model",
        "qwen3.7-flash",
        "--json",
      ]);
      assert.equal(temporary.status, 0, temporary.stderr);
      assert.equal(f.requests.at(-1)?.model, "qwen3.7-flash");
      const freshCli = await f.run(["CLI default again", "--session", a, "--json"]);
      assert.equal(freshCli.status, 0, freshCli.stderr);
      assert.equal(f.requests.at(-1)?.model, "qwen3.8-flash");
      assert.deepEqual(f.failures, []);
    },
  );

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
    const requests: Array<
      z.infer<typeof requestSchema> & { path: string; authorization?: string }
    > = [];
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
          const sampleTool = body.tools?.find((tool) => tool.function.name.endsWith("sample"));
          const callSampling = prompt.includes("CALL_SAMPLING") && !toolResult;
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
            : callSampling
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: "sampling-proof",
                      type: "function",
                      function: {
                        name: sampleTool?.function.name,
                        arguments: "{}",
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
                    finish_reason: createSchedule || callSampling ? "tool_calls" : "stop",
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
    "real CLI automatically upgrades history while an idle scheduler keeps running",
    { timeout: 60_000 },
    async (t) => {
      const f = await fixture(t);
      const store = new ThreadStore(f.history);
      const id = store.createThread({ title: "before upgrade" });
      store.appendMessages(id, [{ role: "user", content: "keep this history" }]);
      store.close();
      const path = join(f.history, "threads.db");
      const old = new DatabaseSync(path);
      old.exec("ALTER TABLE threads DROP COLUMN workspace; PRAGMA user_version = 11");
      old.close();
      const original = readFileSync(path);
      const listed = await f.run(["--list", "--all-projects", "--json"]);
      assert.equal(listed.status, 0, listed.stderr);
      assert.deepEqual(readFileSync(path), original);

      const ledger = join(f.source, "ledger");
      const daemon = f.startNode(f.cli, [
        "schedule",
        "daemon",
        "--foreground",
        "--data-dir",
        ledger,
        "--max-concurrent-runs",
        "1",
      ]);
      await f.wait(daemon, () => existsSync(join(ledger, "daemon.json")), "idle scheduler startup");
      const daemonRecord = readFileSync(join(ledger, "daemon.json"));
      const claims = new SessionClaims(path, createSessionOwnershipHost("desktop"));
      const hold = claims.acquire(id);
      try {
        const blocked = await f.run(["do not run", "--session", id, "--json"]);
        assert.notEqual(blocked.status, 0);
        assert.match(blocked.stderr, /另一个客户端中使用/u);
        assert.deepEqual(readFileSync(path), original);
        assert.equal(f.requests.length, 0);
        hold.release();
        const resumed = await f.run(["continue after upgrade", "--session", id, "--json"]);
        assert.equal(resumed.status, 0, resumed.stderr);
        assert.equal(completedSchema.parse(JSON.parse(resumed.stdout)).sessionId, id);
        assert.match(resumed.stderr, /会话库已自动升级/u);
        assert.equal(inspectThreadLibrary(f.history).status, "current");
        const backups = readdirSync(f.history).filter((name) => name.includes(".backup-"));
        assert.equal(backups.length, 1);
        const history = new ThreadStore(f.history, { readOnly: true });
        try {
          assert.equal(history.getThread(id)?.workspace, undefined);
          assert.equal(history.readSnapshot(id).messages[0]?.content, "keep this history");
        } finally {
          history.close();
        }
        const repeated = await f.run(["continue again", "--session", id, "--json"]);
        assert.equal(repeated.status, 0, repeated.stderr);
        assert.doesNotMatch(repeated.stderr, /会话库已自动升级/u);
        assert.equal(readdirSync(f.history).filter((name) => name.includes(".backup-")).length, 1);
        assert.equal(daemon.child.exitCode, null);
        assert.equal(daemon.child.signalCode, null);
        assert.deepEqual(readFileSync(join(ledger, "daemon.json")), daemonRecord);
      } finally {
        hold.release();
        claims.close();
      }
    },
  );

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
      const storeModule = resolve(
        import.meta.dirname,
        "../../../runtime/src/store/thread-store.ts",
      );
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
      await f.wait(
        child,
        () => child.output.stderr.match(/基础模式不支持 \/model/gu)?.length === 2,
        "basic model command warnings flushed",
      );
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
    "real resume groups old history and assigns it only after acquiring ownership",
    { timeout: 90_000 },
    async (t) => {
      const f = await fixture(t);
      const peer = new ThreadStore(f.history, { ownership: createSessionOwnershipHost("runtime") });
      const old = peer.createThread({ title: "OLD_HISTORY_TO_ASSIGN" });
      peer.appendMessages(old, [{ role: "user", content: "old-unclassified-context-proof" }]);
      peer.createThread({ title: "OTHER_PROJECT_MUST_BE_ABSENT", workspace: f.b });
      const claim = peer.retainThread(old);
      try {
        const child = f.startChat(["--screen-mode", "inline"]);
        await f.wait(child, () => child.output.stdout.includes("› "), "initial project prompt");
        const chooseAssignment = async () => {
          const start = child.output.stdout.length;
          child.child.stdin.write("/resume\n");
          await f.wait(
            child,
            () => child.output.stdout.slice(start).includes("OLD_HISTORY_TO_ASSIGN"),
            "grouped history",
          );
          const history = child.output.stdout.slice(start);
          assert.match(history, /本项目下的对话/u);
          assert.match(history, /旧会话/u);
          assert.match(history, /当前打开/u);
          assert.doesNotMatch(history, /OTHER_PROJECT_MUST_BE_ABSENT/u);
          const historyMoveStart = child.output.stdout.length;
          child.child.stdin.write("\x1b[B");
          await f.wait(
            child,
            () => child.output.stdout.length > historyMoveStart,
            "choose old conversation",
          );
          const actionStart = child.output.stdout.length;
          child.child.stdin.write("\r");
          await f.wait(
            child,
            () => child.output.stdout.slice(actionStart).includes("归入本项目并继续"),
            "explicit assignment action",
          );
          const moveStart = child.output.stdout.length;
          child.child.stdin.write("\x1b[B");
          await f.wait(child, () => child.output.stdout.length > moveStart, "choose assignment");
          const promptStart = child.output.stdout.length;
          child.child.stdin.write("\r");
          await f.wait(
            child,
            () => child.output.stdout.slice(promptStart).includes("› "),
            "prompt after assignment menu",
          );
        };
        await chooseAssignment();
        await f.wait(
          child,
          () => child.output.stderr.includes("切换失败"),
          "occupied assignment refusal",
        );
        assert.equal(peer.getThread(old)?.workspace, undefined);
        assert.equal(f.requests.length, 0);
        claim?.release();
        const currentId = peer.listThreads({ workspace: f.a })[0]?.id;
        assert.ok(currentId);
        const database = new DatabaseSync(join(f.history, "threads.db"));
        try {
          database.exec(
            "CREATE TRIGGER deny_fixture_assignment BEFORE UPDATE OF workspace ON threads BEGIN SELECT RAISE(ABORT, 'fixture assignment rejected'); END",
          );
          const failureStart = child.output.stderr.length;
          await chooseAssignment();
          await f.wait(
            child,
            () => child.output.stderr.slice(failureStart).includes("fixture assignment rejected"),
            "assignment write failure",
          );
          assert.equal(peer.getThread(old)?.workspace, undefined);
          assert.equal(
            peer.inspectSessionOccupancy(old).status,
            "available",
            "failed assignment must release the newly opened target",
          );
          assert.equal(
            peer.inspectSessionOccupancy(currentId).status,
            "occupied",
            "failed assignment must preserve the current session claim",
          );
          database.exec("DROP TRIGGER deny_fixture_assignment");
        } finally {
          database.close();
        }
        await chooseAssignment();
        await f.wait(
          child,
          () => child.output.stderr.includes(`已切换到会话 ${old}`),
          "assigned history continuation",
        );
        assert.equal(peer.getThread(old)?.workspace, f.a);
        await f.line(child, "message-after-explicit-project-assignment");
        assert.equal(f.requests.length, 1);
        assert.match(JSON.stringify(f.requests[0]?.messages), /old-unclassified-context-proof/u);
        await exitRollChat(child, "assigned history");
        const current = await f.run(["--list", "--json"]);
        assert.equal(current.status, 0, current.stderr);
        assert.deepEqual(
          listedSchema.parse(JSON.parse(current.stdout)).map((thread) => thread.id),
          [old],
        );
        const resumed = await f.run(["verify-project-last", "--last", "--json"]);
        assert.equal(resumed.status, 0, resumed.stderr);
        assert.equal(completedSchema.parse(JSON.parse(resumed.stdout)).sessionId, old);
        assert.deepEqual(f.failures, []);
      } finally {
        claim?.release();
        peer.close();
      }
    },
  );

  test(
    "real CLI retains its open old conversation when assignment fails and assigns it in place",
    { timeout: 90_000 },
    async (t) => {
      const f = await fixture(t);
      const peer = new ThreadStore(f.history, { ownership: createSessionOwnershipHost("runtime") });
      const id = peer.createThread({ title: "OPEN_OLD_CONVERSATION" });
      peer.appendMessages(id, [{ role: "user", content: "open-old-context-proof" }]);
      const child = f.startChat(["--session", id, "--screen-mode", "inline"]);
      const database = new DatabaseSync(join(f.history, "threads.db"));
      try {
        await f.wait(
          child,
          () => child.output.stdout.includes("› "),
          "open old conversation prompt",
        );
        const chooseCurrentAssignment = async () => {
          const start = child.output.stdout.length;
          child.child.stdin.write("/resume\n");
          await f.wait(
            child,
            () => child.output.stdout.slice(start).includes("[当前打开] OPEN_OLD_CONVERSATION"),
            "visible current old conversation",
          );
          const actions = child.output.stdout.length;
          child.child.stdin.write("\r");
          await f.wait(
            child,
            () => child.output.stdout.slice(actions).includes("归入本项目"),
            "current assignment menu",
          );
          const movement = child.output.stdout.length;
          child.child.stdin.write("\x1b[B");
          await f.wait(
            child,
            () => child.output.stdout.length > movement,
            "select in-place assignment",
          );
          const promptStart = child.output.stdout.length;
          child.child.stdin.write("\r");
          await f.wait(
            child,
            () => child.output.stdout.slice(promptStart).includes("› "),
            "prompt after current assignment menu",
          );
        };
        database.exec(
          "CREATE TRIGGER deny_current_assignment BEFORE UPDATE OF workspace ON threads BEGIN SELECT RAISE(ABORT, 'current assignment rejected'); END",
        );
        await chooseCurrentAssignment();
        await f.wait(
          child,
          () => child.output.stderr.includes("current assignment rejected"),
          "current assignment failure",
        );
        assert.equal(peer.inspectSessionOccupancy(id).status, "occupied");
        assert.equal(peer.getThread(id)?.workspace, undefined);
        database.exec("DROP TRIGGER deny_current_assignment");
        await f.line(child, "message-after-current-assignment-failure");
        assert.equal(f.requests.length, 1);
        assert.match(JSON.stringify(f.requests[0]?.messages), /open-old-context-proof/u);
        await chooseCurrentAssignment();
        await f.wait(
          child,
          () => child.output.stderr.includes("已将当前会话归入本项目"),
          "in-place assignment success",
        );
        assert.equal(peer.getThread(id)?.workspace, f.a);
        assert.equal(peer.inspectSessionOccupancy(id).status, "occupied");
        await f.line(child, "message-after-current-assignment-success");
        assert.equal(f.requests.length, 2);
        assert.match(
          JSON.stringify(f.requests[1]?.messages),
          /message-after-current-assignment-failure/u,
        );
        await exitRollChat(child, "current conversation assignment");
        assert.equal(peer.inspectSessionOccupancy(id).status, "available");
        assert.equal(peer.listThreads().length, 1);
        assert.deepEqual(f.failures, []);
      } finally {
        database.close();
        peer.close();
      }
    },
  );

  test(
    "ordinary CLI keeps startup config after file edits and applies changes on restart with history",
    { timeout: 90_000 },
    async (t) => {
      const f = await fixture(t);
      const child = f.startChat(["--screen-mode", "inline"]);
      await f.wait(child, () => child.output.stdout.includes("› "), "initial REPL prompt");
      await f.line(child, "before-config-edit-marker");
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
      await f.line(child, "/status");
      await f.wait(
        child,
        () => /有效模型：qwen\/qwen3\.7-plus/u.test(child.output.stderr),
        "initial status stderr flushed",
      );
      await f.line(child, "/reload");
      await f.wait(
        child,
        () => /未知命令 \/reload/u.test(child.output.stderr),
        "unknown reload warning flushed",
      );
      await f.line(child, "after-config-edit-marker");
      writeFileSync(f.configPath, "runtime: [not-valid");
      await f.line(child, "after-invalid-config-marker");
      unlinkSync(f.configPath);
      await f.line(child, "after-deleted-config-marker");
      assert.equal(f.requests.length, 4, "slash commands must not call the model");
      for (const request of f.requests) {
        assert.equal(request.model, "qwen3.7-plus");
        assert.equal(request.authorization, "Bearer fixture-a");
        assert.match(request.path, /^\/a\//u);
      }
      assert.match(JSON.stringify(f.requests[3]?.messages), /before-config-edit-marker/u);
      assert.doesNotMatch(JSON.stringify(f.requests[3]?.messages), /\/reload/u);
      await exitRollChat(child, "startup config chat");
      f.save(alternate);
      const restarted = f.startChat(["--screen-mode", "inline", "--last"]);
      await f.wait(restarted, () => restarted.output.stdout.includes("› "), "resumed REPL prompt");
      await f.line(restarted, "/status");
      await f.wait(
        restarted,
        () => /有效模型：qwen\/qwen3\.7-turbo/u.test(restarted.output.stderr),
        "restarted status stderr flushed",
      );
      await f.line(restarted, "after-restart-marker");
      assert.equal(f.requests.length, 5);
      assert.equal(f.requests[4]?.model, "qwen3.7-turbo");
      assert.equal(f.requests[4]?.authorization, "Bearer fixture-b");
      assert.match(f.requests[4]?.path ?? "", /^\/b\//u);
      assert.match(JSON.stringify(f.requests[4]?.messages), /after-deleted-config-marker/u);
      await exitRollChat(restarted, "resumed updated-config chat");
      const store = new ThreadStore(f.history, { readOnly: true });
      try {
        assert.equal(store.listThreads({ workspace: f.a }).length, 1);
        assert.match(
          JSON.stringify(store.getMessages(store.listThreads()[0]?.id ?? "")),
          /after-restart-marker/u,
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

  test(
    "legacy chat server retains third-party model config reload and executes the updated model",
    { timeout: 60_000 },
    async (t) => {
      const f = await fixture(t);
      const child = f.startChat(["--server"]);
      const client = await RollNodeClient.connect({
        transport: {
          stdin: child.child.stdin,
          stdout: child.child.stdout,
          onExit: (listener) => child.child.once("exit", listener),
          close: () => child.child.stdin.end(),
        },
      });
      try {
        assert.equal(
          (await client.request("runtime.modelConfig.get", {})).active.model,
          "qwen3.7-plus",
        );
        f.save({
          ...f.config,
          llm: { ...f.config.llm, defaultModel: "qwen3.7-turbo" },
        });
        await client.request("runtime.modelConfig.reload", { requestId: randomUUID() });
        let status = await client.request("runtime.modelConfig.get", {});
        for (let attempt = 0; status.status === "pending" && attempt < 100; attempt++) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          status = await client.request("runtime.modelConfig.get", {});
        }
        assert.equal(status.status, "applied");
        assert.equal(status.active.model, "qwen3.7-turbo");
        const { thread } = await client.request("thread.create", { requestId: randomUUID() });
        let completed = false;
        const off = client.onEvent((event) => {
          if (event.event.type === "turn.completed") completed = true;
        });
        try {
          await client.request("turn.start", {
            requestId: randomUUID(),
            threadId: thread.id,
            turnId: randomUUID(),
            input: { text: "legacy-server-reload-marker" },
          });
          await f.wait(child, () => completed, "legacy server model execution");
        } finally {
          off();
        }
        assert.equal(f.requests.length, 1);
        assert.equal(f.requests[0]?.model, "qwen3.7-turbo");
        assert.match(JSON.stringify(f.requests[0]?.messages), /legacy-server-reload-marker/u);
        assert.deepEqual(f.failures, []);
      } finally {
        client.close();
      }
      assert.equal((await waitForSpawnedRollExit(child, "legacy server reload")).code, 0);
    },
  );
});
