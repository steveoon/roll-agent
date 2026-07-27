---
"@roll-agent/runtime": patch
---

在 `roll chat` 启动时按注册顺序有界并发初始化 Agent，缩短多 Agent catalog bootstrap
耗时，同时保持稳定 Tool ID、告警顺序和单 Agent 失败隔离。
