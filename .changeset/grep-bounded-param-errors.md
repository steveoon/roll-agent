---
"@roll-agent/runtime": patch
---

roll__grep 的 `context` / `max_results` 边界现在写进参数描述（模型第一次调用即知范围），越界时在审批前以一句话 invalid_input 拒绝，说清「哪个参数、允许范围、你传了什么」。新增共享 helper `boundedIntParam`：描述文案与运行时校验由同一份 min/max 派生，避免再次漂移；其它带数值边界的工具可复用。
