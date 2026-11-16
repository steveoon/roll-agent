# Chat、Skills 与工具执行契约

修改 Sampling、Skills 发现/加载、system prompt、工作区指令、Tool Batch 或资源锁时读取。

本文承接根 [AGENTS.md](../../AGENTS.md) 的专项工程约定。下文源码路径均相对于仓库根目录。

## Sampling Handler（子 Agent 借用指挥官 LLM）

子 Agent 通过 MCP Sampling 协议回调指挥官的 LLM。流程：
1. 指挥官在 `McpClientManager` 连接子 Agent 时注册 `CreateMessageRequestSchema` handler
2. 子 Agent 调用 `server.createMessage()` → MCP 协议转发到指挥官
3. 指挥官的 `sampling-handler.ts` 用 AI SDK `generateText()` 完成推理，返回结果

这使子 Agent 无需自带 LLM 配置，解耦了 LLM 提供商与子 Agent。

## SKILL.md body 参与 LLM 路由

SKILL.md 的 frontmatter 用于注册元数据，**body 正文内容**会被 `llm-router.ts` 拼入 Agent 能力描述，供 LLM 理解 Agent 具体能做什么。编写 SKILL.md 时需注意 body 质量。

## roll chat 的 Skills 接入与 system prompt

chat 走独立的 skill 通道（对齐 `npx skills add` 标准生态，非 roll 私有约定）：

- **发现**：`packages/core/src/skills/library.ts` 的 `createSkillLibrary()` 自动发现项目级 `.agents/skills/*/SKILL.md`（从 cwd 向上查找）+ 用户级 `~/.agents/skills/` + 已注册 Agent 的 SKILL.md + config `skills.dirs` 补充目录；重名按 agent > project > user > config 优先级去重
- **加载告警**：`roll chat` 普通 CLI 与 `--server` JSON-RPC 模式都必须传 `onSkillLibraryIssue`，把 malformed SKILL.md、重名或读取失败等问题写到 stderr，不能静默丢 skill
- **渐进式披露**：`ConversationEngine` 把 skill 目录（name + description）注入 system prompt，模型按需调用内建只读工具 `roll__skill`（`packages/runtime/src/tool-bridge/skill-tool.ts`）加载正文或 `references/` 文件；skill 工具不经 policy 确认门
- **手动指定**：Ink TUI 的 `/` 弹窗把内置命令和可加载 skill 合并展示；`/skills` 列出全部 skill；`/<skill-name> [/<skill-name> ...] 用户请求` 由 `AgentSession` 在首次推理前直接加载主 Skill，并作为仅模型可见的 user/context 内容注入，核心 system prompt 权限不变，用户历史仍保留原始 slash 输入；同一 Turn 的 context-overflow 重放复用同一份 Skill 快照。主文档不再浪费一次 `roll__skill` Tool Call，只有按需读取 `references/` 时才调用该工具；未知 Skill 在模型调用前失败。基础 REPL 也支持 `/skills` 和 skill 前缀
- **system prompt**：`packages/runtime/src/engine/system-prompt.ts` 的 `buildChatSystemPrompt()` 组装身份、工具接地纪律（禁止无工具结果声称完成）、任务推进、Skills 目录、输出通道规则。修改 chat 行为指导时改这里，不要在 `agent-session.ts` 里散落字符串
- **工作区工程约定**：`packages/runtime/src/engine/workspace-instructions.ts` 从 cwd 向上找最近一层 `AGENTS.md`（优先）/ `CLAUDE.md`，每轮按 mtime/size 缓存刷新；`system-prompt.ts` 的 `# 工作区工程约定` 段在 `# 输出` 之后；`ConversationEngine` 按 `chat.instructions`（auto | off | path）构造 source，三入口共用；告警走 `onWorkspaceInstructionsIssue` → stderr
- **测试封闭性**：引擎/会话测试需传 `skillLibrary: null`（引擎）或不传 `skillLibrary`（会话）避免读取真实 `~/.agents/skills`；需要隔离工作区约定时引擎传 `workspaceInstructions: null`（会话不传 `workspaceInstructions`）

## `roll chat` Tool Batch 资源提示

`AgentSession` 会先按模型返回顺序完成整批 Tool 的参数校验、policy 与用户确认，再并行执行无资源冲突的调用。MCP Tool 可通过 `_meta["roll/resourceHints"]` 显式声明输入字段对应的资源：

```json
{
  "_meta": {
    "roll/resourceHints": [
      { "field": "path", "kind": "file" },
      { "field": "sessionId", "kind": "browser-session" },
      { "field": "conversationId", "kind": "conversation" }
    ]
  }
}
```

使用 `@roll-agent/sdk` 时优先直接在 `defineTool()` 中声明等价的 `resourceHints`；SDK 会把它透传为上述 MCP `_meta`：

```ts
defineTool({
  // ...
  annotations: { destructiveHint: true },
  resourceHints: [{ field: "path", kind: "file", mode: "write" }],
});
```

- `field` 只读取 tool input 的顶层字段，值可为单个字符串/数字或数组
- `file` 会先转为规范化绝对路径；stdio Agent 的相对路径以其 `installPath` 为基准，无法确定远端基准时回退 Agent 级锁
- `browser-session`、`conversation` 按稳定 ID 建锁；`custom` 还需提供 `namespace`
- `mode` 可显式设为 `read` / `write`；省略时按 MCP `readOnlyHint` / `destructiveHint` 推导
- 未声明提示或运行时没有解析出资源值时，保守回退为 `agent:<name>` 级锁；不会猜测任意业务字段

后台 `exec_command` 的进程在 Tool 返回后仍可能继续运行，P0 锁只覆盖 Tool 调用生命周期，不承诺跨后台进程生命周期的文件隔离；长生命周期副作用恢复属于 Semantic WAL 范围。
