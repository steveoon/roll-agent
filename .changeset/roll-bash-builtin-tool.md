---
"@roll-agent/runtime": minor
"@roll-agent/core": minor
---

新增内建 shell 工具，让 roll chat 能在本机执行 shell 命令，解锁"脚本编排型 skill"（如 roll-zhipin-unread-reply）在会话中的执行。macOS/Linux 注册 `roll__bash`，Windows 原生在检测到 PowerShell 7+ 时注册 `roll__powershell`。

设计借鉴 codex 的 shell 工具：单字符串 `command` + `workdir`（禁 cd）+ `timeout_ms` 参数；两阶段输出截断（捕获期硬字节帽 + 排干防死锁，模型侧保头尾中间截断）；超时/中止杀整个进程组并归一 exit 124；`tool-output-delta` 流式事件（限流）在 Ink TUI 与基础 REPL 实时渲染输出尾行。

**安全姿态（默认关闭，`runtime.shell.enabled`）**：

- shell 命令一律标记 `destructiveHint`，因此无论 `runtime.approval.default` 是 `guarded` 还是 `auto` 都需人工确认；只有显式配置 `runtime.approval.overrides: { "roll.bash": "auto" }` 或 `{ "roll.powershell": "auto" }` 才允许无确认执行。无策略时 fail-closed 强制确认。
- 审批 UI（Ink + 基础 REPL）完整展示 `command`（不截断）/ `workdir`（解析为绝对路径）/ `timeout_ms`，用户能看清将要执行的完整命令再决定。
- 命令继承 roll 进程的全部环境变量（含 API key），等同于用户本人开 shell；风险由审批门控制，工具描述已注明。
- 单条命令有效超时取 `min(timeout_ms, maxTimeoutMs, turnTimeoutMs)`，保证不会因超过整轮预算被 turn abort 突兀杀掉。

Windows session exec 暂不支持；审批记忆、沙箱、跨会话持久化审批规则留作后续版本。
