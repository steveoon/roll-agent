import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { StructuredToolError, type AgentContext } from "@roll-agent/sdk";
import { setVisualActivityEnabledForTests } from "../visual-activity.ts";
import type {
  NativeResumeStitchProgress,
  ZhipinNativePagePort,
} from "../pages/zhipin/native-page.ts";
import {
  ZHIPIN_ACCESS_RESTRICTED_CODE,
  assertZhipinPageNotRestricted,
  createZhipinAccessRestrictedError,
} from "../pages/zhipin/risk-page.ts";
import {
  setZhipinCaptureResumeDepsForTests,
  zhipinCaptureResume,
} from "./zhipin-capture-resume.ts";

function createTestContext(): AgentContext {
  return {
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
}

type CapturePageOptions = {
  readonly events: string[];
  readonly progressUpdates?: readonly NativeResumeStitchProgress[];
  readonly blank?: boolean;
  readonly inspectPage?: {
    readonly url: string;
    readonly title: string;
  };
};

function createNativePage(options: CapturePageOptions): ZhipinNativePagePort {
  return {
    async evaluateJson(expression: string) {
      if (expression.includes('"mode":"clear"')) {
        options.events.push("visual-clear");
      } else if (expression.includes("正在读取简历")) {
        options.events.push(`visual-label:${extractLabel(expression)}`);
      } else if (expression.includes("简历读取完成")) {
        options.events.push("visual-succeed");
      } else if (expression.includes("简历读取失败")) {
        options.events.push("visual-fail");
      }
      return true;
    },
    async waitForResumeDialog() {
      return { iframeFound: true, dialogFound: true, canvasReady: true };
    },
    async inspectPage() {
      return {
        targetId: "target-boss",
        type: "page",
        title: options.inspectPage?.title ?? "BOSS直聘",
        url: options.inspectPage?.url ?? "https://www.zhipin.com/web/geek/recommend",
      };
    },
    async assertNotRestricted() {
      assertZhipinPageNotRestricted({
        url: options.inspectPage?.url ?? "https://www.zhipin.com/web/geek/recommend",
        title: options.inspectPage?.title ?? "BOSS直聘",
      });
    },
    async captureResumeCanvas(
      onProgress?: (progress: NativeResumeStitchProgress) => void | Promise<void>,
    ) {
      for (const progress of options.progressUpdates ?? []) {
        await onProgress?.(progress);
      }
      if (options.blank === true) {
        return {
          found: true,
          canvasSize: { width: 800, height: 600 },
          blank: true,
        };
      }
      return {
        found: true,
        canvasSize: { width: 800, height: 600 },
        blank: false,
        dataUrl: "data:image/png;base64,dGVzdA==",
      };
    },
    async readResumeDialogClipArea() {
      return { x: 10, y: 10, width: 400, height: 500 };
    },
    async captureViewportClip() {
      options.events.push("clip");
      return "ZG9tLXNjcmVlbnNob3Q=";
    },
    close() {},
  } as unknown as ZhipinNativePagePort;
}

function extractLabel(expression: string): string {
  const match = /正在读取简历[^"\\]*/u.exec(expression);
  return match?.[0] ?? "";
}

function installDeps(page: ZhipinNativePagePort): void {
  setZhipinCaptureResumeDepsForTests({
    openNativePagePort: async () => page,
    writePngFile: async () => {},
    now: () => 1234,
  });
}

afterEach(() => {
  setVisualActivityEnabledForTests(undefined);
  setZhipinCaptureResumeDepsForTests(undefined);
});

describe("zhipin_capture_resume visual feedback", () => {
  it("renders begin, percent progress, and success labels during stitching", async () => {
    setVisualActivityEnabledForTests(true);
    const events: string[] = [];
    installDeps(
      createNativePage({
        events,
        progressUpdates: [
          { round: 0, scrolledPx: 0, totalPx: 4000 },
          { round: 1, scrolledPx: 1000, totalPx: 4000 },
          { round: 2, scrolledPx: 2000, totalPx: 4000 },
        ],
      }),
    );

    const result = await zhipinCaptureResume.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.equal(result.captureMode, "canvas-data-url");
    assert.deepEqual(events, [
      "visual-label:正在读取简历",
      "visual-label:正在读取简历",
      "visual-label:正在读取简历 25%",
      "visual-label:正在读取简历 50%",
      "visual-succeed",
    ]);
  });

  it("falls back to screen-count labels when total scroll size is unknown", async () => {
    setVisualActivityEnabledForTests(true);
    const events: string[] = [];
    installDeps(
      createNativePage({
        events,
        progressUpdates: [{ round: 0, scrolledPx: 0, totalPx: 0 }],
      }),
    );

    const result = await zhipinCaptureResume.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.ok(events.includes("visual-label:正在读取简历 · 第 1 屏"));
  });

  it("clears the overlay before dom-screenshot capture so it never enters the image", async () => {
    setVisualActivityEnabledForTests(true);
    const events: string[] = [];
    installDeps(createNativePage({ events, blank: true }));

    const result = await zhipinCaptureResume.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.equal(result.captureMode, "dom-screenshot");
    const clearIndex = events.indexOf("visual-clear");
    const clipIndex = events.indexOf("clip");
    assert.ok(clearIndex >= 0, "overlay clear should be rendered");
    assert.ok(clipIndex > clearIndex, "screenshot must happen after overlay clear");
  });

  it("skips visual rendering entirely when visual activity is disabled", async () => {
    setVisualActivityEnabledForTests(false);
    const events: string[] = [];
    installDeps(createNativePage({ events }));

    const result = await zhipinCaptureResume.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.deepEqual(events, []);
  });

  it("returns failure and renders error state when capture throws mid-flow", async () => {
    setVisualActivityEnabledForTests(true);
    const events: string[] = [];
    const page = createNativePage({ events });
    (page as unknown as Record<string, unknown>)["captureResumeCanvas"] = async () => {
      throw new Error("target detached");
    };
    installDeps(page);

    const result = await zhipinCaptureResume.execute({}, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.error, "简历读取失败，请重试");
    assert.ok(events.includes("visual-fail"));
  });

  it("rejects relative outputPath at the input schema", () => {
    const relative = zhipinCaptureResume.input.safeParse({ outputPath: "captures/resume.png" });
    assert.equal(relative.success, false);

    const absolute = zhipinCaptureResume.input.safeParse({ outputPath: "/tmp/resume.png" });
    assert.equal(absolute.success, true);

    const omitted = zhipinCaptureResume.input.safeParse({});
    assert.equal(omitted.success, true);
  });

  it("rethrows zhipin_access_restricted from openNativePagePort instead of asking to retry", async () => {
    setZhipinCaptureResumeDepsForTests({
      openNativePagePort: async () => {
        throw createZhipinAccessRestrictedError({
          kind: "ip_block",
          url: "https://www.zhipin.com/web/passport/zp/403.html?code=31",
          title: "访问受限",
        });
      },
      writePngFile: async () => {
        assert.fail("must not write a screenshot after access restriction");
      },
      now: () => 1234,
    });

    await assert.rejects(
      () => zhipinCaptureResume.execute({}, createTestContext()),
      (error: unknown) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, ZHIPIN_ACCESS_RESTRICTED_CODE);
        assert.doesNotMatch(error.message, /请重试/u);
        return true;
      },
    );
  });

  it("throws zhipin_access_restricted after stitching if the live URL became a risk page", async () => {
    const events: string[] = [];
    installDeps(
      createNativePage({
        events,
        inspectPage: {
          url: "https://www.zhipin.com/web/passport/zp/403.html?code=31",
          title: "访问受限",
        },
      }),
    );

    await assert.rejects(
      () => zhipinCaptureResume.execute({}, createTestContext()),
      (error: unknown) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, ZHIPIN_ACCESS_RESTRICTED_CODE);
        return true;
      },
    );
    assert.equal(events.includes("clip"), false);
  });
});
