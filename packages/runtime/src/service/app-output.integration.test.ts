import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { normalizeListedTools } from "@roll-agent/core/cli/utils/agent-tools";
import {
  runtimeMethodSchemas,
  operationIdSchema,
  threadIdSchema,
  type RuntimeEventEnvelopeV15,
} from "@roll-agent/protocol";
import { AgentSession } from "../engine/agent-session.ts";
import { ThreadStore } from "../store/thread-store.ts";
import { RuntimeService, type RuntimeServiceEngine } from "./runtime-service.ts";

function model(): MockLanguageModelV4 {
  let step = 0;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks: LanguageModelV4StreamPart[] =
        step++ === 0
          ? [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "app-output-call",
                toolName: "structured-output-demo__list_candidates",
                input: "{}",
              },
              { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool-calls" } },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "answer" },
              { type: "text-delta", id: "answer", delta: "Completed." },
              { type: "text-end", id: "answer" },
              { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
            ];
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      };
    },
  });
}

for (const invalid of [false, true]) {
  test(
    `SDK to MCP to AgentSession to durable Runtime result (${invalid ? "invalid after execution" : "available"})`,
    { timeout: 15000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "roll-app-output-integration-"));
      let store = new ThreadStore(dir);
      const client = new Client({ name: "runtime", version: "1" });
      const data = {
        candidates: [
          { id: "candidate-1", name: "李明", score: 0.9, skills: ["TypeScript", "Node.js"] },
        ],
      };
      const countFile = join(dir, "effects.txt");
      const clientTransport = new StdioClientTransport({
        command: process.execPath,
        args: [
          "--experimental-strip-types",
          resolve(import.meta.dirname, "../../../../tests/structured-output/candidate-agent.mjs"),
        ],
        env: {
          ...getDefaultEnvironment(),
          ROLL_TEST_EFFECT_COUNT: countFile,
          ROLL_TEST_INVALID_OUTPUT: invalid ? "1" : "0",
        },
        stderr: "pipe",
      });
      await client.connect(clientTransport);
      const tools = normalizeListedTools((await client.listTools()).tools);
      const sessions = new Map<string, AgentSession>();
      const engine: RuntimeServiceEngine = {
        async createSession(input) {
          const id = store.createThread(input);
          const session = new AgentSession({
            id,
            model: model(),
            maxSteps: 3,
            sources: [
              {
                agentName: "structured-output-demo",
                client,
                tools: tools.map((tool) => ({ tool, annotations: undefined })),
              },
            ],
            onToolExecution: (record) => {
              store.appendToolExecution(id, record);
            },
            onPersist: (messages, options) => {
              store.appendMessages(id, messages, options);
            },
            onReplace: (messages) => {
              store.replaceMessages(id, messages);
            },
          });
          sessions.set(id, session);
          return session;
        },
        async resumeSession(id) {
          const session = sessions.get(id);
          assert.ok(session);
          return session;
        },
      };
      let service = new RuntimeService(engine, store);
      try {
        service.initialize({
          protocolVersions: ["1.5"],
          client: { name: "integration", version: "1" },
        });
        const { thread } = await service.createThread(
          runtimeMethodSchemas["thread.create"].params.parse({ requestId: randomUUID() }),
        );
        const events: RuntimeEventEnvelopeV15[] = [];
        const done = Promise.withResolvers<void>();
        service.onEvent((event) => {
          events.push(event);
          if (event.event.type === "turn.completed") done.resolve();
          if (event.event.type === "turn.failed") {
            done.reject(new Error(JSON.stringify(event.event)));
          }
        });
        await service.startTurn(
          runtimeMethodSchemas["turn.start"].params.parse({
            requestId: randomUUID(),
            threadId: thread.id,
            turnId: randomUUID(),
            input: { text: "List candidates" },
          }),
        );
        await done.promise;
        const completed = events.find((event) => event.event.type === "tool.completed");
        assert.ok(completed?.event.type === "tool.completed");
        assert.equal(completed.event.outcome?.kind, "success");
        assert.equal(completed.event.appOutput.status, invalid ? "invalid" : "available");
        assert.equal("data" in completed.event.appOutput, false);
        const operationId = operationIdSchema.parse(completed.event.operationId);
        const params = { threadId: thread.id, operationId };
        const result = service.getOperationResult(params);
        assert.equal(result.result?.output.status, invalid ? "invalid" : "available");
        if (!invalid) {
          assert.equal(result.result?.output.status, "available");
          if (result.result?.output.status === "available") {
            assert.deepEqual(result.result.output.data, data);
          }
        }
        assert.equal(Number(readFileSync(countFile, "utf8")), 1);
        assert.deepEqual(
          service.snapshotThread({ threadId: thread.id, limit: 100 }).operations.items[0]
            ?.appOutput,
          completed.event.appOutput,
        );
        assert.equal(
          store
            .resumeRuntimeEvents(thread.id, null)
            .events.some(
              (event) =>
                event.event.type === "tool.completed" &&
                event.event.appOutput.status === (invalid ? "invalid" : "available"),
            ),
          true,
        );
        const db = new DatabaseSync(join(dir, "threads.db"), { readOnly: true });
        assert.equal(
          db
            .prepare("SELECT count(*) AS n FROM runtime_events WHERE event_json LIKE '%appOutput%'")
            .get()?.n,
          0,
        );
        db.close();
        const fork = threadIdSchema.parse(store.forkSnapshot(store.readSnapshot(thread.id)));
        assert.deepEqual(
          service.getOperationResult({ threadId: fork, operationId }).result?.output,
          result.result?.output,
        );
        await service.close();
        store.close();
        store = new ThreadStore(dir);
        service = new RuntimeService(engine, store);
        assert.deepEqual(service.getOperationResult(params), result);
        assert.deepEqual(
          service.snapshotThread({ threadId: thread.id, limit: 100 }).operations.items[0]
            ?.appOutput,
          completed.event.appOutput,
        );
        assert.equal(Number(readFileSync(countFile, "utf8")), 1);
      } finally {
        await service.close();
        await client.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}
