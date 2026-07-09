---
"@roll-agent/core": minor
---

新增 `roll setup` 一键初始化命令，串起新设备 onboarding 全流程：LLM 配置 → 安装网络（可选）→ 官方 Agent 多选安装（来自 catalog，标注已装/可更新状态）→ 缺失环境变量引导 → `roll doctor` 检查摘要。

- 全程 clack 交互（stderr），已有配置时询问是否重配；任一环节取消即退出，agent 安装失败不阻断后续环节
- `installAgent()` 在启动前检查必填环境变量：core-managed Agent 缺 env 时跳过自动启动（不再硬启动失败），返回 envReport 交由调用方引导配置，setup 配置后提示 `roll agent start`；chat onboarding 对缺 env 的已装 Agent 输出配置提示，结束语引导 `roll setup` / `roll doctor` 补全检查
- `setupLlm` / `setupInstall` / `setupAgentEnv` 成功消息明示配置写入路径（新设备通常为 `~/roll.config.yaml`）
- 修复 clack text 输入 `required + defaultValue` 组合下默认值不可用的问题：此前直接回车报「此项不能为空」且看不到默认值；现在空输入回退 defaultValue，且默认值兜底显示为 placeholder（影响 setup 的 model、fetch-retries 等所有带默认值的必填输入）
- 新增 `roll config setup shell` 模块：交互式配置 `runtime.shell`（chat 内建 shell 工具开关、POSIX 安全命令自动放行、session exec），并挂入 `roll setup` 编排为可选步骤；`roll config setup bash` 保留为兼容 alias，但写入新字段。所有默认值保持「关」，开启必须显式选择。同步把 `runtime.shell` 段补进 config key-codec，修复 `config set/get` 对该段 kebab-case 键名不转换的问题
- 复用既有模块：`roll config setup` 的 llm/install/agent-env 向导函数（本次导出）、catalog 可用性检查、doctor 命令
- 前置重构：`roll agent install` 的安装编排抽为 `registry/install.ts` 的 `installAgent()`——纯函数化（不写 exitCode、不直接打日志），进度经 reporter 事件回调（step/info/warn/success/retry），失败返回 `{ ok: false, step, message, retryCommand? }` 六阶段状态机（resolve/download/discover/setup/register/start），协作函数全部可注入测试；CLI 命令变薄壳，行为与输出保持不变
- `roll agent add` / `roll agent install` 的安装后 env 引导抽为共享 `agent-env-guidance.ts`
