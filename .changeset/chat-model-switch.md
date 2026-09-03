---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

`roll chat` 新增 `/model`，在配置里声明的 provider/model 间实时切换

- 配置新增 `llm.providers.<provider>.models`（可选）；`/model` 列出所有已配置 key 的 provider：默认模型、`models` 列表、以及无列表时的内置默认模型；支持 `/model provider/model` 直达
- 切换作用于本次 roll chat 进程（含 `/resume` 切到的会话），同步 thinking providerOptions、compaction 结构化输出参数、context window、子 Agent sampling 模型与线程 `model` 字段；切换后可选「同时设为默认 LLM」写回 `roll.config.yaml`
- 定时任务与 `roll ask` 等不受影响，始终使用配置默认值
- runtime 新增 `AgentSession.switchModel()`、`ConversationEngine.switchModel()`、`ThreadStore.updateModel()`；core 的 `McpClientManager.setSamplingModel()`
- 基础 REPL（非全屏）暂不支持 `/model`，会给出提示
