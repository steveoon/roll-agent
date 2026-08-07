---
"@roll-agent/protocol": patch
---

JSON Schema 产物的 `$id` 从未启用的占位域名改为 `urn:roll-agent:schema:…` URN 命名
空间（runtime-protocol 与 relay-protocol/control 全线一致）。`$id` 仅作标识符，协议
语义与校验行为不变；Wire 1.0/1.1 的冻结哈希已随本次变更显式更新。
