---
"@roll-agent/runtime": patch
---

roll__bash / exec_command 的管道成败改为逐段退出码判定：末段为 0 且其余段为 0 或被下游提前关闭（SIGPIPE/141）才算成功，`git log | head` 型预览不再假失败，`false | true`、`pnpm test | tail` 如实报失败；拿不到逐段状态的 shell 退回 pipefail（141 标注为上游提前关闭、不视为失败）。systemPromptHints 只陈述运行时探测到的能力。截断输出统一落盘到 `~/.roll-agent/bash-output-dumps`（0600、24h/32 个文件生命周期），截断标记只陈述事实，恢复指引由能兑现的层给出。
