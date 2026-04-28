# BOSS直聘 CDP/风控诊断

`zhipin_diagnose_browser_state` 用于把 BOSS 页面回退/风控触发点拆成可观测阶段。它不是业务读取工具，也不负责规避检测。

## 触发场景

- 调用 BOSS 工具后页面自动 `history.goBack()` 或回到上一页。
- 某个账号或浏览器 profile 触发异常，其它账号不触发。
- 需要判断异常来自 native CDP 连接、Playwright attach、`Runtime.evaluate`、DOM 读取、storage/cookie 读取还是网络上报。

## 阶段模型

```text
低侵入:
native -> native-watch

native CDP page WebSocket:
native -> native-ws-connect -> native-page-bring-front
native -> native-ws-connect -> native-evaluate-url-no-runtime-enable
native -> native-ws-connect -> native-dom-read-no-runtime-enable
native -> native-ws-connect -> native-input-move-no-runtime-enable
native -> native-ws-connect -> native-runtime-enable -> native-evaluate-url -> native-dom-read

Playwright attach:
native -> browser-attach -> browser-attach-watch -> page-attach -> network-watch
native -> browser-attach -> browser-attach-watch -> page-attach -> page-evaluate -> detector-fingerprint -> storage-summary
```

## Phase 说明

| `phase` | 动作 | 诊断问题 |
| --- | --- | --- |
| `native` | 只调用原生 CDP `/json/list` 枚举页面 | 当前有哪些 BOSS target；最低风险默认阶段。 |
| `native-watch` | 不 attach，在 `watchMs` 内重复读取 URL/title | 不连接 Playwright 时页面是否自己跳转。 |
| `native-ws-connect` | 连接目标页 `webSocketDebuggerUrl`，不调用 Playwright/Puppeteer | 仅建立 native page WebSocket 是否触发。 |
| `native-page-bring-front` | 发送 `Page.bringToFront`，不调用 `Runtime.enable` | Page domain 前台切换是否触发。 |
| `native-evaluate-url-no-runtime-enable` | 直接 `Runtime.evaluate` 读取 URL/title，不先 `Runtime.enable` | 是 `Runtime.enable` 独有触发，还是 evaluate 本身触发。 |
| `native-dom-read-no-runtime-enable` | 直接 `DOM.getDocument`，不先 `Runtime.enable` / `DOM.enable` | DOM domain 最小读取是否触发。 |
| `native-input-move-no-runtime-enable` | 直接 `Input.dispatchMouseEvent(mouseMoved)` | Input domain 最小事件是否触发。 |
| `native-runtime-enable` | 发送 `Runtime.enable` | Runtime domain 是否触发。 |
| `native-evaluate-url` | 读取 `location.href`、`document.title`、可见状态 | 最小页面 JS evaluate 是否触发。 |
| `native-dom-read` | DOM 摘要读取，只返回数量/长度 | DOM 读取是否触发。 |
| `browser-attach` | 执行 `runtime.getBrowser()` 并观察 native URL/title | Playwright Browser CDP 连接是否触发异步回退。 |
| `page-attach` | 执行 `ctxManager.getPage("zhipin")` | 绑定具体页面/context 是否触发。 |
| `network-watch` | 监听相关 request/response 和 frame navigation | attach 后是否出现 APM/security 上报或 URL 自动变化。 |
| `page-evaluate` | Playwright 页面内最小 evaluate | 页面 JS evaluate 是否触发。 |
| `detector-fingerprint` | 读取 `navigator.webdriver`、`window.cdc_*`、Playwright binding 标记 | 是否暴露自动化指纹。 |
| `storage-summary` | 读取 storage/cookie 脱敏摘要 | storage/cookie 读取是否触发。 |

## 推进规则

1. 先调用 `zhipin_diagnose_browser_state()` 或 `phase="native"`。
2. `nativePages` 只有一个 BOSS 页时可递进；多个 BOSS 页时后续必须传 `targetPageId`。
3. 高风险账号先跑 `native-watch`。
4. 验证 native CDP 时先跑 `native-ws-connect`，再跑 no-`Runtime.enable` 分支。
5. 每次只推进一个阶段，并在每次调用后观察 `nativeTimeline`。
6. `browser-attach` 失败，或 `browser-attach-watch` 出现 `urlChangedFromPrevious=true` 时，停止调用 Playwright-backed BOSS 工具。
7. 任意 `native-*-watch` 快照出现 `urlChangedFromPrevious=true` 时，停止加深 native CDP 实验。
8. 只有需要复现 `Runtime.enable` 红线时才跑 `native-runtime-enable`。
9. 要验证网络上报，只在 `browser-attach` 未触发 URL 变化后继续跑 `page-attach` / `network-watch`。
10. `storage-summary` 只返回脱敏摘要；禁止要求或传播 cookie/localStorage/sessionStorage 原始值。

## 返回字段

| 字段 | 含义 |
| --- | --- |
| `nativePages` | 原生 CDP 页面列表，`pageId` 可作为后续 `targetPageId`。 |
| `targetPage` | 本次绑定或诊断的 BOSS 页面。 |
| `browserAttached` / `pageAttached` | 是否进入 Playwright attach 阶段。 |
| `nativeTimeline` | 每个阶段后的 native URL/title 快照；`urlChangedFromPrevious=true` 是关键触发证据。 |
| `nativeCdp` | native CDP 探测摘要，不包含页面正文。 |
| `networkEvents` | APM/security 请求摘要，不抓请求体。 |
| `navigationEvents` | attach 后 frame URL 变化。 |
| `detectorFingerprint` | 自动化相关公开标志。 |
| `phases` | 阶段成功状态、耗时、错误。 |
| `warnings` | 多页面、目标页缺失、URL 变化等边界提示。 |
| `storage` | storage/cookie 脱敏形状、长度和计数器差分。 |
