---
"@roll-agent/browser": minor
"@roll-agent/browser-use-agent": minor
---

新增 native CDP `Page.reload` 恢复能力，用于长跑 BOSS tab 的周期性恢复。

- `@roll-agent/browser`：`NativeCdpController` 新增 `reload({ url?, ignoreCache?, timeoutMs? })`，并将 `Page.reload` 加入 native CDP 方法 allowlist；走现有 `preflightAction`（actionPolicy / domainAllowlist）边界，不触发 Playwright attach。
- `@roll-agent/browser-use-agent`：
  - 新增通用 tool `browser_reload_active_tab`，对当前 tracked native page 执行 reload，采用 document 身份哨兵检测换页完成（规避同 URL 下 readyState 假阳性）。
  - `zhipin_open_chat_page` 新增 `forceReload` 入参与 `usedReload` / `reloadSkippedReason` 输出；仅在当前确为可恢复的 BOSS 沟通页时 reload，否则返回结构化 `not_chat_page`，并支持 `browserActionApproval` 回环。
  - reload 后所有 `@eN` / `candidateRef` / `jobRef` 失效，须重新 snapshot / 读列表（SKILL.md 与 references/zhipin-workflows.md 已补充能力边界）。
