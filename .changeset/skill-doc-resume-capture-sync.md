---
"@roll-agent/browser-use-agent": patch
---

SKILL.md 同步简历工具链现状：`zhipin_open_resume` / `zhipin_locate_resume_canvas` / `zhipin_close_resume` 标注更正为 native CDP（不再是"Playwright-backed 未迁移项"），收录新工具 `zhipin_capture_resume`（滚动拼接长图 + MCP image content + captureMode 三态 + 进度反馈），新增「查看简历」典型链路与两条编排硬规则（简历正文只能走图像通道；capture 需在 resumeReady 后调用）
