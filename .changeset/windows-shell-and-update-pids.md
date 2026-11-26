---
"@roll-agent/runtime": patch
"@roll-agent/core": patch
---

修复 Windows 上通过 Microsoft Store 安装 PowerShell 7 后，Roll 可能跳过注册 Shell 工具的问题。`roll update` 遇到托管 Agent 占用时会区分服务进程和持有会话的 PID，生命周期锁冲突和停止超时也会显示已知的进程 PID。
