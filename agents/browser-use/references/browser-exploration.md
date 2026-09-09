# 通用页面探索

已建模的 BOSS 操作优先使用 `zhipin_*`。本文描述未知页面的补充能力，不替代签名回复、平台语义校验或现有预编排。

单步 `browser_snapshot` / `click_ref` / `type_ref` 的区域观察、上下文选择和严格 ref 用法见 [通用 ref 操作](generic-browser-refs.md)。

## 执行一个组合脚本

先通过 `list_pages` 获取准确 pageId。脚本固定在一个 browserInstance 的一个页面，执行期间复用连接并串行持有实例操作锁。不同实例可并行，页面诊断出口不被脚本占住。

调用 `browser_execute` 的示例输入：

以下是针对假设存在 `#profile` 表单的接口示例；example.com 本身不提供该表单。实际调用需替换为目标页面、已确认的定位器及其 origin。

```json
{
  "pageId": "从 list_pages 取得的页面 ID",
  "capabilities": ["read", "interact", "navigate"],
  "allowedOrigins": ["https://example.com"],
  "args": { "name": "Ada" },
  "source": "const field = page.locator('#name', {scope:'form#profile'}); await page.fill(field, args.name, {expect:{target:field,value:args.name}}); await page.click(page.getByRole('button',{name:'Save',scope:'form#profile'})); await page.expect({target:page.locator('#result'),text:'Saved',match:'contains'}); return {saved:true};"
}
```

通过 CLI 执行时，将该 JSON 保存到临时输入文件，再使用 `roll run browser-use-agent browser_execute --input-file <输入文件> --json`。也可直接使用 `--input-json`。参数属于本次执行，不会自动保存到站点经验中。

默认上限：30 秒、100 次 helper 调用、32MiB 脚本堆，文本结果/日志/轨迹合计 64KiB。`timeoutMs`、`maxCalls` 只能调低。截图单独保存为本地产物，返回 `artifacts` 路径；最多 10 张。脚本环境没有文件读写、模块导入、`process`、`fetch`、裸 CDP 或页面 `evaluate`。

## Helpers

| Helper                                                                 | 用途                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `page.locator(css, {scope?,frameId?})`                                 | 构造 CSS 定位，不执行查询                                          |
| `page.getByRole(role, {name,scope?,frameId?})`                         | 构造精确 role/name 定位                                            |
| `page.ref(ref, snapshotId)`                                            | 使用当前页面最新 Snapshot 的严格 ref                               |
| `page.observe()`                                                       | 有界页面状态，适合决策点观察                                       |
| `page.snapshot({scope?})`                                              | 按需语义快照，带上下文、locator 提示和覆盖缺口；受节点上限约束 |
| `page.read(target, {attribute?})`                                      | 读取有界文本/值/可见状态；属性仅允许常见标签属性，密码值不返回     |
| `page.exists(target)` / `page.count(target)`                           | 条件分支和匹配数量；读取/操作目标要求唯一匹配                      |
| `page.click(target, {expect?})` / `page.fill(target, text, {expect?})` | 点击或清空后输入，并可验证后置条件                                 |
| `page.hover(target, {expect?})`                                        | 悬停并可验证状态变化                                               |
| `page.press(key, {target?,expect?})`                                   | 常用页面按键；要求明确目标或本脚本建立的焦点，不开放浏览器快捷键   |
| `page.scroll(target, {dx?,dy?,expect?})`                               | 指定容器滚动，每轴最多 2000px                                      |
| `page.goto(url, {expect?})`                                            | 当前页面导航，需 navigate 能力                                     |
| `page.waitFor(condition, {timeoutMs?})` / `page.expect(...)`           | 有期限地等待/断言，失败终止后续副作用                              |
| `page.inspectControl(field, {panel?})` | 只读识别单选字段、关联面板、iframe 和当前渲染选项 |
| `page.choose(field, {label?,value?,panel?,timeoutMs?,expect?})` | 按精确标签或值选择一次，并验证字段结果；label/value 二选一 |
| `page.screenshot()`                                                    | 截图产物，需 capture 能力                                          |

所有脚本需要 `read` 能力，以便检查页面和目标。`interact` 包含点击、输入、按键、悬停、滚动和 `choose`；`inspectControl` 只需 `read`。已知链接或表单导航还需要 `navigate`。允许站点必须是明确的 HTTP(S) origin，并受到全局 domainAllowlist 约束。单页脚本不会自动切换到新标签页。

条件支持：`{target,state:'visible'}`（也支持 attached/absent/hidden/enabled/disabled/checked/unchecked）、`{target,text,match:'equals'|'contains'}`、`{target,value}`、`{url,match:'equals'|'startsWith'}`。执行级 `preconditions` / `postconditions` 使用相同格式。

## 通用单选控件

`page.inspectControl(field, {panel?})` 是只读观察；`page.choose(field, {label?,value?,panel?,timeoutMs?,expect?})` 是受策略和审批约束的交互。`label` 与 `value` 必须且只能提供一个，使用精确匹配。`timeoutMs` 默认 3000，上限 10000 毫秒，仍受整段脚本截止时间约束。

```js
// field 来自刚才观察的严格 ref；它保留页面及 iframe 归属。
const field = page.ref(args.ref, args.snapshotId);
const state = await page.inspectControl(field);
if (state.association === "ambiguous") return {needsExploration: true, state};
await page.choose(field, {label: args.label});
```

观察返回 `kind`、`association`、`triggerCss`、`panelCss`、`frameId`、`pageId`、当前 `value` / `text`、`expanded`、`multiple`、最多 100 个 `options` 和 `coverageWarnings`。每个选项包含 `label`、`value`、`selected`、`disabled` 与诊断用 CSS 路径。CSS 路径属于当前 DOM，不是持久化经验中可直接复用的稳定定位器。

关联顺序为原生 SELECT、显式 `panel`、`aria-controls` / `aria-owns`、同一控件附近唯一的结构选项组。不会越过相邻字段去认领另一菜单。没有关联属性的门户浮层可以在观察其身份后显式限定：

```js
await page.choose(page.locator('#field', {frameId: args.frameId}), {
  label: args.label,
  panel: '#visible-menu',
});
```

上述 CSS 是接口示例，实际值必须来自页面观察。重复 panel ID、多个候选组或同一面板中重复标签都停止执行。没有足够关联证据时返回 `control_unassociated`；工具可能已经打开控件，失败后需检查现场，不重放整段。

选择只执行一次。原生 SELECT 按具体选项选择并核对 selected 状态，避免不同标签共用 value 时选错；自定义控件要求可信的 selected 状态、对应字段值/显示文案变化，或调用者显式声明的 `expect`。面板消失和点击命令成功本身都不足以证明选中了目标。

级联菜单用明确的 `panel` 和每级 `expect` 分步编排：父级操作可声明子面板出现，最后一级验证最终字段值。没有足够结构证据时不自动展开任意深度的级联。原生或 ARIA 多选、超过选项上限、未渲染的虚拟列表项等返回限制或要求进一步探索；不会默认滚动全部列表。自定义列表的 `rendered_options_only` 提醒调用方当前结果不保证覆盖所有逻辑选项。

在 iframe 内，字段 locator 必须携带正确 `frameId`，或使用保留 frame 身份的严格 ref。输入前会检查同源 iframe 的祖先命中与焦点；外层遮挡返回 `target_obscured`，焦点改变返回 `focus_changed`，无法遍历或不支持的 CSS 变换返回 `coverage_gap`；跨源祖先同样停止，未声明允许的 origin 会先触发域名边界错误。这延续了“无法可靠验证就停止”的规则。

这些机制按原生标签、ARIA 关系、DOM 结构与可操作证据工作，不包含 BOSS 字段名、域名或组件类名。表单失配时重新观察当前浮层和字段，不用 reload 作为默认恢复操作。

## 理解结果和错误

- `status`：completed、failed、cancelled、timed_out；不是网站业务状态。
- `verification`：passed、not_requested、failed。未提供断言时不能把 completed 当作业务成功；最后一次副作用之后需要验证才能标记结果已验证。
- `actions` 保留各步骤是否执行、验证状态和耗时；`checks` 带验证结果及失败时的有界实际观察。
- `observation` 返回有限的页面变化；`value` 是脚本返回值；`logs` 是受限日志。不要将敏感内容写入日志。
- 取消或错误不回滚已经发生的操作；审批拒绝、目标失效、验证失败不能被 JS `try/catch` 转成成功并继续操作。
- `actionPolicy=confirm` 的批准在副作用前一次性完成，并绑定脚本、参数、实例、页面 document、站点、能力和限制。批准仅能使用一次。运行中策略变更会终止后续动作，不提供整段自动重放。
- Runtime 客户端会通过现有确认通道处理明确标记 `executionState:not_executed` 的审批请求；批准后仅补充返回的凭据续接一次，保持原始业务参数与实例资源锁。拒绝、取消、部分完成或第二次审批请求均不会自动重试。直接 CLI 调用仍返回结构化 `approvalRequest.retryInput`，由操作者确认后原样补入。

新入口中的 ref 绑定最新 snapshotId、browserInstance、pageId 与 documentId；刷新快照、导航、跨实例使用或节点脱离时都可能失效。已有 `click_ref` / `type_ref` 可附带 `snapshotId` 使用相同严格规则；旧调用仍兼容。

Snapshot 在 `coverageWarnings` 明确指出 canvas 或不能可靠读取的 frame 等缺口。脚本限定 origin 时当前实现保守跳过 frame 展开；必要时使用已支持的同源 frame 定位或截图观察，不把空语义树当作空页面。

## 经验闭环

工具：`browser_workflow_list({url})`、`browser_workflow_save_draft({draft})`、`browser_workflow_validate({id,version,pageId,args})`、`browser_workflow_set_status({id,version,status})`、`browser_workflow_run({id,version,pageId,args})`。

草稿包含 id、name、description、`appliesTo:{origins,pathPrefix?}`、source、parameterSchema、capabilities、allowedOrigins、preconditions、postconditions、notes 和 locatorExplanations。参数 schema 顶层为 object，仅支持有界的基本 JSON Schema 子集；不支持的关键字会被拒绝。业务输入通过 args 传入，草稿不要硬编码账号数据、秘密或本次 Snapshot ref。

每份内容产生不可变 version。保存只检查语法，不执行代码。验证显式运行该版本，成功且有结果断言才记录服务端验证凭据；调用者不能提交伪造成功记录。激活需要针对该 version 的单次显式批准，修改内容后重新保存/验证/批准。停用立即停止后续 helper；定位或断言失效会暂停推荐，需要重新探索。

默认库在 `~/.roll-agent/browser/workflows`，当前用户跨项目复用。记录只保存模板和验证摘要，不自动持久化运行参数、页面正文、消息内容或截图。发现只返回已启用且适用于 URL 的简短签名；不动态注册站点专属 MCP 工具。编排器负责从成功探索整理草稿，执行 Agent 不自行调用模型生成经验。

## 浏览器 SDK 嵌入

应用通常通过 MCP 调用 `browser_execute`，以复用实例锁、策略与审批。实现自有受信任宿主时，可从 `@roll-agent/browser` 导入执行内核：

```ts
import {
  BrowserExecuteInputSchema,
  executeBrowserProgram,
  type BrowserProgramDriver,
} from "@roll-agent/browser";

export async function readProfile(
  pageId: string,
  driver: BrowserProgramDriver,
  signal: AbortSignal,
) {
  const input = BrowserExecuteInputSchema.parse({
    pageId,
    capabilities: ["read"],
    allowedOrigins: ["https://example.com"],
    source: `
      const target = page.locator('#profile-name');
      await page.expect({target, state: 'visible'});
      return await page.read(target);
    `,
  });
  return executeBrowserProgram(input, { driver, signal });
}
```

`BrowserProgramDriver` 属于宿主信任边界。直接嵌入时，调用方负责实例锁、整段审批、当前站点/策略检查，以及 `close()` 中断连接；内核不会为任意自定义 driver 补齐这些能力。生产 MCP 入口使用 `BrowserScriptPageDriver` 与 `executeBrowserTool` 统一完成这些检查。执行结束会关闭 driver，不应跨执行复用已关闭对象。
