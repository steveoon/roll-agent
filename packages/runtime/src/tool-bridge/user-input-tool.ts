import { tool, type ToolSet } from "ai";
import {
  userInputFormSchema,
  type UserInputForm,
  type UserInputResult,
} from "@roll-agent/protocol";
import type { ToolRegistry } from "./naming.ts";
import {
  successfulToolResult,
  toolResultToModelOutput,
  type NormalizedToolResult,
} from "./normalize-result.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  executeCoordinatedTool,
  type ToolExecutionCoordinator,
  type ToolExecutionPlan,
} from "./tool-execution-coordinator.ts";

export const USER_INPUT_TOOL_AGENT_NAME = "roll";
export const USER_INPUT_TOOL_NAME = "user_input";

export interface UserInputToolContext {
  readonly sessionId: string;
  isAvailable(): boolean;
  request(form: UserInputForm, abortSignal: AbortSignal | undefined): Promise<UserInputResult>;
}

export interface BuiltUserInputTool {
  readonly id: string;
  readonly tools: ToolSet;
}

function resultForModel(result: UserInputResult): NormalizedToolResult {
  const display =
    result.status === "submitted"
      ? {
          status: result.status,
          submittedControlIds: result.values.map((entry) => entry.id),
        }
      : { status: result.status };
  return successfulToolResult(display, {
    raw: result,
    model: { type: "json", value: result },
  });
}

function unavailableResult(): NormalizedToolResult {
  return resultForModel({
    status: "cancelled",
    reason: "当前客户端不再支持用户输入请求",
  });
}

export function buildUserInputTool(
  context: UserInputToolContext,
  registry: ToolRegistry,
  coordinator: ToolExecutionCoordinator,
): BuiltUserInputTool {
  const id = registry.register(USER_INPUT_TOOL_AGENT_NAME, USER_INPUT_TOOL_NAME, {
    annotations: { readOnlyHint: true },
  });
  const plan: ToolExecutionPlan = {
    prepare: () => (context.isAvailable() ? undefined : unavailableResult()),
    resources: () => [
      {
        key: `session:${context.sessionId}:user-input`,
        mode: TOOL_RESOURCE_ACCESS_MODES.write,
      },
    ],
    revalidateExecution: () => (context.isAvailable() ? undefined : unavailableResult()),
  };
  coordinator.register(id, plan);
  return {
    id,
    tools: {
      [id]: tool({
        description:
          "向用户展示一个结构化表单，仅用于补充完成当前任务所必需且无法从上下文推断的信息。不得请求密码、令牌、密钥或其他敏感凭证。",
        inputSchema: userInputFormSchema,
        toModelOutput: ({ output }) => toolResultToModelOutput(output),
        execute: async (input, options): Promise<NormalizedToolResult> =>
          executeCoordinatedTool(
            coordinator,
            plan,
            id,
            options.toolCallId,
            input,
            options.abortSignal,
            async () =>
              context.isAvailable()
                ? resultForModel(await context.request(input, options.abortSignal))
                : unavailableResult(),
          ),
      }),
    },
  };
}
