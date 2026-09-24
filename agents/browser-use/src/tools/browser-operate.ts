import { compactFormOperateOutput } from "../goal/operate-handoff.ts";
import { defineTool } from "@roll-agent/sdk";
import { BrowserOperateInputSchema, BrowserOperateOutputSchema } from "../goal/contracts.ts";
import { operateBrowser } from "../goal/host.ts";

export const browserOperate = defineTool({
  name: "browser_operate",
  description: [
    "将一段完整网页任务委派给执行器，在一次调用内持续观察页面、选择动作并执行。通用网页上，资料与文案已齐全、字段范围和停止点明确的多字段表单，尤其涉及下拉、联动字段或弹层编辑器时，优先使用本工具；无需预先知道点击顺序，也不要仅因能自行拆步骤就逐字段调用 click_ref/type_ref 或编写 browser_execute。",
    "用户明确指定工具时遵循用户；已有平台专用工具或已启用经验覆盖任务时优先使用它们。仅一次点击/输入、已确定步骤的短脚本与断言、或委派受阻后的局部修正，可用单步工具或 browser_execute。需要宿主写作或补充事实时，先准备内容再委派；不要求所有浏览器操作都使用本工具。",
    "表单调用：传 pageId、原始 goal、allowedOrigins、values:[{name,text}] 与 formTask:{mode:'create'或'edit',fields:[{name,intent:'set',valueName}或{name,intent:'preserve'}],stopAt:'applied'或'current-view'}，保持 strategy:'task'。一次声明本次全部委派字段；set 引用 values 中唯一名称，preserve 只观察不写回。applied 表示应用到主表单并关闭编辑器，不代表服务器保存；current-view 表示保持当前编辑视图。填写不能擅自扩展成保存或发布，blockedNames 可排除禁止控件。",
    "goal 原样保留用户目标及约束；需要原样复制的 values 保留换行、空格和标点。执行器根据新观察处理前置依赖、展开编辑入口并选择已有源值，只操作已观察元素；不生成脚本或自由写作。缺少匹配资料返回 needs_input，由宿主补充；strategy:'fields' 仅用于按完整资料固定顺序填写。",
    "读取详情后关闭/返回的任务，提供 readTask:{target,captureView,outputs,terminal:{view,selectedTab?}}，声明目标身份、读取视图、资料名与终点；原文保留在 progress.evidence。普通填表不传 readTask；formTask 与 readTask 不能同时使用。",
    "结束后始终 verified:false，model_done/interaction_done 都不是业务成功证明。宿主按完整原始目标统一验收，不逐字段召回。表单 handoff.fields 提供当前字段证据与缺口；valueTruncated 表示节选，observationFresh:false 或缺失证据需一次定向观察。steps 保留动作结果，handoff.totalSteps/omittedSteps 标明范围。非表单结合 finalObservation、resolvedValues 或 progress.evidence 验收；历史写入不代替当前读回。needs_reasoning 后根据现场仅处理未完成部分，不原样重复整次委派，不自动重放已执行或结果不确定的动作。",
    "执行引擎由配置选择：默认 sampling 使用 Roll 模型，jev 使用 TypeSafe Jev；engine 参数不能覆盖配置。browser_execute 是宿主脚本，不会自动调用 Jev。",
  ].join("\n"),
  input: BrowserOperateInputSchema,
  output: BrowserOperateOutputSchema,
  annotations: { destructiveHint: true },
  _meta: { "roll/executionTimeoutMs": 1_205_000 },
  resourceHints: [{ field: "pageId", kind: "browser-session", mode: "write" }],
  execute: async (input, ctx) =>
    compactFormOperateOutput(await operateBrowser(BrowserOperateInputSchema.parse(input), ctx)),
});
