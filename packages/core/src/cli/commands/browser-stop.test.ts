import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_STOP_ALL_DESCRIPTION,
  BROWSER_STOP_COMMAND_DESCRIPTION,
  BROWSER_STOP_INSTANCE_DESCRIPTION,
  BROWSER_USE_AGENT_NOT_RUNNING_MESSAGE,
  createBrowserStopAgentNotRunningOutput,
  createBrowserStopTextLines,
  parseBrowserStopInstances,
  parseBrowserStopToolResult,
  resolveBrowserStopRequest,
  validateDeclaredBrowserStopInstances,
} from "./browser-stop.ts";
import type { BrowserConfig } from "../../config/schema.ts";

test("browser stop help copy distinguishes runtime stop from agent stop", () => {
  assert.match(BROWSER_STOP_COMMAND_DESCRIPTION, /不会停止 browser-use-agent 服务进程/);
  assert.match(BROWSER_STOP_INSTANCE_DESCRIPTION, /一个或多个 browserInstance/);
  assert.match(BROWSER_STOP_INSTANCE_DESCRIPTION, /必须显式使用 --all/);
  assert.match(BROWSER_STOP_ALL_DESCRIPTION, /保留 browser-use-agent 进程继续运行/);
  assert.match(BROWSER_STOP_ALL_DESCRIPTION, /不同于 roll agent stop browser-use-agent/);
});

test("resolveBrowserStopRequest requires instances or --all", () => {
  assert.throws(
    () => resolveBrowserStopRequest({ rawArgs: [], all: false }),
    /请提供一个或多个 browserInstance/,
  );
});

test("resolveBrowserStopRequest rejects --all combined with instances", () => {
  assert.throws(
    () => resolveBrowserStopRequest({ rawArgs: ["boss-a"], all: true }),
    /--all 不能和 browserInstance/,
  );
});

test("resolveBrowserStopRequest builds all input", () => {
  assert.deepEqual(resolveBrowserStopRequest({ rawArgs: ["--all"], all: true }), {
    all: true,
    instances: [],
    toolInput: { all: true },
  });
});

test("resolveBrowserStopRequest builds single and multi instance inputs", () => {
  assert.deepEqual(resolveBrowserStopRequest({ rawArgs: ["boss-a"], all: false }), {
    all: false,
    instances: ["boss-a"],
    toolInput: { browserInstance: "boss-a" },
  });
  assert.deepEqual(
    resolveBrowserStopRequest({ rawArgs: ["--json", "boss-a", "boss-b"], all: false }),
    {
      all: false,
      instances: ["boss-a", "boss-b"],
      toolInput: { browserInstances: ["boss-a", "boss-b"] },
    },
  );
});

test("parseBrowserStopInstances skips command flags and deduplicates instances", () => {
  assert.deepEqual(
    parseBrowserStopInstances(["--json", "boss-a", "--config", "roll.config.yaml", "boss-a"]),
    ["boss-a"],
  );
});

test("parseBrowserStopToolResult unwraps JSON text MCP results", () => {
  const parsed = parseBrowserStopToolResult({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          stopped: 1,
          results: [
            {
              browserInstance: "boss-a",
              status: "stopped",
              mode: "managed-cdp",
            },
          ],
        }),
      },
    ],
  });

  assert.deepEqual(parsed, {
    ok: true,
    stopped: 1,
    results: [
      {
        browserInstance: "boss-a",
        status: "stopped",
        mode: "managed-cdp",
      },
    ],
  });
});

test("validateDeclaredBrowserStopInstances fails for undeclared configured instances", () => {
  const request = resolveBrowserStopRequest({
    rawArgs: ["boss-a", "missing"],
    all: false,
  });

  assert.throws(
    () => validateDeclaredBrowserStopInstances(createBrowserConfig(["boss-a"]), request),
    /browserInstance "missing" 未声明；可用实例: boss-a/,
  );
});

test("validateDeclaredBrowserStopInstances allows legacy config without browser.instances", () => {
  const request = resolveBrowserStopRequest({
    rawArgs: ["default"],
    all: false,
  });

  assert.doesNotThrow(() => validateDeclaredBrowserStopInstances(createBrowserConfig([]), request));
});

test("validateDeclaredBrowserStopInstances skips --all because runtime owns the running set", () => {
  const request = resolveBrowserStopRequest({
    rawArgs: ["--all"],
    all: true,
  });

  assert.doesNotThrow(() =>
    validateDeclaredBrowserStopInstances(createBrowserConfig(["boss-a"]), request),
  );
});

test("agent not running output is a no-op success", () => {
  const output = createBrowserStopAgentNotRunningOutput();
  const request = resolveBrowserStopRequest({ rawArgs: ["boss-a"], all: false });

  assert.equal(output.ok, true);
  assert.equal(output.agentRunning, false);
  assert.equal(output.message, BROWSER_USE_AGENT_NOT_RUNNING_MESSAGE);
  assert.deepEqual(createBrowserStopTextLines(output, request), [
    BROWSER_USE_AGENT_NOT_RUNNING_MESSAGE,
  ]);
});

function createBrowserConfig(instanceIds: readonly string[]): BrowserConfig {
  return {
    instances: Object.fromEntries(
      instanceIds.map((id, index) => [
        id,
        {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222 + index,
          channel: "chrome",
          userDataDir: `/tmp/roll-browser/${id}`,
        },
      ]),
    ),
  };
}

test("browser stop text output uses required success messages", () => {
  assert.deepEqual(
    createBrowserStopTextLines(
      {
        ok: true,
        agentRunning: true,
        stopped: 1,
        results: [
          {
            browserInstance: "boss-a",
            status: "stopped",
            mode: "managed-cdp",
          },
        ],
      },
      resolveBrowserStopRequest({ rawArgs: ["boss-a"], all: false }),
    ),
    ['已关闭 browser instance "boss-a"；browser-use-agent 仍在运行。'],
  );
  assert.deepEqual(
    createBrowserStopTextLines(
      {
        ok: true,
        agentRunning: true,
        stopped: 2,
        results: [
          {
            browserInstance: "boss-a",
            status: "stopped",
            mode: "managed-cdp",
          },
          {
            browserInstance: "boss-b",
            status: "stopped",
            mode: "managed-cdp",
          },
        ],
      },
      resolveBrowserStopRequest({ rawArgs: ["--all"], all: true }),
    ),
    ["已关闭所有已启动 browser instances；browser-use-agent 仍在运行。"],
  );
});
