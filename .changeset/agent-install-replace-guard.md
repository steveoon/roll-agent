---
"@roll-agent/core": minor
"@roll-agent/runtime": patch
---

`roll agent install` 同名冲突改为显式授权替换，防止静默覆盖本地/Git 来源的 Agent 注册。

- 同名 Agent 已通过 `local-path` / `git` 等非 npm 来源注册时，安装默认失败并给出两条出路：`roll agent remove <name>` 或新增的 `--force` 标志（确认风险后替换为 npm 安装）
- catalog 短名安装在 npm download 前预检冲突，零副作用提前失败；非 catalog 包在 discover 后拦截，并清理本次新建的安装目录，不留孤儿目录（既有目录如 npm 升级场景不受影响）
- `roll setup` 向导对「已通过其他来源注册」的官方 Agent 维持替换语义（选项文案已明示），自动授权替换；chat 会话内 `roll__agent_install` 不授权替换，冲突时如实返回失败原因与终端处理指引
- 替换在线 core-managed 旧 Agent 且新版本未随即启动（缺必填 env 或 `--no-start`）时，优雅停止旧进程并将注册状态归位 idle，不再遗留运行旧代码的孤儿进程；setup 阶段失败同样停止旧进程
- 修正 `roll agent install --start` 帮助文案与默认语义相反的问题（默认自动启动，`--no-start` 跳过）
