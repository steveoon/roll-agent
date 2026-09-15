import { isDeepStrictEqual } from "node:util";
import type { StopCondition, ToolSet } from "ai";
import { readToolOutcome, TOOL_OUTCOME_KINDS } from "./normalize-result.ts";
import { SCHEDULE_CREATE_TOOL_ID } from "./schedule-tool.ts";

/** Local to one inference sequence; never blocks repaired inputs or future user turns. */
export function createInvalidScheduleRetryGuard() {
  let message: string | undefined;
  const stop: StopCondition<ToolSet> = ({ steps }) => {
    const invalidInputs: unknown[] = [];
    for (const step of steps) {
      for (const call of step.toolCalls) {
        if (call.toolName !== SCHEDULE_CREATE_TOOL_ID) continue;
        const result = step.toolResults.find((item) => item.toolCallId === call.toolCallId);
        const invalid =
          call.invalid === true ||
          (result !== undefined &&
            readToolOutcome(result.output).kind === TOOL_OUTCOME_KINDS.invalidInput);
        if (!invalid) continue;
        if (invalidInputs.some((input) => isDeepStrictEqual(input, call.input))) {
          message =
            "定时任务参数连续重复出错，已停止本轮自动重试。请按错误提示修正 recurrence；若只指定了开始时间和总轮数，请补充两轮间隔。此前已成功执行的其他操作不会回滚。";
          return true;
        }
        invalidInputs.push(call.input);
      }
    }
    return false;
  };
  return {
    stop,
    get message() {
      return message;
    },
  };
}
