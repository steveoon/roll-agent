---
"@roll-agent/browser-use-agent": patch
"@roll-agent/runtime": patch
---

简历工具链 code review 修复（8 项）

- `zhipin_locate_resume_canvas` 改用轻量几何探测 `readResumeCanvasGeometry()`，不再跑完整滚动拼接（实测 ~20s → 0.5s），恢复 5s canvas 等待与结构化错误返回，`canvasInfo` 语义回归 canvas 缓冲区尺寸
- `zhipin_capture_resume` / `zhipin_open_resume` 补 catch：CDP 中途异常不再泄漏为 raw MCP 错误，visual 反馈以 error 态收尾而非永久残留「正在读取」胶囊
- `zhipin_capture_resume` 的弹窗等待预算 3s → 12s，与 `zhipin_open_resume` 对齐，消除慢网下的过早失败
- 关闭按钮搜索限定在可见 dialog 容器作用域内（`.close-btn` 等通用选择器不再可能命中主文档无关元素）
- 弹窗关闭判定加入 iframe 可见性（站点隐藏而非卸载弹窗时不再误报"未关闭"）
- Escape 兜底按键补 `windowsVirtualKeyCode: 27`（此前合成事件 keyCode 为 0，legacy 键盘监听收不到）
- 打招呼/打开卡片两个点击表达式去重为共享 builder，消除 DOM 变更时的双份维护漂移
- runtime：relocate 的工具图像只保留最近 2 条消息的图，更早的替换为占位文本，长会话不再每轮重发全部历史图（用户自发的图像消息不受影响）
