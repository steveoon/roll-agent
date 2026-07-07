import { z } from "zod";
import type { AgentContext, AnyToolDefinition } from "@roll-agent/sdk";
import type { Platform } from "@roll-agent/browser";
import { runWithBrowserInstance } from "../browser-instance-pool.ts";
import { withBrowserInstanceLock } from "../browser-instance-lock.ts";
import { ensureCurrentBundleStarted, getBrowserInstancePool } from "../runtime-holder.ts";
import {
  assertBrowserInstancePlatform,
  readPlatformFromToolInput,
} from "./browser-instance-platform.ts";

const BrowserInstanceInputSchema = {
  browserInstance: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("可选 browser instance id；多浏览器实例时用于选择目标 profile/CDP runtime。"),
};

type BrowserInstanceInput = {
  readonly browserInstance?: string;
};

export interface BrowserInstanceToolOptions {
  readonly startRuntime?: boolean;
  readonly expectedPlatform?: Platform;
  /**
   * 是否对同一 browserInstance 的执行做互斥串行（默认 true）。
   *
   * 页面操作工具共享同一实例的页面状态，并行调用会互相踩踏，必须排队；
   * page-free / 只读诊断工具（browser_status、list_pages 等）应显式传 false，
   * 保证"检查实例是否卡死"这类排障出口不被锁挡住。
   */
  readonly serializePageOps?: boolean;
}

export function inferExpectedPlatformFromToolName(toolName: string): Platform | undefined {
  if (toolName.startsWith("zhipin_")) {
    return "zhipin";
  }
  if (toolName.startsWith("yupao_")) {
    return "yupao";
  }
  return undefined;
}

export function withBrowserInstanceInput(
  tool: AnyToolDefinition,
  options: BrowserInstanceToolOptions = {},
): AnyToolDefinition {
  const inputSchema = extendBrowserInstanceInput(tool.input);
  if (inputSchema === undefined) {
    return tool;
  }

  const shouldStartRuntime = options.startRuntime ?? true;
  const shouldSerializePageOps = options.serializePageOps ?? true;
  const expectedPlatform = options.expectedPlatform ?? inferExpectedPlatformFromToolName(tool.name);

  return {
    ...tool,
    input: inputSchema,
    execute: async (input: never, ctx: AgentContext): Promise<unknown> => {
      const browserInput = input as BrowserInstanceInput;
      return await runWithBrowserInstance(browserInput.browserInstance, async () => {
        if (browserInput.browserInstance !== undefined) {
          getBrowserInstancePool().getBundle();
        }
        assertBrowserInstancePlatform(resolvePlatformConstraint(input, expectedPlatform));

        const runTool = async (): Promise<unknown> => {
          if (shouldStartRuntime) {
            await ensureCurrentBundleStarted();
          }
          return await tool.execute(input, ctx);
        };

        if (!shouldSerializePageOps) {
          return await runTool();
        }

        const instanceId = getBrowserInstancePool().getBundle().id;
        return await withBrowserInstanceLock(instanceId, runTool, {
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          onWait: (waitedMs) => {
            ctx.logger.info(
              `${tool.name} waited ${Math.round(waitedMs)}ms for an in-flight operation on ` +
                `browser instance "${instanceId}" (same-instance page operations are serialized)`,
            );
          },
        });
      });
    },
  };
}

function resolvePlatformConstraint(
  input: unknown,
  expectedPlatform: Platform | undefined,
): Platform | undefined {
  const inputPlatform = readPlatformFromToolInput(input);
  return expectedPlatform ?? inputPlatform;
}

function extendBrowserInstanceInput(schema: z.ZodType): z.ZodType | undefined {
  if (schema instanceof z.ZodObject) {
    return schema.extend(BrowserInstanceInputSchema);
  }

  if (schema instanceof z.ZodEffects) {
    const extendedInner = extendBrowserInstanceInput(schema.innerType());
    if (extendedInner === undefined) {
      return undefined;
    }

    // Preserve root-level refine/superRefine contracts while exposing browserInstance to MCP.
    const effect = schema._def.effect;
    if (effect.type === "preprocess") {
      return z.ZodEffects.createWithPreprocess(effect.transform, extendedInner, schema._def);
    }

    return z.ZodEffects.create(extendedInner, effect, schema._def);
  }

  return undefined;
}
