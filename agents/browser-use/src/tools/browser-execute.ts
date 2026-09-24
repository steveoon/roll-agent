import { defineTool } from "@roll-agent/sdk";
import { BrowserExecuteInputSchema, BrowserExecuteResultSchema } from "@roll-agent/browser";
import { executeBrowserTool } from "../browser-execution.ts";

export const browserExecute = defineTool({
  name: "browser_execute",
  description: [
    "适合已确定步骤的短脚本、批量输入与断言。资料齐全、范围和停止点明确且需要根据页面变化选择动作的多字段表单，优先委派 browser_operate；本工具只执行宿主脚本，不调用 Jev。遵循用户明确指定的工具。",
    "在指定页面执行受控 JavaScript。page 不是 Playwright；所有调用都需 read capability。文本放 args，通过 page.fill(target,args.text) 输入，保留真实换行。",
    "定位构造器：page.ref(ref,snapshotId)、page.locator(css,{scope?,frameId?})、page.getByRole(role,{name,scope?,frameId?})。返回定位数据，没有 .all()/.count()/.fill() 等方法。",
    "只读：await page.read(target) 返回当前输入值 .value 和可见文案 .text；{attribute} 仅用于 id/name/role/title/placeholder/href/aria-* 白名单，不接受 value。其他只读方法：page.count(target)、page.exists(target)、page.inspectControl(target,{panel?:CSS字符串})、page.observe()、page.snapshot({scope?})。snapshot 不接受 frameId；iframe 表单先用独立 browser_snapshot，再将其 ref/snapshotId 传给 page.ref。",
    "交互：await page.click(target,{expect?})、page.fill(target,text,{expect?})、page.choose(target,{label?,value?,panel?:CSS字符串,expect?})、page.hover(target,{expect?})、page.press(key,{target?,expect?})、page.scroll(target,{dx?,dy?,expect?})。panel 使用 inspectControl 返回的 panelCss，不能传 page.locator 对象；自定义下拉标签用 text 断言，不假设存在 value。例如关闭弹层：await page.press('Escape',{target:field})。",
    "其他：await page.goto(url,{expect?})、page.waitFor(condition,{timeoutMs?})、page.expect(condition)、page.screenshot()。condition 可用 {target,value}、{target,state:'visible'}、{target,text,match:'equals'}。没有 page.url/evaluate、fetch、Node、:visible 或 >> nth= 等 Playwright 语法。",
    "优先使用已有平台专用工具。status=failed 时读取 error/actions，只恢复未执行部分；已执行输入不自动重放。缺少 iframe 控件时不要猜下标或标签，重新调用 browser_snapshot，省略 scope/maxDepth 并使用 interactiveOnly=true。",
  ].join("\n"),
  input: BrowserExecuteInputSchema,
  output: BrowserExecuteResultSchema,
  execute: async (input, ctx) =>
    (await executeBrowserTool(BrowserExecuteInputSchema.parse(input), ctx)).result,
});
