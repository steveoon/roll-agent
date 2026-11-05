import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { RollNodeClient } from "@roll-agent/client-node";
import { ScheduleStore, createIntervalTrigger } from "@roll-agent/runtime";
import { createScheduleToolBinding } from "../scheduler-host/schedule-tool-binding.ts";
import { encodeScheduleHostContext } from "../scheduler-host/config-context.ts";
import { computeAuthorityDigest } from "../scheduler-host/authority.ts";
import { loadRuntimeConfig } from "../config/runtime-context.ts";
import { loadConfig } from "../config/loader.ts";
import { scheduleHostContextSchema } from "@roll-agent/runtime/host-contracts";
import { DatabaseSync } from "../scheduler-host/database-fixture.test.ts";

const requestSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).passthrough()),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
});
async function until(check: () => boolean, label: string, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

test(
  "real stdio and restarted daemon preserve selected config, task cwd, Agent and library",
  { timeout: 90000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "roll context live-"));
    const source = join(root, "配置 source");
    const task = join(root, "daily task");
    const home = join(root, "home");
    for (const p of [source, task, home]) mkdirSync(p);
    const cli = resolve(import.meta.dirname, "index.ts");
    const preload = join(root, "preload.mjs");
    const catalog = resolve(import.meta.dirname, "../../../runtime/src/engine/model-catalog.ts");
    writeFileSync(
      preload,
      `import {ModelCatalog} from ${JSON.stringify(pathToFileURL(catalog).href)};\nModelCatalog.prototype.refreshIfStale=async()=>"skipped";\nconst original=globalThis.fetch;globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input:input.url);if(url.hostname!=='127.0.0.1')throw new Error('External network blocked');return original(input,options);};\n`,
    );
    const agents = join(source, "agents");
    const agent = join(source, "fixture-agent");
    mkdirSync(agents);
    mkdirSync(agent);
    writeFileSync(
      join(agent, "server.mjs"),
      `import {createInterface} from 'node:readline';
const reader=createInterface({input:process.stdin});reader.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'context-fixture',version:'1'}};else if(m.method==='tools/list')result={tools:[{name:'echo',description:'Fixture browser environment',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}}]};else if(m.method==='tools/call')result={content:[{type:'text',text:'context-agent-proof '+process.env.BROWSER_INSTANCES_JSON}]};else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});\n`,
    );
    writeFileSync(
      join(agents, "agents.json"),
      JSON.stringify({
        schemaVersion: 2,
        agents: [
          {
            skill: { name: "browser-use-agent", description: "fixture", metadata: {} },
            transport: {
              type: "stdio",
              command: process.execPath,
              args: [join(agent, "server.mjs")],
            },
            runtime: { ownership: "on-demand" },
            installPath: agent,
            registeredAt: "2026-11-05T00:00:00Z",
            status: "idle",
            source: { type: "local-path", path: agent },
          },
        ],
      }),
    );
    let modelCalls = 0;
    let proofs = 0;
    const failures: string[] = [];
    const provider = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (c: Buffer) => chunks.push(c));
      request.on("end", () => {
        try {
          const body = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
          modelCalls++;
          const outputs = body.messages
            .filter((m) => m.role === "tool")
            .map((m) => String(m.content))
            .join("\n");
          let delta: unknown, finish: string;
          if (outputs) {
            assert.ok(outputs.includes("context-agent-proof"));
            assert.ok(
              outputs.includes(task) || outputs.includes(JSON.stringify(task).slice(1, -1)),
              outputs,
            );
            const normalizedOutput = outputs.replaceAll("\\\\", "\\").replaceAll("\\\\", "\\");
            assert.ok(normalizedOutput.includes(join(source, "bin", "chrome")), outputs);
            proofs++;
            delta = { content: "context-execution-complete" };
            finish = "stop";
          } else {
            const shell = body.tools?.find(
              (t) => t.function.name === "roll__bash" || t.function.name === "roll__powershell",
            );
            const mcp = body.tools?.find((t) => t.function.name.includes("browser-use-agent"));
            assert.ok(shell);
            assert.ok(mcp);
            delta = {
              tool_calls: [
                {
                  index: 0,
                  id: "cwd-" + modelCalls,
                  type: "function",
                  function: {
                    name: shell.function.name,
                    arguments: JSON.stringify({ command: "pwd" }),
                  },
                },
                {
                  index: 1,
                  id: "agent-" + modelCalls,
                  type: "function",
                  function: { name: mcp.function.name, arguments: "{}" },
                },
              ],
            };
            finish = "tool_calls";
          }
          const chunk = {
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "qwen3.7-plus",
            choices: [{ index: 0, delta, finish_reason: null }],
          };
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
          );
        } catch (error) {
          failures.push(String(error));
          response.writeHead(500);
          response.end(String(error));
        }
      });
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    assert.ok(address && typeof address !== "string");
    const configPath = join(source, "roll.config.yaml");
    const context = { version: 1 as const, configPath, configWorkspace: source };
    const config = {
      llm: {
        defaultProvider: "qwen",
        defaultModel: "qwen3.7-plus",
        providers: { qwen: { apiKey: "fixture", baseUrl: `http://127.0.0.1:${address.port}/v1` } },
      },
      agents: { dataDir: "./agents" },
      runtime: {
        threadsDir: "./history",
        // PowerShell has no safe-command classifier; authorize this fixture's fixed pwd call.
        approval: { default: "auto", overrides: { "roll.powershell": "auto" } },
        shell: { enabled: true },
      },
      scheduler: { dataDir: "./ledger" },
      browser: {
        instances: {
          fixture: { cdpPort: 54321, executablePath: "./bin/chrome", userDataDir: "./profile" },
        },
      },
      chat: { instructions: "off" },
    };
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(
      join(task, "roll.config.yaml"),
      "runtime:\n  threads-dir: ./wrong-history\nllm:\n  default-model: wrong-model\n",
    );
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      NODE_OPTIONS: `--experimental-strip-types --experimental-sqlite --import=${pathToFileURL(preload).href}`,
      NO_PROXY: "127.0.0.1",
      TEMP: root,
      TMP: root,
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      ...(process.env.WINDIR === undefined ? {} : { WINDIR: process.env.WINDIR }),
    };
    let client: RollNodeClient | undefined;
    let runtimeLog = "";
    let daemon: ChildProcessWithoutNullStreams | undefined;
    let daemonLog = "";
    let store: ScheduleStore | undefined;
    const startDaemon = () => {
      const child = spawn(
        process.execPath,
        [
          cli,
          "schedule",
          "daemon",
          "--foreground",
          "--data-dir",
          join(source, "ledger"),
          "--max-concurrent-runs",
          "1",
        ],
        { cwd: task, env, stdio: "pipe" },
      );
      child.stderr.on("data", (d: Buffer) => {
        daemonLog += d.toString();
      });
      return child;
    };
    const stopDaemon = async () => {
      if (!daemon) return;
      const child = daemon;
      if (child.exitCode !== null || child.signalCode !== null) {
        daemon = undefined;
        return;
      }
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("daemon shutdown timeout")), 15000);
          timer.unref();
        }),
      ]);
      daemon = undefined;
    };
    try {
      client = await RollNodeClient.start({
        cwd: task,
        command: process.execPath,
        args: [
          cli,
          "runtime",
          "serve",
          "--stdio",
          "--config",
          configPath,
          "--config-workspace",
          source,
        ],
        env,
        onStderr: (line) => {
          runtimeLog += `${line}\n`;
        },
        requestTimeoutMs: 15000,
      });
      const { thread } = await client.request("thread.create", { requestId: randomUUID() });
      let terminal = false;
      client.onEvent((event) => {
        if (event.event.type === "turn.completed") terminal = true;
        if (event.event.type === "turn.failed") failures.push(JSON.stringify(event.event));
      });
      await client.request("turn.start", {
        requestId: randomUUID(),
        threadId: thread.id,
        turnId: randomUUID(),
        input: { text: "Run cwd and fixture Agent" },
      });
      await until(() => terminal || failures.length > 0, "stdio turn");
      assert.deepEqual(failures, []);
      assert.ok(terminal);
      assert.equal(proofs, 1);
      await client.shutdown();
      client = undefined;
      assert.ok(existsSync(join(source, "history", "threads.db")));
      assert.equal(existsSync(join(task, "wrong-history")), false);
      const binding = createScheduleToolBinding({
        configContext: context,
        serviceStatePath: join(root, "service.json"),
        secretsPath: join(root, "secrets.env"),
      });
      const admission = binding.captureCreate(
        { name: "bound-live", prompt: "Run cwd and fixture Agent", every: "1h", rounds: 1 },
        task,
      );
      assert.ok(admission.ok);
      const created = await binding.create(admission);
      assert.ok(created.ok);
      const ledger = join(source, "ledger");
      store = new ScheduleStore(ledger);
      assert.ok(store.getSchedule(created.schedule.id)?.hostContext);
      daemon = startDaemon();
      await until(() => existsSync(join(ledger, "daemon.json")), "first daemon start");
      await stopDaemon();
      const db = new DatabaseSync(join(ledger, "schedules.db"));
      db.prepare("UPDATE schedules SET next_run_at=? WHERE id=?").run(
        Date.now() - 1000,
        created.schedule.id,
      );
      db.close();
      daemon = startDaemon();
      await until(
        () =>
          store?.listInvocations(created.schedule.id).some((i) => i.status === "completed") ===
            true || failures.length > 0,
        "restarted daemon bound execution",
      );
      assert.deepEqual(failures, []);
      assert.equal(proofs, 2);
      assert.equal(store.getSchedule(created.schedule.id)?.status, "completed");
      assert.equal(
        store.getSchedule(created.schedule.id)?.hostContext,
        encodeScheduleHostContext(context),
      );
      const management = join(root, "management");
      mkdirSync(management);
      writeFileSync(
        join(management, "roll.config.yaml"),
        JSON.stringify({
          scheduler: { dataDir: ledger },
          runtime: { approval: { default: "auto" } },
        }),
      );
      const reauthorize = store.createSchedule({
        name: "reauthorize-bound",
        prompt: "later",
        cwd: task,
        trigger: createIntervalTrigger("1h"),
        hostContext: encodeScheduleHostContext(context),
        authorityDigest: computeAuthorityDigest(loadRuntimeConfig(context).config),
      });
      writeFileSync(
        configPath,
        JSON.stringify({
          ...config,
          runtime: { ...config.runtime, approval: { default: "deny" } },
        }),
      );
      const expectedAuthority = computeAuthorityDigest(loadRuntimeConfig(context).config);
      store.setScheduleStatus(reauthorize.id, "paused");
      await promisify(execFile)(process.execPath, [cli, "schedule", "resume", reauthorize.id], {
        cwd: management,
        env,
        timeout: 15000,
      });
      assert.equal(store.getSchedule(reauthorize.id)?.authorityDigest, expectedAuthority);
      store.setScheduleStatus(reauthorize.id, "paused");
      const uiEntry = join(root, "ui-resume.mts");
      const uiSource = resolve(import.meta.dirname, "commands/ui-schedule-controller.ts");
      writeFileSync(
        uiEntry,
        `import {createDefaultScheduleController} from ${JSON.stringify(pathToFileURL(uiSource).href)};const controller=await createDefaultScheduleController();await controller.resumeSchedule({id:${JSON.stringify(reauthorize.id)}});`,
      );
      await promisify(execFile)(process.execPath, [uiEntry], {
        cwd: management,
        env,
        timeout: 15000,
      });
      assert.equal(store.getSchedule(reauthorize.id)?.authorityDigest, expectedAuthority);
      const missing = store.createSchedule({
        name: "missing-source",
        prompt: "must not execute",
        cwd: task,
        trigger: createIntervalTrigger("1h"),
        hostContext: encodeScheduleHostContext(context),
        authorityDigest: computeAuthorityDigest(loadRuntimeConfig(context).config),
        fireImmediately: true,
        maxRounds: 1,
      });
      const before = modelCalls;
      unlinkSync(configPath);
      await until(
        () => store?.listInvocations(missing.id).some((i) => i.status === "failed") === true,
        "missing-source terminal failure",
      );
      assert.equal(modelCalls, before);
      assert.notEqual(store.getSchedule(missing.id)?.status, "active");
      assert.equal(store.getSchedule(missing.id)?.nextRunAtMs, undefined);
      const legacyConfig = {
        ...config,
        agents: { dataDir: agents },
        runtime: { ...config.runtime, threadsDir: join(task, "legacy-history") },
        scheduler: { dataDir: ledger },
        browser: {
          instances: {
            fixture: {
              cdpPort: 54321,
              executablePath: join(source, "bin", "chrome"),
              userDataDir: join(source, "profile"),
            },
          },
        },
      };
      writeFileSync(join(task, "roll.config.yaml"), JSON.stringify(legacyConfig));
      const legacy = store.createSchedule({
        name: "legacy",
        prompt: "legacy execution",
        cwd: task,
        trigger: createIntervalTrigger("1h"),
        authorityDigest: computeAuthorityDigest(loadConfig({ cwd: task }).config),
        fireImmediately: true,
        maxRounds: 1,
      });
      await until(
        () =>
          store?.listInvocations(legacy.id).some((i) => i.status === "completed") === true ||
          failures.length > 0,
        "legacy unbound execution",
      );
      assert.deepEqual(failures, []);
      assert.equal(proofs, 3);
      assert.ok(existsSync(join(task, "legacy-history", "threads.db")));
      const corrupt = store.createSchedule({
        name: "corrupt-context",
        prompt: "must not fall back",
        cwd: task,
        trigger: createIntervalTrigger("1h"),
        hostContext: scheduleHostContextSchema.parse("malformed"),
        fireImmediately: true,
        maxRounds: 1,
      });
      const callsBeforeCorrupt = modelCalls;
      await until(
        () => store?.listInvocations(corrupt.id).some((i) => i.status === "failed") === true,
        "corrupt-context terminal failure",
      );
      assert.equal(modelCalls, callsBeforeCorrupt);
      await stopDaemon();
      assert.equal(existsSync(join(task, "wrong-history")), false);
    } catch (error) {
      throw new Error(`${String(error)}\n${runtimeLog}\n${daemonLog}\n${failures.join("\n")}`, {
        cause: error,
      });
    } finally {
      await client?.shutdown();
      if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
        const exited = once(daemon, "exit");
        daemon.kill("SIGKILL");
        await exited.catch(() => {});
      }
      store?.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
