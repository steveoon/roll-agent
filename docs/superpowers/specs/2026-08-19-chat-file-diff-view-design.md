# roll chat — 编辑文件时展示 diff 视图（审批前预览 + 应用后变更）

日期：2026-08-19。对应 issue：#224。状态：已与用户对齐两项关键决策（协议策略 A：复用
`preview` / `display` JSON 槽位，不 bump 协议版本；diff 引擎：手写行级 Myers，零新依赖）。

## 目标

`roll chat` 编辑文件时，用户在两个时刻看到「改了什么」：

1. **审批前预览**：`edit_file` / `write_file` 的审批提示内嵌本次变更的 diff（含 `+N −M`），
   用户据此批准 / 拒绝；拒绝后文件未被写入。
2. **应用后展示**：写入成功后在对话流里显示本次变更的 diff（路径 + `+N −M` + 正文）。

Ink TUI、基础 REPL、`--server`（Runtime Protocol）三条路径都有对应形态。模型可见的工具输出
保持现状（编辑点快照 / 写入预览），不因此增大。

## 现状基线（已核实，出处为 `path:line`）

- `edit_file.prepare` 只做参数校验就调 `gateToolCall`，**不读文件**
  （`packages/runtime/src/tool-bridge/file-tools/edit-file-tool.ts:254-283`）；
  `write_file.prepare` 会读原文件用于 shrink 告警（`write-file-tool.ts:160-198`）。
- 审批请求形状：`ApprovalDisplayOptions` / `ApprovalRequest`
  （`packages/runtime/src/tool-bridge/build-tools.ts:49-71`）→ `SessionEvent`
  `confirmation-required`（`packages/runtime/src/types/events.ts:65-77`）→ Ink
  `PendingConfirm`（`packages/core/src/cli/chat/ink/state.ts:101-107, 420-437`）/ REPL
  `chat-renderer.ts:176-195` / `--server` `toPendingApproval`
  （`packages/runtime/src/service/runtime-service.ts:490-513`）。所有字段都是字符串；
  `--server` 把 `explanation` **并进 `preview` JSON 对象**（键
  `APPROVAL_EXPLANATION_PREVIEW_KEY`），这是「不动 strict 顶层 schema 也能加字段」的既有先例
  （`packages/protocol/README.md:157-163`）。
- 工具结果：`NormalizedToolResult.display`（`normalize-result.ts:77-84`）沿
  `SessionEvent(tool-result).display`（`events.ts:43-56`）→ Ink `commitTool`
  （**不读 display**，`state.ts:243-268`）/ REPL（只 spinner succeed，
  `chat-renderer.ts:163-174`）/ `tool.completed.display = safeJson(display)`
  （`runtime-service.ts:1523-1536`，字符串 16 000 字符截断）/ `ToolExecutionRecord.display`
  （持久化上限 32 KiB，超限整体替换为 omission 信封，`tool-execution-record.ts:14-23, 940-970`）。
- 协议 `pendingApprovalSchema` / `toolCompletedEventSchema` / `operationViewSchema` 都是
  `.strict()` 且被 1.0–1.4 共用（`packages/protocol/src/index.ts:653-663, 1548-1558, 618-629`）；
  顶层加字段会让已发布 client-node `failProtocol`（`packages/client-node/src/index.ts:1404-1415`）。
- 全仓无 diff 库、无 diff 实现（`pnpm-lock.yaml` 无 `diff`）。
- Ink 唯一折叠先例是会话级 `thinkingDisplay` + `/show-think`
  （`state.ts:116-125`, `app.ts:387-406`）；`TranscriptViewport` 高度缓存以 `thinkingDisplay`
  为失效依赖（`transcript-viewport.ts:194-196`）。

## 设计

### 1. 数据形状（`@roll-agent/protocol`，Zod 单一数据源）

```ts
export const APPROVAL_DIFF_PREVIEW_KEY = "diff" as const;
export const FILE_CHANGE_DIFF_UNIFIED_MAX_CHARS = 20_000;

export const fileChangeDiffSchema = z
  .object({
    path: z.string().min(1).max(4_096),          // 工作目录内为相对路径；目录外为绝对路径
    change: z.enum(["create", "modify"]),
    added: z.number().int().nonnegative(),       // 新增行数
    removed: z.number().int().nonnegative(),     // 删除行数
    hunks: z.number().int().nonnegative(),
    unified: z.string().max(FILE_CHANGE_DIFF_UNIFIED_MAX_CHARS).optional(), // 缺席 = 只有统计
    truncated: z.boolean(),                       // unified 被按上限截断
  })
  .readonly();                                   // 刻意不 strict：嵌在 JSON 槽位内的约定键，旧 GUI 对未来字段应容忍
export type FileChangeDiff = z.infer<typeof fileChangeDiffSchema>;

export const fileChangeDisplaySchema = z
  .object({ text: z.string(), diff: fileChangeDiffSchema })
  .readonly();
export type FileChangeDisplay = z.infer<typeof fileChangeDisplaySchema>;

export function getApprovalDiffPreview(approval: Pick<PendingApproval, "preview">): FileChangeDiff | undefined;
export function getFileChangeDisplay(display: unknown): FileChangeDisplay | undefined;
```

- `unified` 为标准 unified diff 文本：`--- a/<path>` / `+++ b/<path>`（新建为 `--- /dev/null`），
  `@@ -a,b +c,d @@` hunk 头，3 行上下文，`\ No newline at end of file` 标记。
- 生产侧上限 `12_000` 字符（低于 `safeJson` 的 16 000 截断线，保证 wire 上不被二次截断），
  schema 上限放宽到 20 000：即使 `redactSecretText` 把 unified 撑到 16 000 并被 `safeJson` 追加截断
  标记，accessor 仍能解析。
- 两个 accessor 用 `safeParse`，形状不符一律返回 `undefined`，供 Ink / REPL / GUI 共用。

### 2. runtime：纯计算层

新增 `packages/runtime/src/tool-bridge/file-tools/text-diff.ts`：

- `diffLines(before: readonly string[], after: readonly string[], maxEditDistance): DiffOp[]`：
  行级 Myers（贪心前向、按 d 存 V 快照回溯，O((N+M)·D) 时间、O(D²) 内存）。
  `MAX_EDIT_DISTANCE = 1_000`；超过时退化为「公共前缀 + 公共后缀 + 中间整段替换」——仍是
  **合法**（非最小）diff，保证永远有统计与正文。
- `buildFileChangeDiff({ before, after, path, change }): FileChangeDiff`：
  - `before.length + after.length > 1 MiB`（`MAX_DIFF_INPUT_BYTES`）→ 仍跑有界 Myers（编辑距离
    上限保证成本可控）得到真实统计，但 `unified` 缺席（"超大文件只给统计不给正文"）。
  - 否则生成 hunk（相邻 hunk 间距 ≤ 6 行合并），拼 unified，按 12 000 字符在**行边界**截断，
    `truncated = true`。
- 全部纯函数，无 I/O，任何异常由调用方 `try/catch` 吞掉 → 不附 diff，不影响写入。

新增 `packages/runtime/src/tool-bridge/file-tools/edit-plan.ts`：把 `executeEditFile` 中
「CRLF 适配 + 逐条 old/new 匹配应用 + AppliedEdit 位置追踪」抽为纯函数
`planEdits(content, edits): EditPlan`（`{ ok: true, next, applied } | { ok: false, result }`），
错误消息与现状逐字一致。`prepare` 与 `execute` 共用。

新增 `file-change-result.ts`：`fileChangeToolResult(text, diff | undefined)` →
`diff` 存在时 `successfulToolResult({ text, diff }, { model: successfulToolResult(text).model })`
（复用默认的有界模型投影，含 60k 截断），否则退回 `successfulToolResult(text)`（行为与现状完全一致）。

### 3. runtime：审批路径

- `ApprovalDisplayOptions.diff?: FileChangeDiff` → `ApprovalRequest.diff?` →
  `gateToolCall` 透传（镜像 `explanation`，`build-tools.ts:407-416`）→
  `AgentSession.requestApproval` 写入事件（`agent-session.ts:2298-2310`）→
  `SessionEvent confirmation-required.diff?`。
- `edit_file.prepare` 改为：参数校验 → payload 校验 →（**仅工作目录内路径**）`loadTextFile` →
  freshness → `planEdits` → `buildFileChangeDiff` → 随 `gateToolCall` 提交。工作目录外路径在
  策略 / 审批门之前**不触碰文件系统**（与 `read_file` 的外部路径门一致，避免把 `edit_file` 变成
  无审批的文件存在性 / 大小探测器）。只有输入本身无效（`old_string === new_string`、CRLF 适配后
  相同、内容无变化）才在审批前短路；未读取 / 已过期 / 不匹配等**内容相关**失败不短路——仍弹审批但
  不带 diff，交给 `execute` 按原逻辑处理。原因：`ToolExecutionCoordinator` 会把同一批次所有调用的
  `prepare` 跑完才开始任何 `execute`，链式依赖的多条 `edit_file` 在 prepare 阶段必然不匹配，若短路
  就回归了既有行为。
- 预览到的 diff 通过 `captureExecutionState` 返回的可变状态对象带到 `execute`；`execute` 重新加载 +
  freshness + `planEdits` + 重算 diff，若**增删行序列**与预览不一致（例如同批次 `write_file` 先改写
  了同一文件），拒绝写入并提示重新读取；行号偏移但增删行相同（同批次独立编辑）照常写入。这保证
  「用户看到的增删就是写入的增删，否则不写」，且 `write_file` 因整文件内容由输入完全指定而无需此校验。
- `write_file.prepare`：已加载原文件；`before = loaded.ok ? content : ""`，
  `change = loaded.ok ? "modify" : "create"`；原文件不可读（二进制 / 超大 / 目录）时不附 diff。
  工作目录外路径与 `edit_file` 一样先过策略 / 审批门，不读盘、不给 shrink 告警与 diff，execute
  照旧做覆盖保护。
- `--server`：`toPendingApproval` 把 `safeJson(diff)` 并进 `preview[APPROVAL_DIFF_PREVIEW_KEY]`
  （与 `explanation` 同一模式；`safeJson` 会顺带 `redactSecretText`）。协议 1.0–1.4 顶层不变，
  旧客户端把 `preview.diff` 当普通 JSON 忽略。

### 4. runtime：结果路径

- `edit_file` / `write_file` 成功时 `display = { text, diff }`（`text` = 现有快照文本），
  `model` 显式为 `{ type: "text", value: text }`——**模型可见输出逐字不变**。
- 由于 `display` 已是各跳的 `unknown` / `jsonValue`，该对象自动流经：`SessionEvent`、
  `ToolExecutionRecord.display`（32 KiB 上限，超限整体 omission——与现状同一规则；diff 计入其中，
  因此文本快照能被完整持久化的阈值从约 32k 字符降到约 20k 字符，属有意取舍）、
  `tool.completed.display` / `operationView.display`（`safeJson`）、legacy `session.event`。
  不需要给任何 strict schema 加字段。
- `cancelled-turn-recovery.ts` 的证据摘要改用 `getFileChangeDisplay(display)?.text ?? display`，
  避免恢复上下文里塞入 diff JSON。

### 5. core：共享解析与 REPL

- 新增 `packages/core/src/cli/utils/unified-diff.ts`：`parseUnifiedDiff(unified): DiffLine[]`
  （`kind: "hunk" | "add" | "del" | "context" | "meta"`，附 old/new 行号；`---`/`+++` 仅在首个
  `@@` 之前视为文件头），`formatFileChangeDiff(diff, { color, maxBodyLines })` 产出终端行
  （chalk 着色：add 绿、del 红、hunk 头青、行号 dim；控制字符经 `sanitizeForDisplay`）。
- REPL（`chat-renderer.ts`）：
  - `confirmation-required` 有 `diff` 时，消息 = 头行 + `AI 说明` + **diff 头（`path +N −M`）+
    正文**（替代 `formatApprovalDetails` 的 `edits: [{"old_string":…}]` 原始 JSON）；无 diff 时
    行为不变（`chat.test.ts` 钉死的 bash 消息不受影响）。
  - `tool-result`：`getFileChangeDisplay(event.display)` 命中时，在 spinner succeed 后向
    **stderr** 打印 diff；正文超过 `DIFF_INLINE_MAX_LINES`（40）时只打头行 + 前 40 行 +
    `…（另 N 行；/diff on 展开）`。
  - `runRepl` 增加 `/diff [on|off]`，切换 renderer 的 `diffDisplay`。

### 6. core：Ink TUI

- `state.ts`：`HistoryItem` `tool` 变体加 `diff?: FileChangeDiff`（`commitTool` 读
  `getFileChangeDisplay(event.display)`）；`PendingConfirm.diff?`；`ChatUiState.diffDisplay:
  ChatDiffDisplay`（`"collapsed" | "expanded"`，默认 `"collapsed"`）+ `set-diff-display` action。
- 新增 `ink/diff-view.ts`：`DiffHeader`（`path`、`+N −M`、`新建` / `已截断` 标签）、
  `DiffBlock`（沿 `ReasoningBlock` 左边框样式；行号栏 dim、`+` 绿、`-` 红、hunk 头青）、
  `DiffSummary`（一行：`path +N −M · 已折叠 · /diff 展开`）。
- `history-item.ts` `tool` 分支：有 `diff` 时在工具行下渲染——正文 ≤ 40 行或
  `diffDisplay === "expanded"` → `DiffBlock`；否则 `DiffSummary`。
- `confirm-select.ts`：`diff?` prop。expanded 布局：diff 头行 + 正文按剩余行预算填充，末行
  `… 另 N 行`，选项行始终保留在框内最后；有 diff 时**不再渲染 `args` 原始 JSON**。compact
  布局（≤ 11 行）：只渲染 diff 头行替代 `args` 行。`planCompactRows` 相应计入。
- 管线：`use-session.setDiffDisplay`；`transcript-viewport.ts` 透传 `diffDisplay` 并加入高度
  缓存失效依赖；`app.ts` 传给 viewport / `ConfirmSelect`；`commands.ts` 注册 `/diff`
  （"完整显示或折叠大段 diff (on | off)，不带参数时切换"），`runSlash` 镜像 `/show-think`。
- 无 config 键（YAGNI；后续需要时按 `chat.thinkingDisplay` 同款加）。

### 7. 边界与上限（汇总）

| 项 | 值 | 位置 |
|---|---|---|
| unified 正文上限 | 12 000 字符，行边界截断 | runtime `text-diff.ts` |
| schema 上限 | 20 000 字符 | protocol |
| 只给统计不给正文 | 输入合计 > 1 MiB | runtime |
| Myers 编辑距离上限 | 1 000（超过退化为整段替换） | runtime |
| TUI / REPL 折叠阈值 | 正文 > 40 行 | core |
| 路径显示 | `formatPathForApproval`（目录内相对，目录外绝对 + 标记） | runtime |
| diff 计算失败 | 吞掉，不附 diff，写入照常 | runtime |

### 8. 错误处理

- diff 计算抛异常 → `undefined`，工具结果 / 审批与现状一致。
- 审批期间文件被改 → `execute` 的 freshness 报 stale，不写入。
- `preview.diff` / `display.diff` 形状不符（被截断、被 redact 破坏）→ accessor 返回
  `undefined`，UI 退回现状显示。

## 测试

- runtime：`text-diff.test.ts`（空 diff / 纯增 / 纯删 / 多 hunk 合并与分离 / 无尾换行标记 /
  CRLF / 新建 / 字符截断在行边界 / 超大只统计 / 编辑距离退化仍可重放得到 after —— 用
  "把 ops 应用到 before 得到 after" 做性质断言）；`edit-plan.test.ts`；`edit-file-tool.test.ts` /
  `write-file-tool.test.ts`（prepare 携带 diff；输入本身无效（old/new 相同等）在审批前短路；
  未读 / stale / 不匹配仍弹审批但不带 diff，执行阶段按原逻辑失败；工作目录外路径在策略门前
  不碰磁盘；拒绝后文件未写；成功 display `{text, diff}`；`model` 与现状逐字相同）；
  `build-tools.test.ts`（透传）；`agent-session.test.ts`（事件带 diff）；
  `runtime-service.test.ts`（`preview.diff` 可被 `getApprovalDiffPreview` 读回；`tool.completed`
  display 通过 strict schema）；`runtime-server.test.ts`（1.1 与 1.2+ 的 `approval.request`
  params 都携带 `preview.diff` —— 控制流可达性证明）。
- protocol：`index.test.ts`（schema；accessor 对合法 / 非法输入；1.0/1.1 冻结 envelope 与
  1.4 envelope 含 `preview.diff` 均可解析；`tool.completed` 含 `{text, diff}` display 可解析）。
- core：`unified-diff.test.ts`；`diff-view.test.ts`（ink-testing-library）；`state.test.ts`；
  `confirm-select.test.ts`（行预算、选项行为框内末行、compact 只头行）；`history-item.test.ts`；
  `app.test.ts`（`/diff` 切换）；`chat-renderer` 测试（REPL stderr 输出、确认消息含 diff）；
  `commands.test.ts`。
- 真实环境：tmux 驱动 `roll chat` 走一遍 edit_file 审批 → 批准 → 查看 diff → `/diff` 切换
  （按记忆规则用 tmux send-keys + capture-pane，而非 expect）。

## 不覆盖

- `/resume` 后回填历史 diff（`messagesToHistory` 只有 ModelMessage，无 display；后续可查
  `session.getToolExecutions()` 补齐）。
- relay / 远程 web companion 投影（allowlist 有意剥离 `preview` 与 `display`）。
- 按 hunk 交互式接受 / 拒绝、编辑器跳转、并排视图、`bash` 通道文件改动的 diff。
- 协议版本 bump（策略 A 已定；若将来需要顶层字段再走 1.5）。
- 会话级 Always（`sessionGrantLabel`）授权后，同一会话后续的 `edit_file` / `write_file` 不再弹
  审批框，因此看不到写前预览；应用后的 diff 仍在对话流显示。这是既有 Always 语义，本次明确接受。

## 发布

changeset：`@roll-agent/protocol` minor、`@roll-agent/runtime` minor、`@roll-agent/core` minor。
`packages/protocol/README.md` 增补 `preview.diff` 与 file-change display 形状说明。
