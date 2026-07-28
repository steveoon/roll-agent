---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

为 `roll chat` Agent bootstrap 增加可配置的全局超时和端到端取消，确保超时或 Engine
关闭时停止排队任务、取消在飞连接，并在返回部分 catalog 前释放新建连接与使用租约。
