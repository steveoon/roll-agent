---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

`roll chat` 从骨架填充为可用的多轮会话助手,并接入新增的 `@roll-agent/runtime` 对话引擎(首次发布 `0.1.0`)。

新增 `@roll-agent/runtime`:

- `ConversationEngine` + `AgentSession`:基于 AI SDK v6 `streamText` 的 agentic tool-calling loop,常驻 `McpClientManager` 连接池跨会话复用,流式 `SessionEvent`(含 token usage)
- `ThreadStore`:`node:sqlite` 会话持久化(标题、消息历史、resume、级联删除)
- `ToolPolicy` / `DefaultToolPolicy` / `ConfigurableToolPolicy` + `ApprovalGate`:写/发送类工具的人在环确认(token 扫描判定,可经 config 覆盖)
- `RuntimeServer`:JSON-RPC over stdio daemon,供 GUI/前端接入

`@roll-agent/core`:

- `roll chat` 现已可用:多轮 REPL、`--session`/`--last` 续聊、`--list` 列出会话、`--json`、`--server` daemon;新会话自动以首条消息为标题
- `exports` 扩展引擎层子路径供 runtime 复用;config 新增 `runtime` 段(`provider`/`model`/`maxSteps`/`threadsDir`/`approval`)
- `bin/roll.js` 在 `roll chat` 需要时自动补 `--experimental-sqlite`,并静默 `node:sqlite` 的实验特性提示;本地源码树仍自动补 `--experimental-strip-types`
- `roll update` 对刚发布的 `@roll-agent/*` 包 metadata 传播型 `E404` 增加整条安装命令重试,降低 npm registry edge 短暂不一致导致的升级失败
