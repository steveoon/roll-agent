---
"@roll-agent/core": minor
---

调度执行环境显式化：修复定时任务中 stdio Agent「spawn node ENOENT」。exec 子进程启动时自动把自身 node 目录前置进 PATH（launchd/schtasks 最小环境下裸 `node` 命令可解析，Shell 工具与 dev-spawn 同步受益）；新增 `scheduler.env` 配置段，为定时任务运行环境声明代理、额外 PATH 等变量（值支持 `${ENV_VAR}` 占位符与 secrets.env 回退，每次运行前合入、同名覆盖）；`roll doctor` 新增「定时任务 Agent 命令可达性」检查，在模拟修复后调度环境的有效 PATH 下审计已注册 stdio Agent 的启动命令。
