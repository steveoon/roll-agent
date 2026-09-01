---
"@roll-agent/core": minor
"@roll-agent/runtime": patch
---

为后台任务增加 `~/.roll-agent/secrets.env` 配置占位符回退，并在 doctor、service install、Roll UI 与 chat schedule tool 中统一报告无法解析的变量。诊断不会携带 secret 明文；即使调度服务本身已经运行，任务创建结果仍会保留配置 readiness warning。
