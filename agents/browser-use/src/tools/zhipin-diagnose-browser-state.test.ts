import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { BrowserContextManager, BrowserRuntime } from "@roll-agent/browser";
import type { AgentContext } from "@roll-agent/sdk";
import { setRuntimeStateForTests } from "../runtime-holder.ts";
import {
  diffStorageCounters,
  summarizeCookie,
  summarizeStorageEntry,
  zhipinDiagnoseBrowserState,
} from "./zhipin-diagnose-browser-state.ts";

const testContext: AgentContext = {
  llm: {
    generateText: async () => "",
  },
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
};

afterEach(() => {
  setRuntimeStateForTests({});
});

describe("zhipin_diagnose_browser_state", () => {
  it("defaults to the native phase", () => {
    const input = zhipinDiagnoseBrowserState.input.parse({});

    assert.equal(input.phase, "native");
    assert.equal(input.watchMs, 3_000);
    assert.equal(input.networkEventLimit, 30);
  });

  it("accepts native CDP diagnostic phases", () => {
    assert.equal(
      zhipinDiagnoseBrowserState.input.parse({ phase: "native-ws-connect" }).phase,
      "native-ws-connect",
    );
    assert.equal(
      zhipinDiagnoseBrowserState.input.parse({ phase: "native-page-bring-front" }).phase,
      "native-page-bring-front",
    );
    assert.equal(
      zhipinDiagnoseBrowserState.input.parse({
        phase: "native-evaluate-url-no-runtime-enable",
      }).phase,
      "native-evaluate-url-no-runtime-enable",
    );
    assert.equal(
      zhipinDiagnoseBrowserState.input.parse({
        phase: "native-dom-read-no-runtime-enable",
      }).phase,
      "native-dom-read-no-runtime-enable",
    );
    assert.equal(
      zhipinDiagnoseBrowserState.input.parse({
        phase: "native-input-move-no-runtime-enable",
      }).phase,
      "native-input-move-no-runtime-enable",
    );
    assert.equal(
      zhipinDiagnoseBrowserState.input.parse({ phase: "native-runtime-enable" }).phase,
      "native-runtime-enable",
    );
    assert.equal(
      zhipinDiagnoseBrowserState.input.parse({ phase: "native-evaluate-url" }).phase,
      "native-evaluate-url",
    );
    assert.equal(
      zhipinDiagnoseBrowserState.input.parse({ phase: "native-dom-read" }).phase,
      "native-dom-read",
    );
  });

  it("summarizes security counters without returning raw storage values", () => {
    const summary = summarizeStorageEntry("localStorage", {
      key: "_ZP_CNT_",
      value: JSON.stringify({
        input_count: 6,
        keyboard_abnormal_count: 2,
        has_seen_prompt: true,
        recent: [1, 2, 3],
      }),
    });

    assert.equal(summary.valueKind, "json");
    assert.equal(summary.jsonKind, "object");
    assert.equal(summary.numericFields?.["input_count"], 6);
    assert.equal(summary.numericFields?.["keyboard_abnormal_count"], 2);
    assert.equal(summary.booleanFields?.["has_seen_prompt"], true);
    assert.equal(summary.arrayLengths?.["recent"], 3);

    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes("[1,2,3]"), false);
  });

  it("summarizes generic arrays by shape only", () => {
    const summary = summarizeStorageEntry("localStorage", {
      key: "_Search_History",
      value: JSON.stringify(["raw search keyword"]),
    });

    assert.equal(summary.valueKind, "json");
    assert.equal(summary.jsonKind, "array");
    assert.equal(summary.jsonArrayLength, 1);
    assert.equal(JSON.stringify(summary).includes("raw search keyword"), false);
  });

  it("summarizes cookies without returning cookie values", () => {
    const summary = summarizeCookie({
      name: "wt2",
      value: "secret-token-value",
      domain: ".zhipin.com",
      path: "/",
      expires: 1_777_017_600,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    });

    assert.deepEqual(summary, {
      name: "wt2",
      domain: ".zhipin.com",
      path: "/",
      expires: "2026-04-24T08:00:00.000Z",
      valueLength: 18,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    });
    assert.equal(JSON.stringify(summary).includes("secret-token-value"), false);
  });

  it("diffs security counter summaries without exposing raw values", () => {
    const before = [
      summarizeStorageEntry("localStorage", {
        key: "_ZP_CNT_",
        value: JSON.stringify({
          input_count: 1,
          keyboard_abnormal_count: 0,
          has_seen_prompt: false,
          recent: [1],
        }),
      }),
    ];
    const after = [
      summarizeStorageEntry("localStorage", {
        key: "_ZP_CNT_",
        value: JSON.stringify({
          input_count: 3,
          keyboard_abnormal_count: 0,
          has_seen_prompt: true,
          recent: [1, 2, 3],
          new_metric: 4,
        }),
      }),
      summarizeStorageEntry("sessionStorage", {
        key: "_AEG_CNT",
        value: JSON.stringify({
          attach_count: 1,
        }),
      }),
    ];

    const diffs = diffStorageCounters(before, after);

    assert.deepEqual(diffs, [
      {
        area: "localStorage",
        key: "_ZP_CNT_",
        beforePresent: true,
        afterPresent: true,
        numericDeltas: {
          input_count: { before: 1, after: 3, delta: 2 },
          new_metric: { after: 4 },
        },
        booleanChanges: {
          has_seen_prompt: { before: false, after: true },
        },
        arrayLengthDeltas: {
          recent: { before: 1, after: 3, delta: 2 },
        },
      },
      {
        area: "sessionStorage",
        key: "_AEG_CNT",
        beforePresent: false,
        afterPresent: true,
        numericDeltas: {
          attach_count: { after: 1 },
        },
      },
    ]);
    assert.equal(JSON.stringify(diffs).includes("[1,2,3]"), false);
  });

  it("accepts a native-only diagnostic output", () => {
    const parsed = zhipinDiagnoseBrowserState.output.parse({
      success: true,
      requestedPhase: "native",
      mode: "managed-cdp",
      nativePages: [
        {
          pageId: "target-1",
          url: "https://www.zhipin.com/web/chat/index",
          title: "BOSS直聘",
          boundPlatform: null,
          detectedPlatform: "zhipin",
          isSelectedForPlatform: false,
        },
      ],
      browserAttached: false,
      pageAttached: false,
      nativeTimeline: [],
      phases: [{ phase: "native", success: true, durationMs: 3 }],
      warnings: [],
    });

    assert.equal(parsed.nativePages[0]?.detectedPlatform, "zhipin");
  });

  it("accepts browser-attach watch URL change diagnostics", () => {
    const parsed = zhipinDiagnoseBrowserState.output.parse({
      success: false,
      requestedPhase: "browser-attach",
      mode: "managed-cdp",
      nativePages: [],
      browserAttached: true,
      pageAttached: false,
      nativeTimeline: [
        {
          phase: "native",
          capturedAt: "2026-04-24T00:00:00.000Z",
          targetFound: true,
          page: {
            pageId: "target-1",
            url: "https://www.zhipin.com/web/chat/index",
            title: "BOSS直聘",
            boundPlatform: null,
            detectedPlatform: "zhipin",
            isSelectedForPlatform: true,
          },
          urlChangedFromPrevious: false,
          titleChangedFromPrevious: false,
          currentUrl: "https://www.zhipin.com/web/chat/index",
          currentTitle: "BOSS直聘",
        },
        {
          phase: "browser-attach-watch",
          capturedAt: "2026-04-24T00:00:00.500Z",
          targetFound: true,
          page: {
            pageId: "target-1",
            url: "https://www.zhipin.com/shanghai/",
            title: "BOSS直聘",
            boundPlatform: null,
            detectedPlatform: "zhipin",
            isSelectedForPlatform: true,
          },
          urlChangedFromPrevious: true,
          titleChangedFromPrevious: false,
          previousUrl: "https://www.zhipin.com/web/chat/index",
          currentUrl: "https://www.zhipin.com/shanghai/",
          previousTitle: "BOSS直聘",
          currentTitle: "BOSS直聘",
        },
      ],
      phases: [
        { phase: "native", success: true, durationMs: 3 },
        { phase: "browser-attach", success: true, durationMs: 28 },
      ],
      warnings: [
        "Browser attach was followed by a native URL change; treat this account/browser profile as unsafe for Playwright-backed zhipin tools.",
      ],
    });

    assert.equal(parsed.success, false);
    assert.equal(parsed.nativeTimeline[1]?.phase, "browser-attach-watch");
    assert.equal(parsed.nativeTimeline[1]?.urlChangedFromPrevious, true);
  });

  it("accepts native CDP probe diagnostics", () => {
    const parsed = zhipinDiagnoseBrowserState.output.parse({
      success: true,
      requestedPhase: "native-dom-read",
      mode: "managed-cdp",
      nativePages: [],
      browserAttached: false,
      pageAttached: false,
      nativeTimeline: [
        {
          phase: "native-evaluate-url-watch",
          capturedAt: "2026-04-24T00:00:00.500Z",
          targetFound: true,
          page: {
            pageId: "target-1",
            url: "https://www.zhipin.com/web/chat/index",
            title: "BOSS直聘",
            boundPlatform: null,
            detectedPlatform: "zhipin",
            isSelectedForPlatform: true,
          },
          urlChangedFromPrevious: false,
          titleChangedFromPrevious: false,
          currentUrl: "https://www.zhipin.com/web/chat/index",
          currentTitle: "BOSS直聘",
        },
      ],
      nativeCdp: {
        targetId: "target-1",
        websocketUrlAvailable: true,
        connected: true,
        runtimeEnabled: true,
        evaluate: {
          url: "https://www.zhipin.com/web/chat/index",
          title: "BOSS直聘",
          visibilityState: "visible",
          hasFocus: true,
        },
        dom: {
          rootNodeId: 1,
          rootNodeName: "#document",
          childNodeCount: 2,
          bodyTextLength: 120,
          elementCount: 42,
        },
      },
      phases: [
        { phase: "native", success: true, durationMs: 3 },
        { phase: "native-ws-connect", success: true, durationMs: 5 },
        { phase: "native-runtime-enable", success: true, durationMs: 2 },
        { phase: "native-evaluate-url", success: true, durationMs: 2 },
        { phase: "native-dom-read", success: true, durationMs: 4 },
      ],
      warnings: [],
    });

    assert.equal(parsed.requestedPhase, "native-dom-read");
    assert.equal(parsed.browserAttached, false);
    assert.equal(parsed.pageAttached, false);
    assert.equal(parsed.nativeCdp?.connected, true);
    assert.equal(parsed.nativeCdp?.dom?.elementCount, 42);
  });

  it("accepts native CDP no-runtime probe diagnostics", () => {
    const parsed = zhipinDiagnoseBrowserState.output.parse({
      success: true,
      requestedPhase: "native-input-move-no-runtime-enable",
      mode: "managed-cdp",
      nativePages: [],
      browserAttached: false,
      pageAttached: false,
      nativeTimeline: [
        {
          phase: "native-input-move-no-runtime-enable-watch",
          capturedAt: "2026-04-24T00:00:00.500Z",
          targetFound: true,
          page: {
            pageId: "target-1",
            url: "https://www.zhipin.com/web/chat/index",
            title: "BOSS直聘",
            boundPlatform: null,
            detectedPlatform: "zhipin",
            isSelectedForPlatform: true,
          },
          urlChangedFromPrevious: false,
          titleChangedFromPrevious: false,
          currentUrl: "https://www.zhipin.com/web/chat/index",
          currentTitle: "BOSS直聘",
        },
      ],
      nativeCdp: {
        targetId: "target-1",
        websocketUrlAvailable: true,
        connected: true,
        input: {
          type: "mouseMoved",
          x: 0,
          y: 0,
        },
      },
      phases: [
        { phase: "native", success: true, durationMs: 3 },
        { phase: "native-ws-connect", success: true, durationMs: 5 },
        { phase: "native-input-move-no-runtime-enable", success: true, durationMs: 2 },
      ],
      warnings: [],
    });

    assert.equal(parsed.browserAttached, false);
    assert.equal(parsed.pageAttached, false);
    assert.equal(parsed.nativeCdp?.runtimeEnabled, undefined);
    assert.equal(parsed.nativeCdp?.input?.type, "mouseMoved");
  });

  it("keeps native diagnostics read-only and does not remember page selection", async () => {
    let rememberCalls = 0;
    const contextManager = {
      async listNativePages() {
        return [
          {
            targetId: "target-1",
            type: "page",
            url: "https://www.zhipin.com/web/chat/index",
            title: "BOSS直聘",
          },
        ];
      },
      getBoundPlatformForNativePage() {
        return undefined;
      },
      isNativePageSelected() {
        return false;
      },
      rememberNativePageSelection() {
        rememberCalls += 1;
      },
    } as unknown as BrowserContextManager;
    const runtime = {
      mode: "managed-cdp",
      async getBrowser() {
        throw new Error("native diagnostics should not attach browser");
      },
    } as unknown as BrowserRuntime;
    setRuntimeStateForTests({ runtime, contextManager });

    const result = await zhipinDiagnoseBrowserState.execute(
      zhipinDiagnoseBrowserState.input.parse({}),
      testContext,
    );

    assert.equal(result.success, true);
    assert.equal(rememberCalls, 0);
    assert.equal(result.targetPage?.pageId, "target-1");
    assert.equal(result.targetPage?.isSelectedForPlatform, false);
  });

  it("native CDP diagnostics do not fall back to Playwright browser attach", async () => {
    let getBrowserCalls = 0;
    const contextManager = {
      async listNativePages() {
        return [
          {
            targetId: "target-1",
            type: "page",
            url: "https://www.zhipin.com/web/chat/index",
            title: "BOSS直聘",
          },
        ];
      },
      getBoundPlatformForNativePage() {
        return undefined;
      },
      isNativePageSelected() {
        return false;
      },
      rememberNativePageSelection() {
        throw new Error("native CDP diagnostics should not remember page selection");
      },
    } as unknown as BrowserContextManager;
    const runtime = {
      mode: "managed-cdp",
      async getBrowser() {
        getBrowserCalls += 1;
        throw new Error("native CDP diagnostics should not browser-attach");
      },
    } as unknown as BrowserRuntime;
    setRuntimeStateForTests({ runtime, contextManager });

    const result = await zhipinDiagnoseBrowserState.execute(
      zhipinDiagnoseBrowserState.input.parse({
        phase: "native-ws-connect",
        watchMs: 500,
      }),
      testContext,
    );

    assert.equal(result.success, false);
    assert.equal(result.browserAttached, false);
    assert.equal(result.pageAttached, false);
    assert.equal(result.nativeCdp?.websocketUrlAvailable, false);
    assert.equal(result.nativeCdp?.connected, false);
    assert.equal(getBrowserCalls, 0);
    assert.equal(result.phases[1]?.phase, "native-ws-connect");
    assert.equal(result.phases[1]?.success, false);
    assert.match(result.phases[1]?.error ?? "", /webSocketDebuggerUrl/);
  });

  it("does not browser-attach when the target zhipin page is ambiguous", async () => {
    let getBrowserCalls = 0;
    const contextManager = {
      async listNativePages() {
        return [
          {
            targetId: "target-1",
            type: "page",
            url: "https://www.zhipin.com/web/chat/index",
            title: "BOSS直聘",
          },
          {
            targetId: "target-2",
            type: "page",
            url: "https://www.zhipin.com/web/chat/recommend",
            title: "BOSS直聘",
          },
        ];
      },
      getBoundPlatformForNativePage() {
        return undefined;
      },
      isNativePageSelected() {
        return false;
      },
      rememberNativePageSelection() {
        throw new Error("ambiguous diagnostics should not remember page selection");
      },
    } as unknown as BrowserContextManager;
    const runtime = {
      mode: "managed-cdp",
      async getBrowser() {
        getBrowserCalls += 1;
        throw new Error("ambiguous diagnostics should not attach browser");
      },
    } as unknown as BrowserRuntime;
    setRuntimeStateForTests({ runtime, contextManager });

    const result = await zhipinDiagnoseBrowserState.execute(
      zhipinDiagnoseBrowserState.input.parse({ phase: "browser-attach" }),
      testContext,
    );

    assert.equal(result.success, false);
    assert.equal(result.browserAttached, false);
    assert.equal(getBrowserCalls, 0);
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0]?.phase, "native");
    assert.equal(result.phases[0]?.success, true);
    assert.match(result.warnings.join("\n"), /Multiple zhipin native pages/);
  });
});
