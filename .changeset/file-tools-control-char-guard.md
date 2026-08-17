---
"@roll-agent/runtime": patch
---

文件工具写入侧对裸控制字符 fail-closed：write_file 的 content、edit_file 的 old_string/new_string 含原始控制字符（C0 除 TAB/LF/CR，加 DEL）时以 invalid_input 拒绝并给出自救指引（JSON 双解码解释、双反斜杠转义文本、shell 生成原始字节）。读取侧二进制探测与写入侧共用同一判定源（control-chars.ts），拒绝集合与 read_file 的 binary 判定完全一致，并在消息中指明具体码点。
