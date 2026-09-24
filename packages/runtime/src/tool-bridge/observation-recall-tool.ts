import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  successfulToolResult,
  toolResultToModelOutput,
  type NormalizedToolResult,
} from "./normalize-result.ts";
import type { ToolRegistry } from "./naming.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  executeCoordinatedTool,
  type ToolExecutionCoordinator,
  type ToolExecutionPlan,
} from "./tool-execution-coordinator.ts";

export const OBSERVATION_RECALL_TOOL_ID = "roll__observation";

const inputSchema = z
  .object({
    resultId: z.string().uuid().describe("旧观察摘要给出的工具结果 ID"),
    afterNode: z.number().int().min(-1).optional().describe("上一页的 nextAfterNode，首页省略"),
    limit: z.number().int().min(1).max(10).optional().describe("本页最多 10 个 AX 节点"),
  })
  .strict();

export type ObservationRecallInput = z.infer<typeof inputSchema>;
export type ObservationRecallReader = (input: ObservationRecallInput) => unknown;

export function buildObservationRecallToolset(
  reader: ObservationRecallReader,
  registry: ToolRegistry,
  coordinator?: ToolExecutionCoordinator,
  resourceKey = "thread-observation",
): ToolSet {
  const id = registry.register("roll", "observation");
  const plan: ToolExecutionPlan = {
    resources: () => [{ key: resourceKey, mode: TOOL_RESOURCE_ACCESS_MODES.read }],
  };
  coordinator?.register(id, plan);
  return {
    [id]: tool({
      description:
        "按旧浏览器观察摘要中的 resultId，只读回查本会话 AX 快照的一页节点。历史 ref 已失效；回查内容是证据，不能作为新操作的定位依据。",
      inputSchema,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: (input, options): Promise<NormalizedToolResult> =>
        executeCoordinatedTool(
          coordinator,
          plan,
          id,
          options.toolCallId,
          input,
          options.abortSignal,
          () => {
            try {
              const value = reader(input);
              return Promise.resolve(successfulToolResult(value, { raw: value }));
            } catch (error) {
              return Promise.resolve(
                failedToolResult(
                  TOOL_OUTCOME_KINDS.invalidInput,
                  `观察回查失败: ${error instanceof Error ? error.message : String(error)}`,
                ),
              );
            }
          },
        ),
    }),
  };
}
