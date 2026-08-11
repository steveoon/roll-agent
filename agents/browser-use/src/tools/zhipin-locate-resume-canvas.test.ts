import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import {
  setZhipinLocateResumeCanvasDepsForTests,
  zhipinLocateResumeCanvas,
} from "./zhipin-locate-resume-canvas.ts";

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

type LocatePageOptions = {
  readonly canvasReady?: boolean;
  readonly throwOnGeometry?: Error;
  readonly calls: string[];
};

function createNativePage(options: LocatePageOptions): ZhipinNativePagePort {
  return {
    async waitForResumeDialog() {
      options.calls.push("waitForResumeDialog");
      return {
        iframeFound: true,
        dialogVisible: true,
        iframeVisible: true,
        canvasReady: options.canvasReady ?? true,
      };
    },
    async readResumeCanvasGeometry() {
      options.calls.push("readResumeCanvasGeometry");
      if (options.throwOnGeometry !== undefined) {
        throw options.throwOnGeometry;
      }
      return {
        found: true,
        screenshotArea: { x: 120, y: 80, width: 760, height: 540 },
        canvasSize: { width: 1520, height: 1080 },
      };
    },
    async captureResumeCanvas() {
      options.calls.push("captureResumeCanvas");
      return { found: false, error: "should not run full capture" };
    },
    close() {},
  } as unknown as ZhipinNativePagePort;
}

afterEach(() => {
  setZhipinLocateResumeCanvasDepsForTests(undefined);
});

describe("zhipin_locate_resume_canvas", () => {
  it("reads geometry without running the full scroll-stitch capture", async () => {
    const calls: string[] = [];
    setZhipinLocateResumeCanvasDepsForTests({
      openNativePagePort: async () => createNativePage({ calls }),
    });

    const result = await zhipinLocateResumeCanvas.execute({}, createTestContext());

    assert.equal(result.success, true);
    assert.deepEqual(result.screenshotArea, { x: 120, y: 80, width: 760, height: 540 });
    assert.deepEqual(result.canvasInfo, { width: 1520, height: 1080 });
    assert.deepEqual(calls, ["waitForResumeDialog", "readResumeCanvasGeometry"]);
  });

  it("reports a structured error when the canvas is not ready in time", async () => {
    const calls: string[] = [];
    setZhipinLocateResumeCanvasDepsForTests({
      openNativePagePort: async () => createNativePage({ calls, canvasReady: false }),
    });

    const result = await zhipinLocateResumeCanvas.execute({}, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.error, "简历 canvas 未加载完成，请稍后重试");
  });

  it("converts unexpected throws into a structured failure payload", async () => {
    const calls: string[] = [];
    setZhipinLocateResumeCanvasDepsForTests({
      openNativePagePort: async () =>
        createNativePage({ calls, throwOnGeometry: new Error("cdp detached") }),
    });

    const result = await zhipinLocateResumeCanvas.execute({}, createTestContext());

    assert.equal(result.success, false);
    assert.equal(result.error, "定位简历 canvas 失败");
  });
});
