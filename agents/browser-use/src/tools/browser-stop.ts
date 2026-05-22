import { BrowserRuntimeModeSchema } from "@roll-agent/browser";
import { StructuredToolError, defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import {
  BROWSER_INSTANCE_STOP_STATUSES,
  type BrowserInstanceStopResult,
} from "../browser-instance-pool.ts";
import { getBrowserInstancePool } from "../runtime-holder.ts";

const BrowserStopInputSchema = z
  .object({
    browserInstance: z.string().trim().min(1).optional(),
    browserInstances: z.array(z.string().trim().min(1)).min(1).optional(),
    all: z.boolean().optional(),
  })
  .superRefine((input, ctx) => {
    const hasInstance =
      input.browserInstance !== undefined ||
      (input.browserInstances !== undefined && input.browserInstances.length > 0);
    if (input.all && hasInstance) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["all"],
        message: "all cannot be combined with browserInstance or browserInstances",
      });
    }
  });

const BrowserInstanceStopResultSchema = z.object({
  browserInstance: z.string(),
  status: z.enum(BROWSER_INSTANCE_STOP_STATUSES),
  mode: BrowserRuntimeModeSchema.optional(),
  message: z.string().optional(),
});

const BrowserStopOutputSchema = z.object({
  ok: z.boolean(),
  stopped: z.number().int().nonnegative(),
  results: z.array(BrowserInstanceStopResultSchema),
});

type BrowserStopInput = z.infer<typeof BrowserStopInputSchema>;
type BrowserStopOutput = z.infer<typeof BrowserStopOutputSchema>;

export const browserStop = defineTool<BrowserStopInput, BrowserStopOutput>({
  name: "browser_stop",
  description:
    "关闭 browser-use-agent 当前托管的一个、多个或全部浏览器实例；不停止 browser-use-agent 服务进程。",
  input: BrowserStopInputSchema,
  output: BrowserStopOutputSchema,
  execute: async (input, ctx) => {
    const instancePool = getBrowserInstancePool();
    const availableInstances = instancePool.listBundles().map((bundle) => bundle.id);
    const targets = resolveBrowserStopTargets(input, availableInstances);

    ctx.logger.info(`Stopping browser instances: ${targets.join(", ")}`);

    const results = await instancePool.closeInstances(targets);
    return createBrowserStopOutput(results);
  },
});

export function resolveBrowserStopTargets(
  input: BrowserStopInput,
  availableInstances: readonly string[],
): readonly string[] {
  if (input.all === true) {
    return availableInstances;
  }

  const targets = [
    ...(input.browserInstance !== undefined ? [input.browserInstance] : []),
    ...(input.browserInstances ?? []),
  ];
  const uniqueTargets = [...new Set(targets)];
  if (uniqueTargets.length === 0) {
    throw new StructuredToolError({
      code: "needs_input",
      message: "browserInstance, browserInstances, or all is required.",
      details: {
        availableInstances,
      },
    });
  }

  return uniqueTargets;
}

export function createBrowserStopOutput(
  results: readonly BrowserInstanceStopResult[],
): BrowserStopOutput {
  return {
    ok: results.every((result) => result.status !== "not_found" && result.status !== "failed"),
    stopped: results.filter((result) => result.status === "stopped").length,
    results: [...results],
  };
}
