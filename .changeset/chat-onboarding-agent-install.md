---
"@roll-agent/runtime": minor
"@roll-agent/core": minor
---

roll chat 支持新设备 onboarding：启动引导 + 会话内安装官方 Agent。

**启动引导（core）**：TTY 下 `roll chat` 检测到 LLM provider 未配置时，询问是否进入初始化向导（配置 LLM + 可选多选安装官方 Agent），完成后重新加载配置直接进入对话；拒绝、非 TTY、`--json`、`--server` 维持原报错行为。

**会话内安装（runtime + core）**：

- 新增内建 `roll__agent_install` 工具，输入 schema 从官方 catalog 短名派生（`z.enum`，不接受任意 npm 包名）；catalog 为空时不注册
- **强制确认门**：policy `deny` 可拒绝，但任何放行配置（含 `auto`）都仍需用户界面确认——安装会执行 npm install，policy 只能收紧不能绕过；确认 UI 复用现有 confirmation-required 事件链，`--json` 模式自动拒绝
- chat 内安装固定 `skipBrowserSetup`（规避 turn 超时），结果附终端补装命令与缺失 env 清单；启动走与 CLI 安装同一状态机（`installAgent` autoStart：starting → online/error + 失败清理），不经引擎隐式保活路径
- **会话内热刷新**（仅限新安装的 Agent）：安装成功后引擎连接新 Agent（`prepareAgentRefresh`）、会话合并新工具集 + 重建 skill library + 更新 system prompt（`applyAgentRefresh`），新工具从下一轮对话可用，无需重启会话
- system prompt 新增条件段：无已注册 Agent 时向模型注入官方可装清单与"须经用户同意才安装"的纪律；有 Agent 后该段自动消失
- 已知限制：会话内重装**已接入**的同名 Agent 时不热替换旧连接（MCP client 按名缓存），注册层仍幂等（store replace），工具结果如实提示"更新需重启 roll chat 生效"；Ink banner 的 agent 计数与 slash 补全列表为会话挂载时快照，重开会话后一致

引擎测试封闭性不变：`explicitSources` / `explicitAgents` 路径不启用安装工具，现有测试行为零变化。
