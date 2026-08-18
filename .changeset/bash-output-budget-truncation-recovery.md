---
"@roll-agent/runtime": minor
---

roll__bash 新增 `max_output_chars`（整数，1000-200000，默认继承 `runtime.shell.max-model-output-chars`）按调用控制模型可见输出量。输出被中段截断时，标记只陈述事实（截掉多少、保留前后各多少字符、全文多长）；发生截断时完整输出落盘到 `~/.roll-agent/bash-output-dumps`（目录 0700、文件 0600，按 24 小时 / 32 个文件收敛，exec_command 会话单文件上限 4MB），并由能兑现的层（roll__bash 结果、exec_command 轮询结果）给出「用 roll__read_file 以 offset/limit 分页查看中段，或重跑更窄的命令」的恢复指引；roll__read_file 读取该目录不再触发工作区外审批。
