---
"@roll-agent/runtime": minor
---

roll chat 新增内建文件工具：roll__read_file / roll__edit_file / roll__write_file / roll__list_dir。按状态同步协议设计——read-before-edit 与内容 hash stale 检测、Unicode 归一化容错匹配（全角标点/智能引号/CRLF）、失败返回最近似位置与差异诊断、批量 edits 原子落盘、成功返回编辑点快照免二次读取。默认启用，可用 ConversationEngineOptions.fileToolsEnabled=false 关闭。
