import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));

test("ask still reaches API-key routing when runtime defaults to subscription", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-ask-subscription-"));
  try {
    writeFileSync(
      join(dir, "roll.config.yaml"),
      JSON.stringify({
        llm: {
          defaultProvider: "openai",
          defaultModel: "gpt-api",
          providers: { openai: { apiKey: "fixture" } },
        },
        runtime: { provider: "chatgpt", model: "subscription-slug" },
        agents: { dataDir: join(dir, "agents") },
      }),
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["--experimental-strip-types", "--experimental-sqlite", CLI_ENTRY, "ask", "fixture"],
        { cwd: dir },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error && "stderr" in error);
        assert.match(String(error.stderr), /暂无已注册的 Agent/);
        assert.doesNotMatch(String(error.stderr), /暂不支持 roll ask|选择 API Key provider/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface CapturedCliFetch {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapturedCliFetch(value: unknown): value is CapturedCliFetch {
  return isRecord(value) && typeof value["url"] === "string" && isRecord(value["body"]);
}

function parseCapturedFetchLines(logPath: string): readonly CapturedCliFetch[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!isCapturedCliFetch(parsed)) {
        throw new Error(`Invalid captured fetch line: ${line}`);
      }
      return parsed;
    });
}

function createSamplingCliFixture() {
  const dir = mkdtempSync(join(tmpdir(), "roll-sampling-cli-"));
  const agentDir = join(dir, "agent");
  const dataDir = join(dir, "agents");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const require = createRequire(import.meta.url);
  const moduleUrl = (specifier: string) =>
    JSON.stringify(pathToFileURL(require.resolve(specifier)).href);

  const agentScript = join(agentDir, "agent.mjs");
  writeFileSync(
    agentScript,
    `
const { Server } = await import(${moduleUrl("@modelcontextprotocol/sdk/server/index.js")});
const { StdioServerTransport } = await import(${moduleUrl("@modelcontextprotocol/sdk/server/stdio.js")});
const { ListToolsRequestSchema, CallToolRequestSchema } = await import(${moduleUrl("@modelcontextprotocol/sdk/types.js")});

const server = new Server(
  { name: "sampling-demo", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo_plain",
      description: "Plain tool without MCP sampling",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "echo_sampling",
      description: "Tool that invokes MCP sampling createMessage",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "echo_plain") {
    return { content: [{ type: "text", text: "plain-ok" }] };
  }
  const sampled = await server.createMessage({
    messages: [{ role: "user", content: { type: "text", text: "sample-now" } }],
    maxTokens: 64,
  });
  return { content: [{ type: "text", text: "sampled:" + sampled.content.text }] };
});
await server.connect(new StdioServerTransport());
`,
  );

  writeFileSync(
    join(dataDir, "agents.json"),
    JSON.stringify([
      {
        skill: {
          name: "sampling-demo",
          description: "Demo agent with plain and sampling tools",
          metadata: {},
        },
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [agentScript],
        },
        runtime: { ownership: "on-demand" },
        installPath: agentDir,
        registeredAt: "2026-11-24T00:00:00.000Z",
        status: "stopped",
      },
    ]),
  );

  const fetchHookPath = join(dir, "mock-fetch.mjs");
  writeFileSync(
    fetchHookPath,
    `
import { appendFileSync } from "node:fs";

globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  if (process.env.ROLL_TEST_FETCH_LOG) {
    appendFileSync(process.env.ROLL_TEST_FETCH_LOG, JSON.stringify({ url, body }) + "\\n");
  }
  const bodyText = JSON.stringify(body);
  const isRoute = bodyText.includes("agentName");
  const isSampling = bodyText.includes("sample-now");
  if (url.includes("/v1/responses")) {
    const text = isRoute
      ? JSON.stringify({
          agentName: "sampling-demo",
          toolName: "echo_sampling",
          confidence: 0.99,
          reasoning: "route",
        })
      : isSampling
        ? "openai-sampled"
        : "{}";
    return new Response(
      JSON.stringify({
        id: "resp_1",
        object: "response",
        created_at: 1,
        model: body.model ?? "gpt-5.4",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_1",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  const text = isRoute
    ? JSON.stringify({
        agentName: "sampling-demo",
        toolName: "echo_sampling",
        confidence: 0.99,
        reasoning: "route",
      })
    : isSampling
      ? "google-sampled"
      : "{}";
  return new Response(
    JSON.stringify({
      candidates: [
        { content: { parts: [{ text }], role: "model" }, finishReason: "STOP" },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
`,
  );

  let runCounter = 0;
  async function invokeCli(
    config: Record<string, unknown>,
    cliArgs: readonly string[],
  ): Promise<{
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly requests: readonly CapturedCliFetch[];
  }> {
    runCounter += 1;
    const logPath = join(dir, `fetch-${String(runCounter)}.jsonl`);
    writeFileSync(
      join(dir, "roll.config.yaml"),
      JSON.stringify({
        ...config,
        agents: { dataDir },
      }),
    );
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--experimental-sqlite",
          "--import",
          pathToFileURL(fetchHookPath).href,
          CLI_ENTRY,
          ...cliArgs,
        ],
        {
          cwd: dir,
          env: { ...process.env, ROLL_TEST_FETCH_LOG: logPath },
        },
      );
      return { code: 0, stdout, stderr, requests: parseCapturedFetchLines(logPath) };
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && "stdout" in error && "stderr" in error) {
        return {
          code: typeof error.code === "number" ? error.code : 1,
          stdout: String(error.stdout),
          stderr: String(error.stderr),
          requests: parseCapturedFetchLines(logPath),
        };
      }
      throw error;
    }
  }

  return {
    invokeCli,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test(
  "standalone roll run/ask downgrade cross-model incompatible sampling efforts to medium while preserving compatible and invalid-config contracts",
  { timeout: 45_000 },
  async () => {
    const fixture = createSamplingCliFixture();
    try {
      const providers = {
        google: { apiKey: "test-google-key" },
        openai: { apiKey: "test-openai-key" },
        xai: { apiKey: "test-xai-key" },
      };

      // 1. ChatGPT off + Google Neon: plain tool succeeds without sampling HTTP, sampling tool downgrades to medium.
      const chatgptOffPlain = await fixture.invokeCli(
        {
          llm: { defaultProvider: "google", defaultModel: "gemini-4-neon", providers },
          runtime: { provider: "chatgpt", model: "gpt-sub", thinkingLevel: "off" },
        },
        ["run", "sampling-demo", "echo_plain", "--json"],
      );
      assert.equal(chatgptOffPlain.code, 0, chatgptOffPlain.stderr);
      assert.match(chatgptOffPlain.stderr, /独立 API Sampling.*默认 medium/);
      assert.equal(chatgptOffPlain.requests.length, 0);
      assert.match(chatgptOffPlain.stdout, /plain-ok/);

      const chatgptOffSampling = await fixture.invokeCli(
        {
          llm: { defaultProvider: "google", defaultModel: "gemini-4-neon", providers },
          runtime: { provider: "chatgpt", model: "gpt-sub", thinkingLevel: "off" },
        },
        ["run", "sampling-demo", "echo_sampling", "--json"],
      );
      assert.equal(chatgptOffSampling.code, 0, chatgptOffSampling.stderr);
      assert.match(chatgptOffSampling.stderr, /独立 API Sampling.*默认 medium/);
      assert.equal(chatgptOffSampling.requests.length, 1);
      assert.deepEqual(chatgptOffSampling.requests[0]?.body.generationConfig, {
        maxOutputTokens: 64,
        thinkingConfig: { thinkingLevel: "medium", includeThoughts: true },
      });

      // 2. Google Neon xhigh + OpenAI: both run and ask downgrade sampling to medium with stderr notice.
      for (const args of [
        ["run", "sampling-demo", "echo_sampling", "--json"],
        ["ask", "invoke echo sampling", "--json"],
      ] as const) {
        const neonToOpenai = await fixture.invokeCli(
          {
            llm: { defaultProvider: "openai", defaultModel: "gpt-5.4", providers },
            runtime: { provider: "google", model: "gemini-4-neon", thinkingLevel: "xhigh" },
          },
          args,
        );
        assert.equal(neonToOpenai.code, 0, neonToOpenai.stderr);
        assert.match(neonToOpenai.stderr, /独立 API Sampling.*默认 medium/);
        const reasoning = neonToOpenai.requests.at(-1)?.body.reasoning;
        assert.ok(isRecord(reasoning));
        assert.equal(reasoning["effort"], "medium");
      }

      // 3. Google Neon xhigh (including inherited runtime.provider) + same-vendor Carbon / 3.8 Flash downgrades to medium.
      for (const apiModel of ["gemini-4-carbon", "gemini-3.8-flash"] as const) {
        const sameVendor = await fixture.invokeCli(
          {
            llm: { defaultProvider: "google", defaultModel: apiModel, providers },
            runtime: { model: "gemini-4-neon", thinkingLevel: "xhigh" },
          },
          ["run", "sampling-demo", "echo_sampling", "--json"],
        );
        assert.equal(sameVendor.code, 0, sameVendor.stderr);
        assert.match(sameVendor.stderr, /独立 API Sampling.*默认 medium/);
        assert.deepEqual(sameVendor.requests[0]?.body.generationConfig, {
          maxOutputTokens: 64,
          thinkingConfig: { thinkingLevel: "medium", includeThoughts: true },
        });
      }

      // 4. Compatible cross-model effort (Google Neon xhigh -> Google Hydrogen) passes through without warning.
      const compatibleCross = await fixture.invokeCli(
        {
          llm: { defaultProvider: "google", defaultModel: "gemini-4-hydrogen", providers },
          runtime: { provider: "google", model: "gemini-4-neon", thinkingLevel: "xhigh" },
        },
        ["run", "sampling-demo", "echo_sampling", "--json"],
      );
      assert.equal(compatibleCross.code, 0, compatibleCross.stderr);
      assert.doesNotMatch(compatibleCross.stderr, /默认 medium/);
      assert.deepEqual(compatibleCross.requests[0]?.body.generationConfig, {
        maxOutputTokens: 64,
        thinkingConfig: { thinkingLevel: "xhigh", includeThoughts: true },
      });

      // 5. Invalid source or invalid same effective model (inherited defaults & models/ alias) still fails fast.
      for (const invalidConfig of [
        {
          llm: { defaultProvider: "google", defaultModel: "gemini-4-neon", providers },
          runtime: { thinkingLevel: "off" },
        },
        {
          llm: { defaultProvider: "google", defaultModel: "gemini-4-neon", providers },
          runtime: { provider: "google", model: "models/gemini-4-neon", thinkingLevel: "off" },
        },
        {
          llm: { defaultProvider: "google", defaultModel: "gemini-4-neon", providers },
          runtime: { provider: "google", model: "gemini-4-carbon", thinkingLevel: "xhigh" },
        },
      ]) {
        const failed = await fixture.invokeCli(invalidConfig, [
          "run",
          "sampling-demo",
          "echo_plain",
          "--json",
        ]);
        assert.notEqual(failed.code, 0);
        assert.match(failed.stderr, /不支持推理强度/);
      }

      // 6. xAI standalone sampling boundary: valid off downgrades to medium on Grok 4.5, compatible/fixed pass through, invalid source/same-model fail fast.
      for (const xaiCase of [
        {
          runtime: { provider: "google", model: "gemini-3.8-flash", thinkingLevel: "off" },
          apiModel: "grok-4.5",
          args: ["run", "sampling-demo", "echo_sampling", "--json"] as const,
          expectWarn: true,
          expectedEffort: "medium",
        },
        {
          runtime: { provider: "chatgpt", model: "gpt-sub", thinkingLevel: "off" },
          apiModel: "grok-4.5",
          args: ["ask", "invoke echo sampling", "--json"] as const,
          expectWarn: true,
          expectedEffort: "medium",
        },
        {
          runtime: { provider: "google", model: "gemini-3.8-flash", thinkingLevel: "off" },
          apiModel: "grok-4.3",
          args: ["run", "sampling-demo", "echo_sampling", "--json"] as const,
          expectWarn: false,
          expectedEffort: "none",
        },
        {
          runtime: { provider: "google", model: "gemini-3.8-flash", thinkingLevel: "off" },
          apiModel: "grok-4.20-reasoning",
          args: ["run", "sampling-demo", "echo_sampling", "--json"] as const,
          expectWarn: false,
          expectedEffort: undefined,
        },
      ]) {
        const outcome = await fixture.invokeCli(
          {
            llm: { defaultProvider: "xai", defaultModel: xaiCase.apiModel, providers },
            runtime: xaiCase.runtime,
          },
          xaiCase.args,
        );
        assert.equal(outcome.code, 0, outcome.stderr);
        if (xaiCase.expectWarn) {
          assert.match(outcome.stderr, /独立 API Sampling 模型 xai\/grok-4\.5.*默认 medium/);
        } else {
          assert.doesNotMatch(outcome.stderr, /默认 medium/);
        }
        const lastRequest = outcome.requests.at(-1);
        assert.equal(lastRequest?.url, "https://api.x.ai/v1/responses");
        assert.equal(lastRequest?.body["model"], xaiCase.apiModel);
        assert.deepEqual(
          lastRequest?.body["reasoning"],
          xaiCase.expectedEffort === undefined ? undefined : { effort: xaiCase.expectedEffort },
        );
      }

      for (const invalidXaiConfig of [
        {
          llm: { defaultProvider: "google", defaultModel: "gemini-4-neon", providers },
          runtime: { provider: "xai", model: "grok-4.5", thinkingLevel: "off" },
        },
        {
          llm: { defaultProvider: "xai", defaultModel: "grok-4.5", providers },
          runtime: { provider: "xai", model: "grok-4.5", thinkingLevel: "off" },
        },
      ]) {
        const rejected = await fixture.invokeCli(invalidXaiConfig, [
          "run",
          "sampling-demo",
          "echo_plain",
          "--json",
        ]);
        assert.notEqual(rejected.code, 0);
        assert.match(rejected.stderr, /模型 grok-4\.5 不支持关闭思考/);
        assert.doesNotMatch(rejected.stderr, /默认 medium/);
        assert.equal(rejected.requests.length, 0);
      }
    } finally {
      fixture.close();
    }
  },
);
