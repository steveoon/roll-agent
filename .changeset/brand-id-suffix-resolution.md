---
"@roll-agent/reply-authority-client": minor
"@roll-agent/browser-use-agent": minor
---

支持沟通职位新命名规范 `xxx-xxx-xxx[品牌ID]` 的品牌识别。

- `resolvePreferredBrandId()`：从沟通职位末尾的 `[品牌ID]` 尾缀（兼容全角括号 `【】`/`［］` 与内部空白）提取 Duliday 品牌 ID
- `resolvePreferredBrand()`：检测到品牌 ID 尾缀时不再取第一段作为品牌名，避免向服务端发送错误的 explicit 品牌信号（新格式第一段是岗位描述而非品牌名）
- 协议新增可选字段 `preferredBrandId`，随 generate-reply / prepare-reply-context 请求发送，与 Reply Authority 服务端的 `duliday_id` 直查对齐；`zhipin_get_candidate_info` 输出同步暴露该字段（与 `preferredBrand` 互斥）
- 老命名 `品牌名-xxx`（无 ID 尾缀）走原有名称解析链路，行为不变
- 清理 location signal 本地 LLM 解析残留：地点证据提取已收编 Reply Authority 服务端，`job-signals.ts` 仅保留纯函数信号解析
