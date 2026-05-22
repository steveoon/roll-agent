import { z } from "zod";
import type { AgentContext, AnyToolDefinition } from "@roll-agent/sdk";
import type { Platform } from "@roll-agent/browser";
import { runWithBrowserInstance } from "../browser-instance-pool.ts";
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
        if (shouldStartRuntime) {
          await ensureCurrentBundleStarted();
        }
        return await tool.execute(input, ctx);
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
