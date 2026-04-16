---
"@roll-agent/browser-use-agent": patch
---

fix(browser-use): 推荐列表工具消除合成点击 isTrusted: false 风控风险

zhipin_say_hello 和 zhipin_open_resume 的点击操作从 evaluate() 内合成 MouseEvent 改为 Playwright locator.click()，生成 isTrusted: true 事件，降低 Boss 直聘动作级反自动化检测风险。

- 新增 recommend-list.ts 公共 helper，统一推荐列表的 frame 定位、列表等待、卡片信息只读提取
- zhipin_say_hello: 移除 dispatchEvent(mousedown/mouseup/click) + btn.click()，改为 locator.scrollIntoViewIfNeeded() → hover() → humanDelay() → click()
- zhipin_open_resume: 移除 evaluate 内 item.click()，改为 locator 定位 clickSurface → hover() → randomDelay() → click()
- 保留原有时序随机化逻辑（humanDelay、performRandomScroll）
