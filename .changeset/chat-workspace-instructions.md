---
"@roll-agent/runtime": minor
"@roll-agent/core": minor
---

roll chat 自动注入工作区 AGENTS.md / CLAUDE.md 作为工程约定（#222）

- runtime：新增 `workspace-instructions.ts`，从工作目录逐级向上找最近一层 `AGENTS.md`（优先）/ `CLAUDE.md`，`AgentSession` 每轮按 mtime/size 检查变化并重编译 system prompt；内容以 `# 工作区工程约定` 段注入（标注来源路径），不在消息历史里、不受 compaction 影响；超过 32 000 字符截断并通过 issue 回调告警一次
- runtime：`ConversationEngine` 新增 `workspaceInstructions`（显式 source 或 `null` 关闭）与 `onWorkspaceInstructionsIssue` 选项，`getContextSummary()` 暴露 `instructionsPath`
- core：新增配置 `chat.instructions: auto | off | <path>`（默认 `auto`，路径支持 `~`）；`roll chat` 把截断 / 缺失告警写到 stderr，banner 显示已加载的约定文件名；README 与 config guidance 同步
