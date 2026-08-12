---
"@roll-agent/protocol": minor
"@roll-agent/runtime": minor
"@roll-agent/client-node": minor
---

Runtime Protocol 1.4：附件与二进制载荷引用（issue #177）

- **protocol**：新增协议版本 1.4。`AttachmentDescriptor`（ID/文件名/安全展示名/MIME/字节数/sha256/来源）、`attachment.stage|chunk|commit|release` 四方法与 staging→committed→release 生命周期；`turn.start` 的 input 扩展 `attachments` 引用数组（纯附件可空文本）；八个稳定错误码（NOT_FOUND/NOT_COMMITTED/TOO_LARGE/TYPE_UNSUPPORTED/HASH_MISMATCH/QUOTA_EXCEEDED/UPLOAD_INCOMPLETE/PATH_REJECTED）；initialize limits 广播附件配额；`UiMessage` V14 新增 `attachment` 安全元数据 part，快照投影到 ≤1.3 时自动降级为 text-only；V13 及更早 schema 全部冻结不变，`turn.start` 携带 attachments 在 1.3 会话被 strict 拒绝
- **runtime**：新增 `AttachmentStore`（staging 目录 + 内存状态机）：local-path 来源校验绝对路径/拒 symlink/大小与 sha256 匹配后一步 commit；chunks 来源按序追加（单 chunk ≤2MiB 原始字节，不突破 4MiB NDJSON 帧）、commit 时校验完整性与 hash，不匹配即回收；staged/committed 双 TTL 惰性回收、thread 删除联动清理、进程重启清扫孤儿文件；`RuntimeService` 注入 `attachmentStore` 后启用 attachments 能力，`turn.start` 解析附件引用为引擎 `SessionAttachment` 且客户端路径不落 thread；Thread Snapshot 返回附件安全元数据（mediaType/bytes），不含二进制与本地路径
- **client-node**：协商版本联合扩展 1.4，事件重放与 recovery snapshot 在 1.4 会话可用；`request()` 通道从 Protocol 1.1 方法域升级到 latest 方法域——`attachment.stage|chunk|commit|release` 与带 `attachments` 的 `turn.start` 均可通过 `client.request(...)` 类型安全地调用（此前 V11 facade 会在类型层拒绝且 turnId 提取路径运行时崩溃）
