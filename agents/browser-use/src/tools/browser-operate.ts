import { defineTool } from "@roll-agent/sdk";
import { BrowserOperateInputSchema, BrowserOperateOutputSchema } from "../goal/contracts.ts";
import { operateBrowser } from "../goal/host.ts";

export const browserOperate = defineTool({
  name: "browser_operate",
  description:
    "在一次调用内用配置的引擎执行观察→决策→执行循环。读取详情后关闭返回的任务，必须提供 readTask:{target,captureView,outputs,terminal:{view,selectedTab?}}；只声明目标、需要读取的资料名和终点，不声明点击路径。资料原文保存在 progress.evidence，关闭后仍可汇报；interaction_done 始终 verified:false。表单填写提供 formTask:{mode:create或edit,stopAt:applied或current-view,fields:[{name,intent:set,valueName}或{name,intent:preserve}]}；set引用values中唯一名称，preserve只观察不直接写。一次列出本次全部委派字段，由配置的决策引擎选择顺序；内部记录变化与焦点，不逐字段召回宿主。普通填表省略readTask，历史写入不代替当前读回。goal 必须原样保留用户目标，不总结或重新排版。原样复制的文字在 goal 和 values 中都不得增删换行、标点或空格；不要为了分段而改写。默认 task 根据当前页面、必填字段和前置依赖选择动作；编辑入口先打开再观察。values 提供已知事实及已准备文案，输入只复制这些值或 goal 的有限原文片段，不调用宿主生成、逐项检查或恢复助手。缺少匹配资料返回 needs_input；需要写作或转换时由 Roll 准备后补充 values。browser.operate.engine 默认 sampling，使用 Roll 模型；jev 快速模式调用 TypeSafe 官方 /v1/systemone，需 TYPESAFE_API_KEY。engine 输入仅兼容旧调用，不能覆盖配置。fields 保留按完整资料顺序填写。blockedNames 排除禁止控件，只操作已观察元素，不生成脚本。finalObservation 和 resolvedValues 供 Roll 在完成后对照完整原始目标统一验收，必要时补一次定向只读观察，再仅修正错误字段。model_done 始终 verified:false；needs_reasoning 返回上层处理，不能原样无限重试。",
  input: BrowserOperateInputSchema,
  output: BrowserOperateOutputSchema,
  annotations: { destructiveHint: true },
  _meta: { "roll/executionTimeoutMs": 1_205_000 },
  resourceHints: [{ field: "pageId", kind: "browser-session", mode: "write" }],
  execute: async (input, ctx) => operateBrowser(BrowserOperateInputSchema.parse(input), ctx),
});
