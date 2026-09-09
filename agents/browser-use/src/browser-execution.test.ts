import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { z } from "zod";
import { StructuredToolError } from "@roll-agent/sdk";
import type { AgentContext } from "@roll-agent/sdk";
import {
  BrowserExecuteInputSchema,
  BrowserExecuteResultSchema,
  BrowserRuntimeConfigSchema,
  BrowserScriptError,
  compileBrowserScript,
} from "@roll-agent/browser";
import type { BrowserExecuteInput, NativeCdpController } from "@roll-agent/browser";
import {
  executeBrowserTool,
  setBrowserExecutionDependenciesForTests,
} from "./browser-execution.ts";
import type { BrowserExecutionDependencies } from "./browser-execution.ts";
import { resetToolActionApprovalsForTests } from "./tool-action-approval.ts";
import { browserExecute } from "./tools/browser-execute.ts";

const context: AgentContext = {
  llm: { generateText: async () => "" },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
};
const approvalDetails = z.object({
  approvalRequest: z.object({
    retryInput: z.object({ scriptApproval: z.object({ id: z.string() }) }),
  }),
});
const mcpResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});

function input(overrides: Partial<BrowserExecuteInput> = {}) {
  return BrowserExecuteInputSchema.parse({
    pageId: "page-one",
    source: 'await page.goto("https://example.com/next");',
    capabilities: ["read", "navigate"],
    allowedOrigins: ["https://example.com"],
    ...overrides,
  });
}

function completed(status: "completed" | "cancelled" = "completed") {
  return BrowserExecuteResultSchema.parse({
    executionId: "execution-one",
    status,
    verification: "not_requested",
    logs: [],
    actions: [],
    checks: [],
    observation: { changed: false },
    artifacts: [],
    metrics: { elapsedMs: 1, helperCalls: 0, verifiedAssertions: 0 },
  });
}

function fixture(execute?: BrowserExecutionDependencies["execute"]) {
  const config = BrowserRuntimeConfigSchema.parse({ security: { actionPolicy: "confirm" } });
  const state = {
    url: "https://example.com/form",
    loaderId: "document-one",
    closed: 0,
    executions: 0,
    navigations: [] as string[],
    onNavigate: () => {},
  };
  // Only the document identity and navigation CDP surface are needed for this service boundary test.
  const controller = {
    getDocument: async () => ({ root: { nodeId: 1, backendNodeId: 1 } }),
    getFrameTree: async () => ({ frame: { id: "main", loaderId: state.loaderId, url: state.url } }),
    navigate: async (url: string) => {
      state.navigations.push(url);
      state.url = url;
      state.onNavigate();
      return { frameId: "main" };
    },
    close: () => {
      state.closed++;
    },
  } as unknown as NativeCdpController;
  const deps: BrowserExecutionDependencies = {
    browserInstance: "instance-one",
    compile: compileBrowserScript,
    runtime: {
      getConfig: () => config,
      listNativePages: async () => [
        { targetId: "page-one", type: "page", url: state.url, title: "Form" },
      ],
      connectNativePage: async () => controller,
    },
    execute: async (program, options) => {
      state.executions++;
      if (execute) return execute(program, options);
      await options.driver.invoke("goto", ["https://example.com/next"]);
      return completed();
    },
  };
  setBrowserExecutionDependenciesForTests(deps);
  return { config, state, deps };
}

async function request(program = input()) {
  try {
    await executeBrowserTool(program, context);
    assert.fail("Expected confirmation");
  } catch (error) {
    assert.ok(error instanceof StructuredToolError);
    assert.equal(error.payload.code, "needs_confirmation");
    return approvalDetails.parse(error.payload.details).approvalRequest.retryInput;
  }
}

async function sdkExecute() {
  // Dynamic import keeps this internal SDK test adapter outside the agent's published dependency surface.
  const module: Record<string, unknown> = await import(
    new URL("../../../packages/sdk/src/define-agent.ts", import.meta.url).href
  );
  const execute = module["executeToolForMcp"];
  assert.equal(typeof execute, "function");
  if (typeof execute !== "function") throw new Error("SDK executor is unavailable");
  return execute;
}

afterEach(() => {
  setBrowserExecutionDependenciesForTests(undefined);
  resetToolActionApprovalsForTests();
});

test("service requests confirmation before effects and consumes an exact retry only once", async () => {
  const target = fixture();
  const retry = await request();
  assert.equal(target.state.executions, 0);
  assert.deepEqual(target.state.navigations, []);
  const result = await executeBrowserTool(input(retry), context);
  assert.equal(result.result.status, "completed");
  assert.equal(target.state.executions, 1);
  assert.deepEqual(target.state.navigations, ["https://example.com/next"]);
  await request(input(retry));
  assert.equal(target.state.executions, 1);
});

test("changed source and changed document reject an approval without browser actions", async () => {
  const target = fixture();
  const retry = await request();
  await request(input({ ...retry, source: 'await page.goto("https://example.com/other");' }));
  assert.equal(target.state.executions, 0);
  target.state.loaderId = "new-document";
  await request(input(retry));
  assert.equal(target.state.executions, 0);
  assert.deepEqual(target.state.navigations, []);
});

test("live log-to-deny policy change stops the program after its first navigation", async () => {
  const target = fixture(async (_program, { driver }) => {
    await driver.invoke("goto", ["https://example.com/first"]);
    await driver.invoke("goto", ["https://example.com/second"]);
    return completed();
  });
  target.config.security.actionPolicy = "log";
  target.state.onNavigate = () => {
    target.config.security.actionPolicy = "deny";
  };
  await assert.rejects(
    executeBrowserTool(input(), context),
    (error: unknown) => error instanceof BrowserScriptError && error.code === "action_denied",
  );
  assert.deepEqual(target.state.navigations, ["https://example.com/first"]);
});

test("missing read capability, denied policy and undeclared origins never reach execution", async () => {
  const target = fixture();
  await assert.rejects(
    executeBrowserTool(input({ capabilities: ["navigate"] }), context),
    (error: unknown) =>
      error instanceof StructuredToolError && error.payload.code === "invalid_input",
  );
  target.config.security.actionPolicy = "deny";
  await assert.rejects(
    executeBrowserTool(input(), context),
    (error: unknown) =>
      error instanceof StructuredToolError && error.payload.code === "action_denied",
  );
  target.config.security.actionPolicy = "log";
  await assert.rejects(
    executeBrowserTool(input({ allowedOrigins: ["https://other.example"] }), context),
    (error: unknown) =>
      error instanceof StructuredToolError && error.payload.code === "action_denied",
  );
  assert.equal(target.state.executions, 0);
  assert.deepEqual(target.state.navigations, []);
});

test("declaring read-only capability cannot hide a navigation from confirmation policy", async () => {
  const target = fixture();
  await assert.rejects(
    executeBrowserTool(input({ capabilities: ["read"] }), context),
    (error: unknown) => error instanceof BrowserScriptError && error.code === "capability_blocked",
  );
  assert.equal(target.state.executions, 1);
  assert.deepEqual(target.state.navigations, []);
});

test("SDK MCP error serialization preserves the producer's scriptApproval retry token", async () => {
  const target = fixture();
  const execute = await sdkExecute();
  const first = mcpResult.parse(await execute(browserExecute, context, input()));
  assert.equal(first.isError, true);
  const error = z
    .object({ code: z.literal("needs_confirmation"), details: approvalDetails })
    .parse(JSON.parse(first.content[0]!.text));
  assert.equal(target.state.executions, 0);
  const retried = mcpResult.parse(
    await execute(browserExecute, context, input(error.details.approvalRequest.retryInput)),
  );
  assert.notEqual(retried.isError, true);
  assert.equal(
    BrowserExecuteResultSchema.parse(JSON.parse(retried.content[0]!.text)).status,
    "completed",
  );
  const replayed = mcpResult.parse(
    await execute(browserExecute, context, input(error.details.approvalRequest.retryInput)),
  );
  assert.equal(replayed.isError, true);
  assert.equal(target.state.executions, 1);
});

test("SDK request cancellation reaches browser_execute and its execution dependency", async () => {
  const cancellation = new AbortController();
  let enter: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const target = fixture(async (_program, { signal }) => {
    assert.equal(signal, cancellation.signal);
    enter();
    await new Promise<void>((resolve) =>
      signal!.addEventListener("abort", () => resolve(), { once: true }),
    );
    return completed("cancelled");
  });
  target.config.security.actionPolicy = "log";
  const execute = await sdkExecute();
  const running = execute(browserExecute, context, input(), cancellation.signal);
  await entered;
  cancellation.abort();
  const result = mcpResult.parse(await running);
  assert.equal(
    BrowserExecuteResultSchema.parse(JSON.parse(result.content[0]!.text)).status,
    "cancelled",
  );
  assert.equal(target.state.executions, 1);
  assert.deepEqual(target.state.navigations, []);
  assert.ok(target.state.closed >= 1);
});
