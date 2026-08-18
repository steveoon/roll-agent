---
"@roll-agent/runtime": patch
---

roll__bash / exec_command 的管道成败改为逐段退出码判定：末段为 0 且其余各段为 0 或被下游提前关闭（SIGPIPE / 141）才算成功——`git log | head` 型预览不再假失败，`false | true`、`pnpm test | tail` 如实报失败；逐段状态与 shell 退出码不一致时以退出码为准。bash / zsh 通过 EXIT trap 采集逐段状态；拿不到逐段状态的 shell 退回 pipefail（141 标注为上游提前关闭、不视为失败），两者都不支持时保持末段退出码语义。系统提示只陈述运行时探测到的管道能力，不再鼓励自接 head/tail 管道，改为引导使用 `max_output_chars` 或 roll__read_file / roll__grep。
