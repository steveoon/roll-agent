---
"@roll-agent/browser-use-agent": minor
---

移除 `zhipin_locate_resume_canvas` 工具，其探测能力并入 `zhipin_diagnose_browser_state` 的新 `resume-canvas` phase

- `zhipin_capture_resume` 自包含全部前置检查与定位，locate 在标准链路（open → capture → close）中从无必要调用
- 需要低成本排障时改用 `zhipin_diagnose_browser_state({ phase: "resume-canvas" })`：只读返回 `resumeCanvas` 段（弹窗可见性、iframe/canvas 就绪状态、截图坐标与 canvas 尺寸），不滚动、不截图
