---
"@roll-agent/browser-use-agent": minor
---

zhipin_capture_resume 全程 visual 反馈，消除滚动截图期间的无提示等待

- 复用 NativeVisualActivitySession：开始显示「正在读取简历」胶囊 + 视口光晕，滚动拼接中按实测位移显示百分比进度（总量来自 stitch init 新返回的 maxScrollTotal），完成/失败分别以 success/error 主题收尾
- 首轮滚动位移尚未实测时不显示「0%」，有真实位移后才出现百分比
- dom-screenshot / viewport-clip 路径在 Page.captureScreenshot 前主动 clear overlay 并等待淡出，确保反馈层不会进入简历截图
- `captureResumeCanvas` 新增可选 `onProgress` 回调（导出 `NativeResumeStitchProgress` 类型），既有调用方不受影响
