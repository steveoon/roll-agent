---
"@roll-agent/runtime": patch
---

文件工具文本协议收敛为「只拒绝原始 NUL（U+0000）」，读写对称：write_file 的 content、edit_file 的 old_string/new_string 含原始 NUL 或不成对的 UTF-16 代理项（lone surrogate）时在审批弹窗前以 invalid_input 拒绝并给出自救指引（JSON 双解码解释、双反斜杠转义文本、shell 生成原始字节）；read_file 的二进制探测改为扫描整个文件（不再只看前 8192 字节），且只以 NUL 判定，ESC/FF/VT/DEL 等控制字符视为文本，ANSI 日志类文件重新可读可写。修复 write_file 写入以 BOM 开头的 content 后 tracker 记录含 BOM 摘要、导致后续 edit_file 误报 stale 的问题（现按 BOM 文件落盘并记录去 BOM 内容）。仓库源码的 CI 控制字符守卫（scripts/check-source-control-chars.mjs）保持更严格的全 C0 规则，与文件工具运行时策略相互独立。
