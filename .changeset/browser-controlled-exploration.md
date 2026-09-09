---
"@roll-agent/browser": minor
"@roll-agent/browser-use-agent": minor
"@roll-agent/runtime": minor
---

新增通用页面受控 JavaScript 组合执行、结果断言、严格 Snapshot/ref 绑定和有界观察。脚本仅通过受控浏览器 helpers 执行，支持整段审批、取消和资源限制；已有 BOSS 预编排保持独立。

新增版本化站点经验草稿、显式验证/启用、按 URL 发现及执行入口。草稿不自动执行或启用，失效版本暂停推荐。

Runtime 对明确标记未执行的工具审批请求使用现有客户端确认通道，批准后仅携带绑定凭据续接一次；取消或部分完成不会自动重放。
