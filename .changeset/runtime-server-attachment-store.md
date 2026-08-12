---
"@roll-agent/core": minor
---

`roll chat --server` 注入 `AttachmentStore`（`<threadsDir>/attachments`），启用 Runtime Protocol 1.4 attachments 能力——GUI 客户端协商 1.4 后即可 stage 附件并在 `turn.start` 中引用
