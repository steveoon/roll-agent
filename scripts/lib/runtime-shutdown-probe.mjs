import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 45_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Shared real-process regression and native driver. Every path is an owned fixture input.
export async function runRuntimeShutdownProbe({ node, entry, clientEntry, root, modes }) {
  for (const path of [node, entry, clientEntry, root]) assert.ok(isAbsolute(path));
  for (let parent = root; ; parent = dirname(parent)) {
    for (const name of ["roll.config.yaml", "roll.config.yml"]) {
      await assert.rejects(fs.lstat(join(parent, name)), { code: "ENOENT" });
    }
    if (parent === dirname(parent)) break;
  }
  const { RollNodeClient } = await import(pathToFileURL(clientEntry).href);
  await fs.mkdir(root); // Exclusive ownership; existing roots are never removed.
  let passed = false;
  const children = [];
  try {
    for (const mode of modes) {
      const work = join(root, mode);
      const agents = join(work, "agents");
      const agent = join(work, "fixture-agent");
      await fs.mkdir(work);
      await fs.mkdir(agents);
      await fs.mkdir(agent);
      const receipt = join(agent, "pid.json");
      const stopped = join(agent, "stopped.json");
      await fs.writeFile(
        join(agent, "server.mjs"),
        `
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({pid:process.pid}), {flag:'wx'});
const keepAlive=setInterval(()=>{},1000);
const reader=createInterface({input:process.stdin});
reader.on('line',line=>{
 const message=JSON.parse(line); if(message.id===undefined)return;
 let result;
 if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'shutdown-fixture',version:'1'}};
 else if(message.method==='tools/list')result={tools:[{name:'echo',description:'Return fixture marker',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}}]};
 else if(message.method==='tools/call')result={content:[{type:'text',text:'shutdown-mcp-proof'}]};
 else result={};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
});
reader.on('close',()=>{clearInterval(keepAlive);writeFileSync(${JSON.stringify(stopped)},'closed',{flag:'wx'});});
`,
      );
      await fs.writeFile(
        join(agents, "agents.json"),
        JSON.stringify({
          schemaVersion: 2,
          agents: [
            {
              skill: {
                name: "shutdown-fixture",
                description: "Shutdown regression fixture",
                metadata: {},
              },
              transport: { type: "stdio", command: node, args: [join(agent, "server.mjs")] },
              runtime: { ownership: "on-demand" },
              installPath: agent,
              registeredAt: "2026-11-05T00:00:00Z",
              status: "idle",
              source: { type: "local-path", path: agent },
            },
          ],
        }),
      );
      let calls = 0;
      const pending = Promise.withResolvers();
      const provider = createServer((request, response) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          try {
            calls++;
            const body = JSON.parse(Buffer.concat(chunks).toString());
            if (calls === 3) {
              pending.resolve();
              return;
            }
            let delta, finish;
            if (calls === 1) {
              const tool = body.tools.find((item) =>
                item.function.name.includes("shutdown-fixture"),
              );
              assert.ok(tool, "Actual MCP tool must be advertised");
              delta = {
                tool_calls: [
                  {
                    index: 0,
                    id: "shutdown-call",
                    type: "function",
                    function: { name: tool.function.name, arguments: "{}" },
                  },
                ],
              };
              finish = "tool_calls";
            } else {
              assert.equal(calls, 2);
              assert.match(
                body.messages.findLast((item) => item.role === "tool").content,
                /shutdown-mcp-proof/u,
              );
              delta = { content: "shutdown-complete" };
              finish = "stop";
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
            response.writeHead(500);
            response.end(String(error));
          }
        });
      });
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      await fs.writeFile(
        join(work, "roll.config.yaml"),
        JSON.stringify({
          llm: {
            defaultProvider: "qwen",
            defaultModel: "qwen3.7-plus",
            providers: {
              qwen: {
                apiKey: "fixture-only",
                baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
              },
            },
          },
          agents: { dataDir: agents },
          runtime: { threadsDir: join(work, "threads") },
          chat: { instructions: "off" },
        }),
      );
      const env = {
        HOME: work,
        USERPROFILE: work,
        PATH:
          process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin",
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: work,
        TMP: work,
        NO_PROXY: "127.0.0.1",
      };
      const start = async () => {
        let escalations = 0;
        let errors = "";
        const child = spawn(
          node,
          [
            "--experimental-strip-types",
            "--experimental-sqlite",
            entry,
            "runtime",
            "serve",
            "--stdio",
          ],
          { cwd: work, env, stdio: "pipe" },
        );
        children.push(child);
        const exited = once(child, "close");
        child.stderr.on("data", (data) => {
          errors += data;
        });
        const client = await RollNodeClient.connect({
          transport: {
            stdin: child.stdin,
            stdout: child.stdout,
            stderr: child.stderr,
            onExit: (listener) => child.once("close", listener),
            close: () => child.stdin.end(),
            terminate: () => {
              escalations++;
              child.kill("SIGTERM");
            },
            forceClose: () => {
              escalations++;
              child.kill("SIGKILL");
            },
          },
        });
        return { client, child, exited, diagnostics: () => ({ errors, escalations }) };
      };
      try {
        const first = await start();
        const { thread } = await first.client.request("thread.create", { requestId: randomUUID() });
        const complete = Promise.withResolvers();
        first.client.onEvent((envelope) => {
          if (envelope.event.type === "turn.completed") complete.resolve();
          if (envelope.event.type === "turn.failed") {
            complete.reject(new Error(JSON.stringify(envelope.event)));
          }
        });
        await first.client.request("turn.start", {
          requestId: randomUUID(),
          threadId: thread.id,
          turnId: randomUUID(),
          input: { text: "Call the fixture tool" },
        });
        await bounded(complete.promise, "actual provider/MCP turn");
        assert.equal(calls, 2);
        const pid = JSON.parse(await fs.readFile(receipt, "utf8")).pid;
        process.kill(pid, 0); // MCP is genuinely alive before shutdown.
        const claimCount = () => {
          const claims = new DatabaseSync(join(work, "threads", "threads.db.occupancy.sqlite"), {
            readOnly: true,
          });
          try {
            return claims.prepare("SELECT count(*) AS n FROM claims").get().n;
          } finally {
            claims.close();
          }
        };
        assert.ok(claimCount() > 0, "The actual thread claim must exist before shutdown");
        if (mode === "cancel-eof") {
          await first.client.request("turn.start", {
            requestId: randomUUID(),
            threadId: thread.id,
            turnId: randomUUID(),
            input: { text: "Wait for cancellation" },
          });
          await bounded(pending.promise, "pending provider request");
        }
        if (mode === "sigint" || mode === "sigterm") {
          first.child.kill(mode === "sigint" ? "SIGINT" : "SIGTERM");
        } else first.child.stdin.end();
        const result = await first.client.shutdown();
        await first.exited;
        assert.equal(
          result.code,
          mode === "sigint" ? 130 : mode === "sigterm" ? 143 : 0,
          first.diagnostics().errors,
        );
        assert.equal(result.signal, null);
        assert.equal(
          first.diagnostics().escalations,
          0,
          "Natural close must not need external termination",
        );
        assert.doesNotMatch(first.diagnostics().errors, /Assertion failed|UV_HANDLE_CLOSING/u);
        assert.equal(await fs.readFile(stopped, "utf8"), "closed");
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        assert.equal(
          claimCount(),
          0,
          "Cleanup must release claims before another owner can reap them",
        );
        const leaseDirectory = join(
          agents,
          "pids",
          ".leases",
          createHash("sha256").update("shutdown-fixture").digest("hex"),
        );
        const leases = await fs.readdir(leaseDirectory).catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        assert.equal(leases.filter((name) => name.endsWith(".json")).length, 0);
        const second = await start();
        await second.client.request("thread.open", { threadId: thread.id });
        const secondExit = await second.client.shutdown();
        await second.exited;
        assert.equal(secondExit.code, 0, second.diagnostics().errors);
        assert.equal(second.diagnostics().escalations, 0);
        console.log(
          "RUNTIME_SHUTDOWN_PASS",
          JSON.stringify({
            mode,
            calls,
            code: result.code,
            mcpDead: true,
            claimReopened: true,
            escalation: 0,
          }),
        );
      } finally {
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
      }
    }
    passed = true;
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(
      children
        .filter((child) => child.exitCode === null && child.signalCode === null)
        .map((child) => once(child, "close")),
    );
    if (passed) await fs.rm(root, { recursive: true, force: true });
    else console.error("RUNTIME_SHUTDOWN_RETAINED", root);
  }
}
