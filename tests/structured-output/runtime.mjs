import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";
import { AgentSession } from "../../packages/runtime/src/engine/agent-session.ts";
import { ThreadStore } from "../../packages/runtime/src/store/thread-store.ts";
import { RuntimeService } from "../../packages/runtime/src/service/runtime-service.ts";
import { RuntimeServer } from "../../packages/runtime/src/server/runtime-server.ts";
import { normalizeListedTools } from "../../packages/core/src/cli/utils/agent-tools.ts";

const require = createRequire(new URL("../../packages/runtime/package.json", import.meta.url));
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
);
const { StdioClientTransport, getDefaultEnvironment } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"))
);
const { MockLanguageModelV4 } = await import(pathToFileURL(require.resolve("ai/test")));
const { simulateReadableStream } = await import(pathToFileURL(require.resolve("ai")));
const client = new Client({ name: "structured-output-runtime-fixture", version: "1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [
      "--experimental-strip-types",
      fileURLToPath(new URL("./candidate-agent.mjs", import.meta.url)),
    ],
    env: {
      ...getDefaultEnvironment(),
      ROLL_TEST_EFFECT_COUNT: process.env.ROLL_TEST_EFFECT_COUNT ?? "",
    },
    stderr: "pipe",
  }),
);
const tools = normalizeListedTools((await client.listTools()).tools);
const store = new ThreadStore(process.env.ROLL_TEST_STORE);
const sessions = new Map();
function newModel() {
  let step = 0;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: null,
        chunkDelayInMs: null,
        chunks:
          step++ === 0
            ? [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "candidate-call",
                  toolName: "structured-output-demo__list_candidates",
                  input: "{}",
                },
                {
                  type: "finish",
                  usage,
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "answer" },
                { type: "text-delta", id: "answer", delta: "Found one synthetic candidate." },
                { type: "text-end", id: "answer" },
                { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
              ],
      }),
    }),
  });
}
function session(id) {
  let current = sessions.get(id);
  if (!current) {
    current = new AgentSession({
      id,
      model: newModel(),
      maxSteps: 3,
      sources: [
        {
          agentName: "structured-output-demo",
          client,
          tools: tools.map((tool) => ({ tool, annotations: undefined })),
        },
      ],
      initialMessages: store.getMessages(id),
      onToolExecution: (record) => store.appendToolExecution(id, record),
      onPersist: (messages, options) => store.appendMessages(id, messages, options),
      onReplace: (messages) => store.replaceMessages(id, messages),
    });
    sessions.set(id, current);
  }
  return current;
}
const engine = {
  createSession: async (input) => session(store.createThread(input)),
  resumeSession: async (id) => session(id),
};
const service = new RuntimeService(engine, store);
const reader = createInterface({ input: process.stdin });
const connection = {
  send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  onMessage: (listener) => reader.on("line", (line) => listener(JSON.parse(line))),
  onClose: (listener) => reader.once("close", listener),
  close: () => reader.close(),
};
const server = new RuntimeServer(engine, connection, { runtimeService: service });
let stopping;
const stop = () => {
  stopping ??= (async () => {
    await server.abortAll();
    await client.close();
    store.close();
    reader.close();
  })();
  return stopping;
};
reader.once("close", () => {
  stop().catch(() => {
    process.exitCode = 1;
  });
});
process.once("SIGTERM", () => {
  stop()
    .finally(() => process.exit(0))
    .catch(() => {
      process.exitCode = 1;
    });
});
