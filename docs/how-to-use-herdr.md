# 在 Herdr 中查看 Roll 的 Agent 状态

在 Herdr 桌面客户端的终端里启动交互式 `roll chat`，Roll 会通过 OSC 7501（Program Status Protocol）上报自身运行状态。Herdr Core 收到状态更新后，客户端的 Agents 列表即可展示该 Roll 实例，按状态自动排序并提醒需要人工介入的回合。

这不是旧终端版 `herdr` CLI 集成，不需要安装 Herdr skill，也不需要设置 `HERDR_ENV=1`。Herdr 客户端和 `hc` 应按各自官方说明安装；Roll 不会替你安装或重启它们。

## 自动启用条件

同时满足以下条件时自动启用，无需新增 Roll 配置：

- 当前是交互式聊天，覆盖 Ink 全屏与基础 REPL（`roll chat --screen-mode inline`）。Ink 启动失败回退到基础 REPL 时沿用同一个上报器。
- 进程继承了非空的 `HC_TERMINAL_ID`。
- 标准输入、标准输出和标准错误均为 TTY。

普通终端、输入或输出重定向、单次 `roll chat "消息"`、`--json`、`chat --server` 与 `runtime serve --stdio` 不输出状态控制序列。无需手动伪造环境变量；终端身份标识仅作为启用信号，不作为权限认证凭据。

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

`done` 表示这一轮已经结束，不保证整个用户目标完成。工具启动的后台进程可能仍在运行，其进度不自动延长主回合。状态报文只包含固定应用身份 `roll`、状态和等待类型，不包含用户消息、工具参数或会话内容。

工具审批提示支持可选的超时时间（`expiresAt`）：到期后会自动拒绝并恢复界面；若收到时已经过期或截止时间格式无效，则会直接按拒绝处理，不会弹出确认框或短暂闪现 `blocked` 状态（未携带超时字段的旧事件兼容照旧）。单次审批被拒绝或超时并不会直接判定整轮失败，最终状态仍取决于本轮对话的整体执行结果。

回合结束后界面恢复到输入框时，Roll 不会立即发送 `idle` 覆盖刚上报的 `done` 或 `error`，以便你在切回该终端前仍能在列表中看到完成或报错提示。当你查看完该终端后，Herdr 客户端界面可能会将其标记为“已读”并显示为 `idle`，而 Herdr Core 内部仍保留 Roll 最后一次上报的原始状态记录。

## 排查未出现在 Agents 列表

1. 确认正在运行包含该集成功能的 Roll 版本，而非尚未更新的全局旧版本。源码改动不会热更新已经运行的 CLI。
2. 在对应终端的 shell 中检查 `printf '%s\n' "$HC_TERMINAL_ID"`，不要把命令当作 Agent 聊天消息输入。
3. 在另一个 shell 中执行 `herdr-app ls`，找到 Roll 对应的终端编号，然后读取：

   ```sh
   hc get <终端编号> --json
   ```

   正常运行时应能看到 `reported: true`，以及 `status.app: "roll"` 和当前状态。正常退出后 `status` 应清空；`reported` 表示历史上报过，不必恢复为 `false`。

4. 如果 Roll 仍有终端标题但 `reported: false`、`status: null`，请检查启用条件和 CLI 版本。

上报采用尽力而为策略：写入失败只会停用当前实例的状态上报，不会中断正常聊天。遇到强制杀进程、掉电或终端不可写时，Roll 可能来不及发出最后的 `clear`，此时由 Herdr Core 根据终端进程退出事件回收状态。

## 开发验证

本地运行相关单元与伪终端集成测试（其中 `*.pty.test.ts` 依赖类 Unix 环境与 Python 3）：

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
