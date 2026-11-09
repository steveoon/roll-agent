# 在终端按项目使用 Roll Chat

`roll chat` 将新对话绑定到执行目录所属项目。Git 仓库内使用最近的工作树根目录，子目录与符号链接入口归到同一项目；不同 Git worktree 分开管理。非 Git 目录使用规范化后的当前目录。配置来源与项目归属彼此独立。

## 恢复与查看历史

```sh
cd /projects/a
roll chat                         # 在 A 创建新对话
roll chat --last                  # 继续 A 最近更新的对话
roll chat --list                  # 列出 A 的对话
roll chat --list --all-projects   # 所有项目及未分类历史
roll chat --last --all-projects   # 显式继续全局最近的对话
roll chat --session <id>          # 按 ID 明确选择对话，保留原项目归属
roll chat --view <id>             # 只读查看已提交历史
roll chat --view <id> --json      # 导出只读快照
```

当前项目没有可恢复会话时，`--last` 会报错，不会打开其他项目的会话。旧版历史没有可靠的项目来源，因此保留为“未分类”，可从全部项目列表查看或按 ID 恢复；不会根据当前目录自动重归类。

聊天内 `/resume` 打开当前项目会话列表，`/resume all` 查看全部项目；`/view <id>` 只读显示历史。列表显示占用状态及已知客户端名称。只读查看不获取可写占用，不迁移或清理历史；其他客户端正在使用时仍可查看已经提交的数据。继续写入时会重新原子获取会话占用。请先在另一端退出当前会话，再重试恢复。

## 选择配置来源

```sh
cd /projects/a
roll chat \
  --config /settings/roll.config.yaml \
  --config-workspace /settings
```

参数验证和相对资源解析遵循 [Runtime 配置上下文](runtime-config-context.md)。配置内相对的历史目录、Agent 数据、额外 Skills 和显式工程约定路径相对配置工作区解析；工具执行、自动项目 Skills 和自动发现的 `AGENTS.md` 继续使用执行目录。没有参数时保留原有发现及资源路径行为。

启动时固定所选配置文件，初始配置向导的检测、写入以及 Agent 初始化也沿用这一来源和资源工作区。后续重新加载不会发现其他文件作为替代。由聊天创建的定时任务继承这个配置来源和资源工作区；执行时从原来源读取最新配置，不保存凭证。未发现配置文件而使用内置默认值时，保持原有无绑定任务行为。

## 应用模型配置更新

Ink 与基础 REPL 都支持：

- `/status`：查看项目、配置文件、实际有效 Provider/模型和应用状态。
- `/reload`：从启动时绑定的文件重新加载模型、Provider、推理强度和模型凭证。

配置更新等待当前轮次（含确认、用户输入）或手动压缩完整结束后应用，保留会话上下文和工具资源。等待或失败期间不接受新的模型操作；修复配置后再次 `/reload`。错误提示不会显示凭证或完整 Provider 异常。Agent、会话目录等其他设置的变化要求重启。

没有绑定配置文件、仅用启动参数和 ChatGPT 登录信息开始的会话，`/reload` 会提示当前不可用，仍可继续发送消息和切换会话内模型。之后新建的配置文件不会被自动绑定；需要使用 `--config` 重新启动。已绑定来源的配置读取或应用失败仍会阻止新的模型操作。

启动时的 `--provider`、`--model`、`--account`、`--fast` 显式覆盖在重新加载后继续生效。`/model`、`/effort` 等会话内临时选择在 `/reload` 后回到最新文件设置加启动参数。ChatGPT 重载会验证所选账号是否提供目标模型以及推理档位和 Fast 能力；更换已经绑定的订阅账号需要重启。

## 升级共享会话库

共享会话库升级到 schema 12，用 nullable workspace 字段保存项目归属。现有库需要通过已有备份迁移流程升级，可写打开不会隐式迁移：

```sh
# 确认使用该会话库的所有旧客户端已停止后执行
roll runtime migrate --confirm-stopped-clients
```

需要指定库时使用 `--threads-dir <dir>`。配置来自其他目录时，应使用该配置指向的实际历史目录。迁移会先创建并校验备份，已有会话消息和未分类状态保持不变。

支持的旧库仍可使用 `--list --all-projects`、`--view` 只读查看。schema 11 的旧 Roll 或旧 Desktop bundled Runtime 无法打开迁移后的 schema 12；共享库的 CLI 和 Desktop 都应先更新到支持 schema 12 的版本。外部 CLI 升级不会替换 Desktop 内置 Runtime，需要重新发布 Desktop 包。

新 Protocol 1.6 可选方法 `thread.browse` 和 Node Client `browseThreads()` 提供项目归属及只读占用信息；已有 `thread.list` 返回格式不变。Desktop 可通过此接口接入项目归属，Desktop UI 的采用需在其仓库另行完成。
