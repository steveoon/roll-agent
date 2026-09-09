import { defineTool } from "@roll-agent/sdk";
import { BrowserExecuteInputSchema, BrowserExecuteResultSchema } from "@roll-agent/browser";
import { executeBrowserTool } from "../browser-execution.ts";

export const browserExecute = defineTool({
  name: "browser_execute",
  description:
    "在单个明确页面执行受控 JavaScript：只使用 page helpers，支持组合操作、条件、循环与结果断言。陌生单选控件可先 page.inspectControl(field)，再 page.choose(field,{label})；iframe 定位保留 frameId 或使用严格 ref。优先使用已有 zhipin_* 等专用工具。失败返回已执行步骤，不自动重放。",
  input: BrowserExecuteInputSchema,
  output: BrowserExecuteResultSchema,
  execute: async (input, ctx) =>
    (await executeBrowserTool(BrowserExecuteInputSchema.parse(input), ctx)).result,
});
