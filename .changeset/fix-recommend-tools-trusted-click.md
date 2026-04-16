---
"@roll-agent/browser-use-agent": patch
---

fix(browser-use): 推荐列表工具消除合成点击 isTrusted: false 风控风险

zhipin_say_hello 和 zhipin_open_resume 的点击操作从 evaluate() 内合成 MouseEvent 改为 Playwright locator.click()，生成 isTrusted: true 事件，降低 Boss 直聘动作级反自动化检测风险。

- 新增 recommend-list.ts 公共 helper，统一推荐列表的 frame 定位、列表等待、卡片信息只读提取
- zhipin_say_hello: 移除 dispatchEvent(mousedown/mouseup/click) + btn.click()，改为 locator.scrollIntoViewIfNeeded() → hover() → humanDelay() → click()
- zhipin_open_resume: 移除 evaluate 内 item.click()，改为 locator 定位 clickSurface → hover() → randomDelay() → click()
- 保留原有时序随机化逻辑（humanDelay、performRandomScroll）
- zhipin_get_username: 修复 lazy attach 后因 hasContext 前置检查导致的"未找到已跟踪页面"回归，改为 getPage() 自动发现并绑定页面
- zhipin_send_reply: 发送按钮点击从 evaluate 内 btn.click() 改为 Playwright locator.click()，data-roll-send-btn 清理移入 finally 防残留
- chat-navigation: clickMessageEntry() 和 clickChatItem() 从 evaluate 内 DOM click 改为临时 marker + Playwright locator.click()，新增 clearTemporaryMarker/clickMarkedElement 共用 helper
