# roll chat `/resume` 会话切换设计

## 背景与目标

会话持久化的"后端"已完整就位(SQLite ThreadStore、`engine.resumeSession`、CLI `--session`/`--last`),但可发现性接近零——没人会记 UUID,`--last` 只覆盖"继续上一个"。本设计为 `roll chat` 的两个交互界面(Ink TUI 与基础 REPL)增加 `/resume` 命令:在对话中随时列出已有会话并切换过去,把持久化线程变成真正可用的功能。

## 现状盘点

| 能力 | 位置 | 状态 |
|---|---|---|
| 线程列表(updatedAt 倒序,title/model/时间戳) | `ThreadStore.listThreads()` | 已有 |
| 恢复会话 | `ConversationEngine.resumeSession(threadId)` | 已有 |
| 历史消息 → TUI transcript | `messagesToHistory(session.getMessages())`(`run-ink-repl.ts`) | 已有 |
| 空会话退出清理 | `run-ink-repl.ts` / `runRepl` finally 段 | 已有 |
| Ink slash 命令(仅 idle 态生效) | `commands.ts` `SLASH_COMMANDS` + `app.ts` dispatch | 已有 |
| REPL slash 分支 | `chat.ts` `runRepl` while 循环 | 已有 |

## 命令与交互

### 命令名

两端统一 `/resume`(与 CLI `--session`/`--last` 语义呼应),描述"切换到已有会话"。Ink 加入 `SLASH_COMMANDS`(自动进 `/` 弹窗与 `/help`);REPL 在 `runRepl` 循环加分支。

### 会话行格式化(两端共享)

新增共享纯函数模块(如 `cli/chat/session-picker-format.ts`):

- 输入:`ThreadRecord` + `messageCount` + **注入的 `now: Date`**(相对时间可测,不在函数内取当前时间)
- 输出:标题(无标题回退 `(无标题)`)· 相对时间(如"2 小时前")· `N 条消息`
- 数据源:`store.listThreads()` + `countMessages`,**排除当前会话**

### Ink 选择器

新组件 `session-picker.ts`,**占用 footer 的 prompt 槽位**——与 `TextPrompt`/`UserInputForm`/`ConfirmSelect` 走同一 swap 机制(picker 打开期间 `TextPrompt` 不渲染,不存在双输入焦点与光标锚点冲突),不做叠加浮层。交互沿用既有 select 语言:`›` 光标、↑↓ 移动、Enter 确认、Esc 取消、窗口化滚动(cursor-following)、hint 行"↑↓ 选择 · Enter 切换 · Esc 取消"。空列表显示"暂无其他会话"。切换失败时在 picker 内显示错误行,picker 保持打开。

### REPL 选择器

clack `select`,**option 的 `value` 是 thread id**,label 用共享 formatter 生成。调用前 `rl.pause()`、结束后恢复(对齐 confirm/userInputPrompt 既有模式)。取消(clack cancel)即返回循环,零副作用。

## 切换语义(两端共享)

1. **仅 idle 态可触发**。Ink slash 本就只在 idle 生效;REPL 天然在轮次间。
2. **失败安全顺序:先 resume 成功,再动旧会话。**
   ```
   const next = await engine.resumeSession(targetId);   // 失败 → 报错,当前会话不受任何影响
   旧 session:setUserInputAvailable(false) → close()
   新 session:setUserInputAvailable(true)
   ```
   Ink 侧新旧 session 的 userInput 开关由 `useSession` 的 mount/unmount effect 随 keyed remount 自动完成;旧 session 的退役必须是 **effect-based handoff**——`setActiveSession(next)` 是异步的,不得在其后同步 `close()`。`ChatApp` 以 `useEffect`(依赖 `activeSession`)持退役引用执行收尾:React 同一次 commit 内先跑旧 `ChatSessionView` 的 cleanup(`setUserInputAvailable(false)`)、再跑新 view 的 mount effect(`(true)`)、最后才轮到父组件 effect(effects 自底向上),此时 `close()` 旧 session 并回调 `run-ink-repl` 更新活跃引用与记账,顺序天然安全。REPL 侧无 React,两步顺序手动执行。
3. **Esc/取消零副作用**:不触碰任何 session 状态。
4. **切走时空会话清理**:仅"本次运行新建且零消息未提交"的会话适用(恢复来的会话永不适用)——`deleteThread`,且**静默执行**(alternate screen 激活期间不写 stderr;"未保存"提示仅保留在最终退出路径)。
5. **per-session 状态重置**:`titled`/`submitted`/`isNewSession` 随切换重置;切到已有会话后 `isNewSession = false`,`titled` 以目标线程是否已有标题为准(`thread.title !== undefined`),避免覆盖已有标题、也兜住无标题旧线程。
6. **REPL 侧重建**:`renderer`(依赖 `session.getContextWindow()`)与 `availableSkills = session.getSkillSummaries()` 在切换后基于新 session 重建;切换成功打印"已切换到会话 <id> · <标题>",不回放历史(与现有 `--session` 下 REPL 行为一致)。
7. **Ink 侧历史重建**:切换时计算 `messagesToHistory(next.getMessages())` 作为新 view 的 `initialHistory`,transcript 整体重建;状态栏与退出摘要指向最终活跃会话。

## 架构改动

### Ink:keyed remount,不做手动重绑

`useSession` 的 `useReducer` 只在 mount 时接收 `initialHistory`,事件监听/refs 全部闭包在 session 上——手动重绑易漏。改为:

- `ChatApp` 上提为壳组件:持有 `activeSession` 状态 + picker 浮层状态 + 切换编排
- 会话作用域的全部 UI(useSession、transcript、footer prompt 等)下沉为 `ChatSessionView`,以 **`key={session.id}`** 渲染——切换即 React 卸载/重挂,所有 hook/state 自然重置,旧 session 的 `setUserInputAvailable(false)` cleanup 与新 session 的 `(true)` mount effect 免费获得
- `contextWindow`/`availableSkills` 从静态 props 改为随 `activeSession` 派生

### run-ink-repl:活跃会话追踪

- `RunInkReplOptions` 增加 `resumeSession: (threadId: string) => Promise<AgentSession>`(`chat.ts` 闭包 engine 注入,TUI 不感知 engine)与会话切换回调;`InkReplStore` 按需补 `listThreads` 等只读方法
- `runInkRepl` 维护**活跃会话引用**:切换回调(由 `ChatApp` 的 effect handoff 触发,旧会话已在该 effect 内 `close()`)到达时更新引用并同步 `titled`/`submitted`/`isNewSession` 记账;最终退出路径 `await activeSession.close()`——保证任意时刻只有一个 live session,无泄漏
- `onUserSubmit` 的标题写入基于当前活跃会话引用(切换发生在 idle,submit 必然晚于引用更新,顺序安全)

### REPL:session 可变引用

`runRepl` 的 `session` 改为可变局部引用,`/resume` 分支完成"选择 → 失败安全切换 → 重建 renderer/skills → 重置记账";`titled`/`submitted` 语义同上。注入方式与 Ink 对齐(参数增加 resume 能力,由 `chat.ts` 传入)。

### 不改动的层

协议层、运行时层、`--server` JSON-RPC 模式、one-shot/json surface 均不涉及。`engine.resumeSession`/`ThreadStore` 零改动。

## 边界(v1 不做)

- picker 内文本过滤(列表通常很短;后续可加)
- `/new` 从 TUI 内新建会话(用户已选定范围排除)
- REPL 切换后历史回放(与现有 REPL resume 行为一致)

## 测试计划

- `session-picker-format` 单测:相对时间(注入 now)、无标题回退、行格式
- `session-picker` 组件测试(ink-testing-library):行渲染/空态/↑↓ 窗口化/Esc 取消/Enter 选择
- `commands.test.ts`:`/resume` 进弹窗过滤
- `app.test.ts`:`/resume` 打开 picker;切换后 transcript 重建(fake session/store);resume 失败时当前会话不受影响;切走空新会话被删除
- `chat.test.ts`(runRepl):driver 注入选择 → 后续 send 落到新会话;取消零副作用;renderer/skills 重建
- 全量:`pnpm --filter @roll-agent/core test` + typecheck + lint
- 真实 PTY:tmux send-keys + capture-pane 全流程走查(建多个会话 → `/resume` 切换 → 历史重建 → 空会话清理 → 退出摘要),不用 expect

## 流程约束

- 改动 `runRepl`/`runInkRepl`/`ChatApp`/`useSession` 等符号前先 GitNexus `impact`(upstream),HIGH/CRITICAL 需先向用户报告
- 新增/修改类型(`RunInkReplOptions`、picker 数据结构等)过 `/typescript-magician` 审查
- 提交前 `detect_changes()` 核对影响面
- 遵循 AGENTS.md/CLAUDE.md:核心代码零注释、kebab-case CLI 参数、Prettier/ESLint 规范

## 发布

changeset:`@roll-agent/core` minor(新增用户可见命令 `/resume`)。
