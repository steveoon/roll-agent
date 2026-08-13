---
"@roll-agent/client-node": minor
---

RuntimeEventRecoveryManager 支持 Protocol 1.4 durable 事件恢复

- `resumeThread` 在 1.4 会话走完整 durable replay（此前硬编码降级 snapshot-only），事件类型谓词与 StartResult 联合同步扩展 1.4
- 修复 snapshot-only 分支的 context 与 payload 自相矛盾：`recoveryProjection` 如实反映快照是否为 recovery 投影，消费方不再可能把字节裁剪过的投影当全量快照使用
