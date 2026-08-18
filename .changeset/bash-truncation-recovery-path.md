---
"@roll-agent/runtime": patch
---

roll__bash 输出被中段截断时，标记现在携带保留范围（前/后各多少字符、全文长度），并在发生截断时把完整捕获输出落盘到临时文件，提示用 roll__read_file 以 offset/limit 分页查看中段或重跑更窄的命令——模型不再需要猜「被截掉的部分怎么拿」。
