---
"@roll-agent/browser": minor
"@roll-agent/browser-use-agent": minor
---

feat: 简历详情弹窗全链路 native CDP 化，新增 zhipin_capture_resume 长图截取工具

- `@roll-agent/browser`：`NativeCdpController` 新增 `Page.captureScreenshot` allowlist 与 `captureScreenshot()` 方法（支持 clip/scale）
- `zhipin_open_resume` / `zhipin_locate_resume_canvas` / `zhipin_close_resume` 摆脱 Playwright attach，全部改走 native CDP（isolated world + Input dispatch），修复 attach 掉线与页面异常刷新问题
- 新增 `zhipin_capture_resume`：滚动分段 + 浏览器内离屏 canvas 拼接，输出完整简历 PNG 长图（实测 7448px 全量）；适配 smooth-scrolling 滚动容器、canvas 视口窗口重绘机制与 getImageData 读取防御（drawImage 指纹确认）；canvas 空白（DOM 文本渲染版式）时回退弹窗区域截图（captureMode: dom-screenshot）
- 编排器读取 `imagePath` 用自身多模态能力理解简历内容（方案 B：工具只产图，不做内容理解）
