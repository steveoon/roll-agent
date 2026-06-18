---
"@roll-agent/core": patch
"@roll-agent/sdk": patch
---

静默 `roll chat` 自动启用 `node:sqlite` 时的实验特性提示,并在 `roll update` 遇到 `@roll-agent/*` 新包 registry metadata 短暂 `E404` 时重试安装。

SDK：`defineAgent` 的 `logLevel` 现在支持从 `ROLL_AGENT_LOG_LEVEL` 环境变量读取(显式传入 > 环境变量 > 默认 `info`),便于在不改代码的情况下静默/调高子 Agent 日志。
