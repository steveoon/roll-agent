import { defineTool } from "@roll-agent/sdk";
import { BrowserExecuteInputSchema, BrowserExecuteResultSchema } from "@roll-agent/browser";
import { executeBrowserTool } from "../browser-execution.ts";

export const browserExecute = defineTool({
  name: "browser_execute",
  description: [
    "在指定页面执行受控 JavaScript。page 不是 Playwright；所有调用都需 read capability。文本放 args，通过 page.fill(target,args.text) 输入，保留真实换行。",
    "定位构造器：page.ref(ref,snapshotId)、page.locator(css,{scope?,frameId?})、page.getByRole(role,{name,scope?,frameId?})。返回定位数据，没有 .all()/.count()/.fill() 等方法。",
    "只读：await page.read(target,{attribute?})、page.count(target)、page.exists(target)、page.inspectControl(target,{panel?})、page.observe()、page.snapshot({scope?})。snapshot 不接受 frameId；iframe 表单先用独立 browser_snapshot，再将其 ref/snapshotId 传给 page.ref。",
    "交互：await page.click(target,{expect?})、page.fill(target,text,{expect?})、page.choose(target,{label?,value?,panel?,expect?})、page.hover(target,{expect?})、page.press(key,{target?,expect?})、page.scroll(target,{dx?,dy?,expect?})。例如关闭弹层：await page.press('Escape',{target:field})。",
    "其他：await page.goto(url,{expect?})、page.waitFor(condition,{timeoutMs?})、page.expect(condition)、page.screenshot()。condition 可用 {target,value}、{target,state:'visible'}、{target,text,match:'equals'}。没有 page.url/evaluate、fetch、Node、:visible 或 >> nth= 等 Playwright 语法。",
    "优先使用已有平台专用工具。status=failed 时读取 error/actions，只恢复未执行部分；已执行输入不自动重放。缺少 iframe 控件时不要猜下标或标签，重新调用 browser_snapshot，省略 scope/maxDepth 并使用 interactiveOnly=true。",
  ].join("\n"),
  input: BrowserExecuteInputSchema,
  output: BrowserExecuteResultSchema,
  execute: async (input, ctx) =>
    (await executeBrowserTool(BrowserExecuteInputSchema.parse(input), ctx)).result,
});
