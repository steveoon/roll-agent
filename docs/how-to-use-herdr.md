# 在 Herdr 中查看 Roll 的 Agent 状态

在 Herdr 桌面客户端的终端里启动交互式 `roll chat`，Roll 会通过 OSC 7501（Program Status Protocol）上报自身状态。Herdr Core 接收这些事实后，客户端的 Agents 列表即可显示 Roll，并按状态排序、提示需要关注的回合。

这不是旧终端版 `herdr` CLI 集成，不需要安装 Herdr skill，也不需要设置 `HERDR_ENV=1`。Herdr 客户端和 `hc` 应按各自官方说明安装；Roll 不会替你安装或重启它们。

## 自动启用条件

同时满足以下条件时启用，无需新增 Roll 配置：

- 当前是交互式聊天，覆盖 Ink 全屏与基础 REPL（`roll chat --screen-mode inline`）。Ink 启动失败回退到基础 REPL 时沿用同一个上报器。
- 进程继承了非空的 `HC_TERMINAL_ID`。
- 标准输入、标准输出和标准错误均为 TTY。

普通终端、输入或输出重定向、单次 `roll chat "消息"`、`--json`、`chat --server` 与 `runtime serve --stdio` 不输出状态控制序列。无需手动伪造环境变量；终端身份标识只是启用信号，不是权限认证。

## 状态含义

| 状态 | Roll 何时上报 |
| --- | --- |
| `idle` | 首次准备好接收输入；用户主动取消（`reason=user`）且执行收尾完成；成功切到另一个空闲会话 |
| `working` | 接受用户回合后，包括连接准备、模型生成、工具执行和压缩；解除审批或表单等待后继续 |
| `blocked` / `permission` | 实际显示权限确认并等待用户选择；自动批准不产生此状态 |
| `blocked` / `question` | 实际等待用户填写补充信息表单 |
| `done` | 整个回合迭代与收尾正常完成；也用于手动 `/compact` 完成 |
| `error` | 回合终止错误、未恢复异常或非用户中止（`reason=timeout/runtime`）；单个工具失败、可恢复模型重试不等同于整轮失败 |
| `clear` | 交互式 CLI 退出时清理上报记录 |

`done` 表示这一轮已经结束，不保证整个用户目标完成。工具启动的后台进程可能仍在运行；其进度不自动延长主回合。状态报文只包含固定应用身份 `roll`、状态和等待类型，不包含用户消息、工具参数或会话内容。

审批等待会遵守可选的 `expiresAt`：到期自动拒绝并释放界面，已过期或非法截止期不会显示可授权提示，也不会闪过 `blocked`；缺省截止期兼容旧事件。拒绝或过期一次审批并不自动使整轮失败，最终状态仍取决于 Runtime 的回合结果。

UI 恢复到输入框不会立即用 `idle` 覆盖 `done/error`。Herdr 客户端可能在你查看完成的回合后显示 `idle`，这是客户端的已查看语义，与 Core 保存的根状态事实不同。

## 排查未出现在 Agents 列表

1. 确认正在运行包含该集成功能的 Roll 版本，而非尚未更新的全局旧版本。源码改动不会热更新已经运行的 CLI。
2. 在对应终端的 shell 中检查 `printf '%s\n' "$HC_TERMINAL_ID"`，不要把命令当作 Agent 聊天消息输入。
3. 在另一个 shell 中执行 `herdr-app ls`，找到 Roll 对应的终端编号，然后读取：

   ```sh
   hc get <终端编号> --json
   ```

   正常运行时应能看到 `reported: true`，以及 `status.app: "roll"` 和当前状态。正常退出后 `status` 应清空；`reported` 表示历史上报过，不必恢复为 `false`。

4. 如果 Roll 仍有终端标题但 `reported: false`、`status: null`，检查启用条件和版本，而不是修改侧边栏过滤逻辑。

上报是尽力而为：写入失败会停用本实例的状态上报，不会中断聊天。强制杀进程、掉电或终端本身不可写时，不能保证 Roll 发出最后的 `clear`；Herdr Core 也会根据终端进程结束处理状态。

## 开发验证

确定性测试入口：

```sh
env NODE_ENV=test node --experimental-strip-types --experimental-sqlite --test \
  packages/core/src/cli/chat/terminal-agent-status.test.ts \
  packages/core/src/cli/chat/ink/use-session-status.test.ts \
  packages/core/src/cli/commands/chat-status.test.ts \
  packages/core/src/cli/commands/chat-status-entry.test.ts \
  packages/core/src/cli/chat/ink/terminal-agent-status.pty.test.ts \
  packages/core/src/cli/chat/ink/permission-deadline.pty.test.ts \
  packages/core/src/cli/utils/chat-renderer.test.ts
```

PTY 测试需要 Unix 与 Python 3；不具备条件时会跳过，不能将跳过当成真实终端验收通过。它使用离线会话驱动实际 Ink/基础 REPL，覆盖等待、成功、错误、取消、手动压缩、缩放与清理，而不是直接打印 OSC 模拟 Roll。

可重复实机驱动 `packages/core/src/cli/chat/ink/fixtures/herdr-review.e2e-harness.ts` 使用真实 AgentSession 和离线模型：参数为 `ink|basic model|permission|success|cancel <新建门控目录>`。model/permission 在 5 秒后真实超时；success 等待目录中的 `finish` 文件；cancel 在工作中按 Esc（Ink）触发真实取消。驱动不直接打印 OSC；不可把这些模拟模型结果表述为真实 Provider 验收。

真实 Herdr 验收还应在专用测试终端中检查 `hc get` 的状态及客户端 Agents 条目；不得通过重启用户 Core、修改用户配置或打断现有 Agent 来完成验证。
