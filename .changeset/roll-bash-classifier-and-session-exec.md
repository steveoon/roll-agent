---
"@roll-agent/runtime": minor
"@roll-agent/core": minor
---

roll chat 的内建 bash 能力新增两项（在 T0 `roll__bash` 基础上）：

**T1a — 命令分类器（`runtime.bash.auto-approve-safe`，默认开启）**

纯 JS 规则分类器把命令分为 known-safe / dangerous / unknown。known-safe 只读命令（`ls`/`cat README.md`/`git status`/`grep -r TODO src` 等）自动免确认执行，dangerous（`rm -rf`、`sudo`）与 unknown 仍需人工确认。设计借鉴 codex 的白名单 + 逐命令 flag 审计（`find` 拒 `-exec`/`-delete`、`git` 只放行只读子命令并拦全局 `-c`/`--git-dir`、`sed` 仅 `-n Np`、`base64` 拒写文件等），复合命令用保守词法方案（含 `$`/反引号/重定向/子 shell 等危险元字符即降级为 unknown）替代 tree-sitter，误判方向永远偏向"更保守 → 走确认"。

免确认有**工作区边界**：吃路径的命令出现绝对路径、`~` 或 `..` 参数（如 `cat ~/.ssh/id_rsa`、`find / -name x`、`rg secret /Users/x`）即降级 unknown 走确认，`grep`/`rg` 的 pattern 参数与 `echo` 等非文件命令豁免以避免误报；`workdir` 参数逃出会话根目录同样强制确认。分类器经 config→engine→session 注入，gate/policy 零改动。关掉 `auto-approve-safe` 回归 T0 的每条确认。

**T2 — 会话式执行（`runtime.bash.session`，默认关闭）**

新增两个内建工具 `roll__exec_command` + `roll__exec_poll`，解决长脚本（如 zhipin `reply-unread-safely.sh`，几十秒到几十分钟）被单轮 `turnTimeout` 杀掉的问题。`exec_command` 后台启动命令、等待一个 yield 窗口后返回：进程结束则给退出码，未结束则返回 `session_id`；`exec_poll` 用该 id 空轮询续查进度、读退出码，或发送 Ctrl-C 哨兵（U+0003）中断。借鉴 codex `unified_exec` 的 yield-then-return-partial 与后台隐式化，采精简版：pipe 会话（不引 node-pty native 依赖）、会话池只回收已退出槽（满则拒绝，不杀活进程）、head+tail 缓冲、机器可读干净环境（`NO_COLOR`/`TERM=dumb`/`PAGER=cat`）。

**关键安全与生命周期**：会话进程绝不绑 turn 的 abortSignal，得以跨轮存活突破 `turnTimeout`；`exec_command` 走与 bash 同一套 gate（`--server` 下需 `runtime.approval.overrides: { "roll.exec_command": "auto" }` 显式授权），`exec_poll` 只轮询/中断不过 gate；session exec 只在交互 REPL 与 `--server` 长驻模式注册——单条消息 / `--json` 单轮的会话随进程结束，不提供该工具，避免返回一个立即失效的 running session id；`AgentSession.abort()` 与 `roll chat` 退出的 finally 都会 `terminateAll()`（SIGTERM→SIGKILL 升级）杀掉背景进程组，杜绝 detached 进程残留。

审批记忆（本会话记住此命令）、沙箱、跨会话持久化审批规则列为后续阶段。
