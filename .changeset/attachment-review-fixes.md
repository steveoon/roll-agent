---
"@roll-agent/runtime": patch
---

附件栈发布后 review 修复：

- `ATTACHMENT_QUOTA_EXCEEDED` 错误文案如实反映配额契约——附件被 `turn.start` 引用后不会自动释放，恢复路径是 `attachment.release` 或等待 TTL 回收（原文案声称引用可腾出槽位，与实现不符）
- local-path stage 现在同时校验 `sourcePath` 的扩展名与申报 `mediaType` 一致，拒绝用合法 `fileName` 包装任意扩展名的本地文件
- 工具图像搬迁消息改用 `providerOptions.rollRuntime.relocatedToolImages` 显式标记识别，替代「以下图像来自工具 」文本前缀启发式；以该前缀开头且携带图片的用户消息不再被 stale 修剪误伤
