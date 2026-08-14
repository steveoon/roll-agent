---
"@roll-agent/runtime": minor
"@roll-agent/protocol": minor
"@roll-agent/core": patch
---

roll chat coding 工具扩展：roll__grep / roll__glob（ripgrep 后端，输出与 read/edit 契约耦合，全角标点归一化提示）、roll__verify_file（多语言验证器注册表，fast/project 分级，fail-honest）、会话级批准记忆（确认弹窗三选项「允许并本会话不再询问」，协议 approval.respond 增可选 scope 字段单向兼容（旧客户端不受影响；新字段发往旧 server 会被拒，详见设计文档））、write_file 缩水防护与 edit→write 导流。
