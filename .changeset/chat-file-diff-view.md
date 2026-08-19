---
"@roll-agent/protocol": minor
"@roll-agent/runtime": minor
"@roll-agent/core": minor
---

roll chat 编辑文件时展示 diff 视图（审批前预览 + 应用后变更）

- runtime：`edit_file` / `write_file` 在审批前对编辑做 dry-run，把「改前 vs 改后」的 unified diff（含 `+N −M`）随审批请求一起投影；`edit_file` 对输入本身无效的编辑（`old_string` 与 `new_string` 相同等）在弹审批前直接失败，工作目录外路径在策略 / 审批门之前不再触碰文件系统。执行阶段会重算 diff，若增删行与审批时预览的不一致（例如同批次里 `write_file` 先改写了同一文件）则拒绝写入。写入成功后的 `display` 变为 `{ text, diff }`，模型可见输出保持原快照文本不变（含原有 60k 截断）。diff 由内置行级 Myers 生成，正文按上限截断、超大文件只给统计，计算失败不影响写入。注意：工具台账对 `display` 的 32 KiB 上限现在把 diff 计入，超大编辑快照被整体省略的阈值相应前移。
- protocol：新增 `fileChangeDiffSchema` / `fileChangeDisplaySchema` 与 `getApprovalDiffPreview()` / `getFileChangeDisplay()`；diff 放在 `approval.preview.diff` 与 `tool.completed.display` 既有 JSON 槽位内，1.0–1.4 顶层 strict schema 不变，旧客户端忽略即可。
- core：Ink TUI 审批框内嵌 diff 预览（按行预算截断，替代原始 edits JSON），对话流在工具行下渲染着色 diff；超过 40 行默认折叠为一行摘要，`/diff [on|off]` 会话级切换；基础 REPL 在审批消息与结果后打印着色 unified diff，同样支持 `/diff`。
