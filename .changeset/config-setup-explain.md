---
"@roll-agent/core": minor
---

新增配置体验入口：

- `roll config setup [llm|install|agent] [agent-name]`：使用交互式问答配置 LLM、npm install/update 网络参数和 Agent 环境变量，并在写入 `roll.config.yaml` 前创建备份。
- `roll config explain [path]`：解释常用全局配置项和 `agents.env.<agent-name>`，Agent env 说明优先来自 Agent 的 `references/env.yaml` 声明。
- `roll agent add` / `roll agent install` 在发现必填环境变量缺失时，会提示使用 `roll config setup agent <agent-name>` 和 `roll config explain agents.env.<agent-name>`。
- `roll config setup` 在非交互式终端下直接报错并给出 `roll config set` / 手动编辑指引，不再进入会挂起的交互流程。
- 配置 Agent 环境变量后，按 runtime ownership 提示生效方式（core-managed 需重启、external-managed 自行重启、on-demand 下次调用自动生效）。
- LLM / Agent 的密钥若以明文（非 `${ENV_VAR}` 引用）写入，会提示改用环境变量引用并避免提交配置文件。
- 已持久化的密钥类 Agent env 在重新运行 `roll config setup agent <agent-name>` 时支持回车保留当前值；用户取消向导时会返回非 0 退出码。
- 默认模型 ID 更新为 `anthropic` -> `claude-sonnet-4-6`、`openai` -> `gpt-5.5`、`qwen` -> `qwen3.6-plus`、`deepseek` -> `deepseek-v4-flash`，并让 `setup` / `explain` / `init` 的默认值从同一份 `DEFAULT_CONFIG` 派生，降低说明文案和真实默认值漂移风险。
