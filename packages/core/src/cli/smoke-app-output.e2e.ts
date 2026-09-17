import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  runRoll,
  spawnRollProcess,
  waitForSpawnedRollExit,
  cleanupSpawnedRollProcess,
} from "./smoke.e2e-harness.ts";

for (const command of ["run", "ask"] as const) {
  test(
    `CLI ${command} preserves completed execution when structured output is invalid`,
    { timeout: 30000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "roll-cli-app-output-"));
      const agent = join(dir, "agent");
      mkdirSync(agent);
      const fixture = resolve(
        import.meta.dirname,
        "../../../../tests/structured-output/candidate-agent.mjs",
      );
      writeFileSync(
        join(agent, "SKILL.md"),
        `---\nname: structured-output-demo\ndescription: Synthetic output validation fixture.\nmetadata:\n  roll-transport: stdio\n  roll-command: node --experimental-strip-types ${fixture}\n---\nFixture\n`,
      );
      const server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          const content = body.includes("[Extraction Schema]")
            ? {}
            : { agentName: "structured-output-demo", toolName: "list_candidates", confidence: 1 };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              id: "fixture",
              object: "chat.completion",
              created: 1,
              model: "qwen-fixture",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: JSON.stringify(content) },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
        });
      });
      let process: ReturnType<typeof spawnRollProcess> | undefined;
      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        writeFileSync(
          join(dir, "roll.config.yaml"),
          JSON.stringify({
            llm: {
              defaultProvider: "qwen",
              defaultModel: "qwen-fixture",
              providers: {
                qwen: { apiKey: "fixture-only", baseUrl: `http://127.0.0.1:${address.port}/v1` },
              },
            },
            agents: {
              dataDir: join(dir, "agents"),
              env: {
                "structured-output-demo": {
                  ROLL_TEST_INVALID_OUTPUT: "1",
                  ROLL_TEST_EFFECT_COUNT: join(dir, "count"),
                },
              },
            },
          }),
        );
        const added = runRoll(["agent", "add", agent], dir, { env: { ROLL_SKIP_INSTALL: "1" } });
        assert.equal(added.status, 0, added.stderr);
        process = spawnRollProcess(
          command === "run"
            ? ["run", "structured-output-demo", "list_candidates", "--json"]
            : ["ask", "List synthetic candidates", "--json"],
          dir,
          {},
        );
        const exit = await waitForSpawnedRollExit(process, "completed app output", 20000);
        assert.equal(exit.code, 0, process.output.stderr);
        const result: Record<string, unknown> = JSON.parse(process.output.stdout);
        assert.equal(result.appOutputStatus, "invalid");
        assert.equal(
          command === "run" ? result.ok : result.status,
          command === "run" ? true : "success",
        );
        assert.match(process.output.stderr, /Tool execution completed/);
        assert.equal(readFileSync(join(dir, "count"), "utf8"), "1");
      } finally {
        if (process) await cleanupSpawnedRollProcess(process, "app output CLI fixture");
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

test(
  "CLI keeps healthy tools usable when another tool has malformed App metadata",
  { timeout: 30000 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-cli-app-discovery-"));
    const agent = join(dir, "agent");
    mkdirSync(agent);
    const require = createRequire(import.meta.url);
    const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(require.resolve(name)).href);
    writeFileSync(
      join(agent, "agent.mjs"),
      `
const {Server} = await import(${moduleUrl("@modelcontextprotocol/sdk/server/index.js")});
const {StdioServerTransport} = await import(${moduleUrl("@modelcontextprotocol/sdk/server/stdio.js")});
const {ListToolsRequestSchema,CallToolRequestSchema} = await import(${moduleUrl("@modelcontextprotocol/sdk/types.js")});
const server = new Server({name:"mixed-output",version:"1"},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
  {name:"broken",inputSchema:{type:"object"},outputSchema:{type:"object"},_meta:{"roll/appOutput":"bad"}},
  {name:"ping",inputSchema:{type:"object"}}
]}));
server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:"text",text:'{"pong":true}'}]}));
await server.connect(new StdioServerTransport());
`,
    );
    writeFileSync(
      join(agent, "SKILL.md"),
      "---\nname: mixed-output\ndescription: Discovery fixture\nmetadata:\n  roll-transport: stdio\n  roll-command: node agent.mjs\n---\nFixture\n",
    );
    writeFileSync(
      join(dir, "roll.config.yaml"),
      JSON.stringify({ agents: { dataDir: join(dir, "agents") } }),
    );
    try {
      const added = runRoll(["agent", "add", agent], dir, { env: { ROLL_SKIP_INSTALL: "1" } });
      assert.equal(added.status, 0, added.stderr);
      const listed = runRoll(["agent", "tools", "mixed-output", "--json"], dir);
      assert.equal(listed.status, 0, listed.stderr);
      assert.match(listed.stdout, /invalid_contract/);
      assert.match(listed.stderr, /structured results disabled/);
      const called = runRoll(["run", "mixed-output", "ping", "--json"], dir);
      assert.equal(called.status, 0, called.stderr);
      assert.deepEqual(JSON.parse(called.stdout), { pong: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
