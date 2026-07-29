---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
"@roll-agent/protocol": minor
"@roll-agent/client-node": minor
"@roll-agent/companion": minor
---

新增版本化 Roll Runtime Protocol v1、正式的 `roll runtime serve --stdio` 入口与
`RuntimeService` 安全 UI 投影，同时保留旧 `roll chat --server` / `session.*` RPC。

发布 Node 客户端与本地 Companion/Relay 基础包，支持显式工作区、流式事件、审批与取消、
有界进程内幂等、Snapshot 恢复、事件 ACK/gap 缓冲、工作区生命周期 lease、出站 Relay 重连
以及可插拔的敏感工作区端到端加密。

Node 客户端会协商并暴露初始化结果，提供请求超时与 Runtime 退出订阅，并在畸形帧、非法
事件或响应 DTO 不匹配时关闭连接、拒绝挂起请求；同时提供可等待、幂等的分阶段
`shutdown()`；显式关闭或协议失败都会等待真实进程退出，并依次关闭 stdin、发送 SIGTERM、
必要时 SIGKILL，避免 GUI 宿主退出后遗留 Runtime 或 Agent 子进程。Companion 与 Runtime
在各自公布的有界窗口内缓存并校验 mutation `requestId`，活动项不会被容量淘汰，大型读取
响应不会进入缓存；Companion 还会限制 ACK 不能越过当前连接已发送的事件，并隔离每次重连
的发送队列。重复投递不会重复执行副作用，同时保留稳定的 `rollCode` / `retryable`。
