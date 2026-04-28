import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Browser } from "playwright-core";
import type { ChildProcess } from "node:child_process";
import { BrowserRuntimeConfigSchema } from "../types/index.ts";
import { BrowserRuntime } from "./browser-runtime.ts";
import type { NativeCdpController } from "./native-cdp-controller.ts";

function makeTmpUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), `roll-browser-runtime-${randomUUID()}-`));
}

function createManagedProcessState(): {
  readonly proc: ChildProcess;
  readonly getKillCalls: () => number;
} {
  let exitCode: number | null = null;
  let killCalls = 0;

  const proc = {
    get exitCode() {
      return exitCode;
    },
    kill() {
      killCalls += 1;
      exitCode = 0;
      return true;
    },
    stderr: undefined,
  } as unknown as ChildProcess;

  return {
    proc,
    getKillCalls: () => killCalls,
  };
}

function createBrowserState(): {
  readonly browser: Browser;
  readonly getCloseCalls: () => number;
} {
  let closeCalls = 0;

  return {
    browser: {
      isConnected() {
        return true;
      },
      async close() {
        closeCalls += 1;
      },
    } as unknown as Browser,
    getCloseCalls: () => closeCalls,
  };
}

type FetchCall = {
  readonly url: string;
  readonly method: string;
};

function createResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
}

test("managed-cdp start launches Chrome without eagerly attaching Playwright", async () => {
  const userDataDir = makeTmpUserDataDir();
  try {
    const managedProcess = createManagedProcessState();
    const connectedBrowser = createBrowserState();
    let spawnCalls = 0;
    let connectCalls = 0;

    const runtime = new BrowserRuntime(
      BrowserRuntimeConfigSchema.parse({
        mode: "managed-cdp",
        userDataDir,
      }),
      {
        spawn() {
          spawnCalls += 1;
          return managedProcess.proc;
        },
        async fetch() {
          return { ok: true } as Response;
        },
        async connectOverCDP() {
          connectCalls += 1;
          return connectedBrowser.browser;
        },
      },
    );

    await runtime.start();

    assert.equal(spawnCalls, 1);
    assert.equal(connectCalls, 0);
    assert.equal(runtime.isRunning(), true);

    const firstBrowser = await runtime.getBrowser();
    const secondBrowser = await runtime.getBrowser();

    assert.equal(firstBrowser, connectedBrowser.browser);
    assert.equal(secondBrowser, connectedBrowser.browser);
    assert.equal(connectCalls, 1);

    await runtime.stop();
    assert.equal(connectedBrowser.getCloseCalls(), 1);
    assert.equal(managedProcess.getKillCalls(), 1);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("managed-cdp stop terminates the launched browser even before first attach", async () => {
  const userDataDir = makeTmpUserDataDir();
  try {
    const managedProcess = createManagedProcessState();
    let spawnCalls = 0;
    let connectCalls = 0;

    const runtime = new BrowserRuntime(
      BrowserRuntimeConfigSchema.parse({
        mode: "managed-cdp",
        userDataDir,
      }),
      {
        spawn() {
          spawnCalls += 1;
          return managedProcess.proc;
        },
        async fetch() {
          return { ok: true } as Response;
        },
        async connectOverCDP() {
          connectCalls += 1;
          throw new Error("connectOverCDP should not be called");
        },
      },
    );

    await runtime.start();
    await runtime.stop();

    assert.equal(spawnCalls, 1);
    assert.equal(connectCalls, 0);
    assert.equal(managedProcess.getKillCalls(), 1);
    assert.equal(runtime.isRunning(), false);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("managed-cdp can inspect pages via native CDP without attaching Playwright", async () => {
  const userDataDir = makeTmpUserDataDir();
  try {
    const managedProcess = createManagedProcessState();
    let connectCalls = 0;
    const fetchCalls: FetchCall[] = [];

    const runtime = new BrowserRuntime(
      BrowserRuntimeConfigSchema.parse({
        mode: "managed-cdp",
        userDataDir,
        cdpPort: 9333,
      }),
      {
        spawn() {
          return managedProcess.proc;
        },
        async fetch(input, init) {
          const url = String(input);
          fetchCalls.push({
            url,
            method: init?.method ?? "GET",
          });

          if (url === "http://127.0.0.1:9333/json/version") {
            return createResponse("{}");
          }
          if (url === "http://127.0.0.1:9333/json/list") {
            return createResponse(
              JSON.stringify([
                {
                  id: "target-boss",
                  type: "page",
                  title: "BOSS直聘",
                  url: "https://www.zhipin.com/web/chat/index",
                  webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/target-boss",
                },
                {
                  id: "target-worker",
                  type: "worker",
                  title: "worker",
                  url: "devtools://worker",
                },
              ]),
            );
          }

          throw new Error(`Unexpected fetch URL: ${url}`);
        },
        async connectOverCDP() {
          connectCalls += 1;
          throw new Error("connectOverCDP should not be called");
        },
      },
    );

    await runtime.start();
    const pages = await runtime.listNativePages();

    assert.deepEqual(pages, [
      {
        targetId: "target-boss",
        type: "page",
        title: "BOSS直聘",
        url: "https://www.zhipin.com/web/chat/index",
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/target-boss",
      },
    ]);
    assert.equal(connectCalls, 0);
    assert.deepEqual(fetchCalls, [
      {
        url: "http://127.0.0.1:9333/json/version",
        method: "GET",
      },
      {
        url: "http://127.0.0.1:9333/json/list",
        method: "GET",
      },
    ]);

    await runtime.stop();
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("managed-cdp can open and activate tabs via native CDP without attaching Playwright", async () => {
  const userDataDir = makeTmpUserDataDir();
  try {
    const managedProcess = createManagedProcessState();
    let connectCalls = 0;
    const fetchCalls: FetchCall[] = [];

    const runtime = new BrowserRuntime(
      BrowserRuntimeConfigSchema.parse({
        mode: "managed-cdp",
        userDataDir,
        cdpPort: 9444,
      }),
      {
        spawn() {
          return managedProcess.proc;
        },
        async fetch(input, init) {
          const url = String(input);
          fetchCalls.push({
            url,
            method: init?.method ?? "GET",
          });

          if (url === "http://127.0.0.1:9444/json/version") {
            return createResponse("{}");
          }
          if (url === "http://127.0.0.1:9444/json/activate/target-boss") {
            return createResponse(JSON.stringify({}));
          }
          if (url === "http://127.0.0.1:9444/json/new?https%3A%2F%2Fwww.zhipin.com") {
            return createResponse(
              JSON.stringify({
                id: "target-new",
                type: "page",
                title: "BOSS直聘",
                url: "https://www.zhipin.com",
              }),
            );
          }

          throw new Error(`Unexpected fetch URL: ${url}`);
        },
        async connectOverCDP() {
          connectCalls += 1;
          throw new Error("connectOverCDP should not be called");
        },
      },
    );

    await runtime.start();
    await runtime.activateNativePage("target-boss");
    await runtime.openNativePage("https://www.zhipin.com");

    assert.equal(connectCalls, 0);
    assert.deepEqual(fetchCalls, [
      {
        url: "http://127.0.0.1:9444/json/version",
        method: "GET",
      },
      {
        url: "http://127.0.0.1:9444/json/activate/target-boss",
        method: "GET",
      },
      {
        url: "http://127.0.0.1:9444/json/new?https%3A%2F%2Fwww.zhipin.com",
        method: "PUT",
      },
    ]);

    await runtime.stop();
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("managed-cdp can connect a native page WebSocket without attaching Playwright", async () => {
  const userDataDir = makeTmpUserDataDir();
  try {
    const managedProcess = createManagedProcessState();
    let connectOverCdpCalls = 0;
    let nativeConnectCalls = 0;
    const fetchCalls: FetchCall[] = [];
    const connectedController = {} as NativeCdpController;

    const runtime = new BrowserRuntime(
      BrowserRuntimeConfigSchema.parse({
        mode: "managed-cdp",
        userDataDir,
        cdpPort: 9555,
      }),
      {
        spawn() {
          return managedProcess.proc;
        },
        async fetch(input, init) {
          const url = String(input);
          fetchCalls.push({
            url,
            method: init?.method ?? "GET",
          });

          if (url === "http://127.0.0.1:9555/json/version") {
            return createResponse("{}");
          }
          if (url === "http://127.0.0.1:9555/json/list") {
            return createResponse(
              JSON.stringify([
                {
                  id: "target-boss",
                  type: "page",
                  title: "BOSS直聘",
                  url: "https://www.zhipin.com/web/chat/index",
                  webSocketDebuggerUrl: "ws://127.0.0.1:9555/devtools/page/target-boss",
                },
              ]),
            );
          }

          throw new Error(`Unexpected fetch URL: ${url}`);
        },
        async connectOverCDP() {
          connectOverCdpCalls += 1;
          throw new Error("connectOverCDP should not be called");
        },
        async connectNativePage(options) {
          nativeConnectCalls += 1;
          assert.equal(
            options.webSocketDebuggerUrl,
            "ws://127.0.0.1:9555/devtools/page/target-boss",
          );
          return connectedController;
        },
      },
    );

    await runtime.start();
    const controller = await runtime.connectNativePage("target-boss");

    assert.equal(controller, connectedController);
    assert.equal(connectOverCdpCalls, 0);
    assert.equal(nativeConnectCalls, 1);
    assert.deepEqual(fetchCalls, [
      {
        url: "http://127.0.0.1:9555/json/version",
        method: "GET",
      },
      {
        url: "http://127.0.0.1:9555/json/list",
        method: "GET",
      },
    ]);

    await runtime.stop();
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
