# 通用页面探索

已建模的 BOSS 操作优先使用 `zhipin_*`。本文描述未知页面的补充能力，不替代签名回复、平台语义校验或现有预编排。

单步 `browser_snapshot` / `click_ref` / `type_ref` 的区域观察、上下文选择和严格 ref 用法见 [通用 ref 操作](generic-browser-refs.md)。

## 通过完整目标执行

`browser_operate` 默认 `strategy:"task"`。Roll 交代原始目标、已知事实和已准备文案；Jev/所选引擎在当前页面选择下一步。例：

```json
{
  "pageId": "真实页面 ID",
  "goal": "填写岗位草稿。优先处理前置选择和必填字段，使用资料中的内容，停止在发布前。",
  "values": [
    { "name": "职位名称", "text": "餐饮兼职服务员" },
    { "name": "岗位说明", "text": "调用方已准备并允许使用的完整岗位文案" },
    { "name": "最低月薪", "text": "5000" },
    { "name": "最高月薪", "text": "6000" }
  ],
  "strategy": "task",
  "allowedOrigins": ["https://example.com"],
  "blockedNames": ["发布", "提交"]
}
```

示例中的页面、origin 和事实必须替换为实际输入。必填标记不允许编造缺失事实；用户要求的选填字段仍须处理。Roll 需要拟写内容时在交付前准备好；Jev 不负责自由写作。操作过程中无需宿主准备、逐项检查、字段完成复核或内部恢复。

一次决策请求共享当前页面状态，询问一个带目标的完整动作，以及各输入框对应的来源值。完整动作把操作与目标绑定，避免不兼容组合。各来源问题按对应输入框独立执行，只消费选中动作的来源答案；输入框与其来源问题显式绑定，未使用分支的置信度不影响执行。Jev 可优先处理前置选择和必填字段；编辑入口先点击，再观察里面的真实字段，不能强制给按钮解析一个输入值。

决策输入中的 `pickerFields` 单独表示选择控件，元素通过字段 ID 关联触发器或候选项。关系来源区分 ARIA 和唯一局部 DOM 包含关系；无法唯一定位的归属保持未知，不按距离猜测。原生标签、placeholder、空触发器展示文字和先前观察到的标签分别标注来源；只有文档、frame 和实际节点身份一致时才保留旧标签。节点替换后不沿用。

`valueKind` 区分输入值、已应用值、查询词、占位内容、候选文字和纯展示文字。`sourceValueMatches`/`writtenValueMatches` 仅是明确范围的字符串相等线索，不表示任务完成；候选菜单中的文字不能充当字段值。下拉展开状态 `expanded` 与菜单当前是否可见 `panelVisible` 分开表达，异步菜单未出现不等于控件已关闭。隐藏 backing input 只用于提供有值/空值证据，不向模型输出其内部编码。

动作描述明确区分“打开某字段”“选择该字段的候选”“向搜索框输入查询”。完成问题要求对照每个请求字段的实际结果，不能因为页面某处出现了目标文字就结束。这些输入同样适用于显式启用的 sampling 主决策引擎，不增加宿主复核或置信度门禁。

输入候选由代码从完整 `values` 和有限的 goal 原文片段中提供，Jev 选择后代码复制完整原文，不把预览截断内容当成实际值。保留无匹配选项；原文候选覆盖不全、需要转换或没有所需文案时返回 `needs_input`，Roll 提供针对该控件的值后继续。原生 select 只使用观察到的 option；自定义下拉通过点击、查询和选择推进。页面文本是 UI 证据，不能冒充用户数据。

代码保留站点/策略限制、文档与控件身份检查、可操作性检查、输入精确读回、取消与停滞预算。不执行模型生成的脚本/选择器，不在不确定的动作后自动重放。搜索文字不等于已应用的字段值，模型根据每轮新观察继续选择和确认。

默认 `sampling` 使用 Roll MCP Sampling 模型；Roll 配置 `browser.operate.engine: jev` 后，快速模式使用 TypeSafe 官方接口，不需要宿主 Sampling。工具 `engine` 参数不能覆盖配置。不存在第二个辅助模型。旧 `maxTextCalls`、`maxRecoveryDecisions` 参数仅兼容已有调用且不生效；`BROWSER_OPERATE_TEXT_MODEL` 已不使用。输出 `textCalls:[]`、`recoveryDecisions:0`。

停滞或复杂障碍返回 `needs_reasoning`，Roll 据实际观察决定下一步，不能盲目重跑。`model_done` 是未验证的完成提议：Roll 必须对照完整原始目标统一验收 `finalObservation` 和页面结果。`resolvedValues` 是执行记录；同名字段、搜索框和候选文字不能冒充最终值。如果 `observationFresh:false`，或存在截断、覆盖缺口、冲突，补一次定向只读观察。将错误整理成局部修正任务，保留正确字段；修正后仍要核对原目标。所有验收和返工成本都计入端到端测试，不把快速失败当作提速。

`strategy:"fields"` 保留按完整资料顺序填写的旧路径，也没有文本助手。两种模式均保留 `verified:false`，不宣称平台已接受最终提交。

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

`page` 不是 Playwright。定位器构造器返回普通定位数据，没有 `.all()`、`.count()`、`.fill()`、`.textContent()` 或 `.getAttribute()` 方法；使用 `page.count(target)`、`page.fill(target,text)`、`page.read(target,{attribute})`。不支持 `page.url()` 或 `:visible` 等 Playwright 选择器扩展。遇到 `SCRIPT_ERROR` 时先检查已执行的 `actions`，不要重放已成功的操作。

陌生表单先调用独立的 `browser_snapshot`；空白 `scope` 与省略相同。脚本内 `page.snapshot()` 受 origin 限制不展开 iframe，可能只看到导航栏。此时使用独立快照返回的 `ref` 与 `snapshotId` 构造 `page.ref(ref,snapshotId)`，它会保留 frame 身份并继续执行现有 frame/origin 检查。不要猜测 iframe 的下标，也不要仅凭脚本内快照断言表单不存在。

字段可能以摘要、编辑或补充入口呈现，输入控件要展开后才出现。用户要求填写某字段时，先检查与它明确相关的已观察入口，再决定是否缺少可操作路径；必要时滚动对应区域。用户明确指定的字段即使在页面上标为可选，也需要完成或清楚报告真实阻塞原因。只提供部分表单值的快照不是“字段不支持”的证据。

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

决策请求会去重通用说明和资料表，并按字节预算缩短模型预览；保留原始 goal、所有动作 ID 与执行用完整文本。预览被截断不代表字段不存在，最终观察不使用这种压缩视图。同一 Jev 请求另有一个整项完成判断，仅在动作建议 DONE 时使用；它可指出未完成要求或尚未处理的面板，不调用宿主模型，也不逐字段增加检查调用。

Roll 必须原样转发用户目标和原样类文本，不能自行增删换行。原文只有一段时不得为了展示而重排成两段；最终核验包含这一点。
