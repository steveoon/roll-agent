---
"@roll-agent/runtime": minor
"@roll-agent/core": patch
---

roll chat coding 工具扩展：roll__grep / roll__glob（ripgrep 后端，输出与 read/edit 契约耦合，全角标点归一化提示）、roll__verify_file（多语言验证器注册表，fast/project 分级，fail-honest；会执行项目本地代码的验证器如 eslint 需确认一次）、会话级批准记忆（确认弹窗在可记忆时提供「允许并本会话不再询问」，仅进程内 Ink TUI；不改 wire 协议）、write_file 缩水防护与 edit→write 导流。
