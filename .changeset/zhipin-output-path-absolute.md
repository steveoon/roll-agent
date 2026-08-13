---
"browser-use-agent": patch
---

`zhipin_capture_resume` 的 `outputPath` 在 input schema 层强制绝对路径，与工具描述对齐；相对路径不再相对进程 cwd 写盘
