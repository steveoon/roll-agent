---
"@roll-agent/browser": minor
"@roll-agent/browser-use-agent": minor
---

改进通用 Snapshot 的结构化选项识别，避免短下拉被父容器吞并，并保留已有 AX 语义角色。

新增受控 page.inspectControl / page.choose helpers，支持字段与面板关联、明确作用域、原生及自定义单选控件和结果验证；关联不明、重复选项或未产生预期状态时停止。已有 BOSS 预编排不增加执行步骤。

通用输入增加同源 iframe 祖先遮挡与焦点检查；跨源或无法可靠检查的坐标变换停止输入，并返回域名边界或覆盖缺口信息。
