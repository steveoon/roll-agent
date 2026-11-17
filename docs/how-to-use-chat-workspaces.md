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

聊天内 `/resume` 打开对话历史，分为“本项目下的对话”和“旧会话”两组；旧会话指没有项目归属的会话。当前打开的会话也会列出并标注“当前打开”，列表初始选中它；选择它可直接返回聊天，不会重新打开或关闭会话。刚创建的空会话会显示“（新会话，暂无消息）”。当前项目没有其他历史时，旧会话仍可直接选择，无需额外命令。

Ink 全屏列表显示每组数量，并将更新时间、消息数和状态按列对齐。“当前打开”以绿色显示，其他客户端“占用中”或“状态未知”以黄色显示；普通可用会话不重复显示状态。窄终端优先保留标题和状态，底部操作栏统一显示位置与快捷键；选中被占用的会话时，宽度允许则在操作栏显示占用客户端名称。

Ink 列表中按 Enter 继续所选会话；选中旧会话时，底部会显示 `m 归入本项目并继续`。当前打开的旧会话则显示 `m 归入本项目`，可以原地归类。基础 REPL 选中旧会话后提供对应的继续/返回与归类选项。归类保留原会话 ID、消息和工具历史，仅更新项目归属；成功后，当前项目的 `/resume`、`--list` 和 `--last` 都会将其视为本项目会话。归类当前会话失败时仍保留当前会话与上下文。仅恢复对话不会自动归类，已有其他项目归属的会话不能通过此操作移动。

`/resume all` 和 `--all-projects` 可跨项目查看全部会话，列表会显示会话是否正在被使用及对应客户端名称。`/view <id>` 与 `--view <id>` 以只读方式打开历史，不会锁定会话，也不会触发迁移或清理；即使另一个终端或客户端正在使用该会话，你依然可以查看其中已保存的消息。若要恢复某个会话继续发言或修改其项目归属，则要求该会话当前未被其他客户端使用——遇到占用提示时，请先在另一端退出该会话后再重试。

## 选择配置来源

```sh
cd /projects/a
roll chat \
  --config /settings/roll.config.yaml \
  --config-workspace /settings
```

参数校验和相对路径解析规则详见 [Runtime 配置上下文](runtime-config-context.md)。传入 `--config-workspace` 时，配置文件中的以下相对路径均以该配置工作区为基准解析：

- `runtime.threads-dir`（会话历史目录）
- `agents.data-dir`（Agent 数据目录）
- `skills.dirs`（额外 Skill 目录）
- 显式文件路径形式的 `chat.instructions`
- `browser.instances.*` 下的 `executable-path`、`user-data-dir` 与 `sessions-dir`

工具的实际执行目录、项目内自动发现的 `.agents/skills` 以及自动发现的 `AGENTS.md`（`chat.instructions: auto`）仍以当前终端执行目录为准。未传 `--config` / `--config-workspace` 时，按默认规则从当前目录向上查找 `roll.config.yaml` 并相对配置文件所在目录解析路径。

启动 `roll chat` 后，所选配置文件与配置工作区即在本次会话中固定，初始配置向导的检测、写入以及 Agent 初始化也沿用同一来源，聊天中途不会自动重读或切换到其他配置文件。在绑定了配置文件的聊天会话中创建的定时任务会自动记录该配置来源引用（不保存密钥本身），后续每次执行时从原配置来源读取最新配置；若当前会话未找到任何配置文件而使用内置默认配置，创建的定时任务不绑定特定配置文件，后续执行时按任务自身工作目录（`--cwd`）查找配置。

## 查看当前配置与切换模型

全屏 TUI（Ink）与基础 REPL 的 `/status` 均显示当前项目、启动时选择的配置文件和实际生效的 Provider/模型。`/fast` 在全屏 TUI 与基础 REPL 中均可切换 Fast 模式；`/model`（切换会话内模型并可选设为默认）与 `/effort`（调整推理强度）仅在全屏 TUI 模式下支持。

修改 `roll.config.yaml` 后，退出当前聊天并在同一目录（附带相同配置参数）运行 `roll chat --last` 或 `roll chat --session <id>`，即可使用新配置继续原对话，历史消息与工具记录完整保留。会话进行期间配置文件若被修改或删除，不会中断当前正在进行的对话。命令行参数 `--provider`、`--model`、`--account`、`--fast` 优先于配置文件中的默认值。

未绑定配置文件时，`/status` 显示“内置默认配置”；聊天期间新建的配置文件需重启 `roll chat` 后才会生效。

## 升级共享会话库

共享会话库当前使用 schema `v12`，通过可空的 workspace 字段记录项目归属。正常启动 `roll chat` 时，旧版会话库会自动完成备份、校验与升级并继续进入聊天，无需手动执行迁移命令或卸载后台调度服务。升级完成后终端会输出备份文件路径，后续打开不会重复迁移。

如果另一个 CLI、桌面端或正在运行的定时任务正占用该库中的会话，自动升级会中止并保留原库不变；退出占用会话或等待任务结束后重试即可。空闲的后台调度服务不会阻碍升级。备份或迁移失败时原库保持不变；高于当前版本的未知数据库不会被降级。

需要离线单独维护会话库时，可执行显式迁移命令：

```sh
# 确认使用该会话库的所有客户端已停止后执行
roll runtime migrate --confirm-stopped-clients
```

> **Node.js 22.6–22.12 提示**
>
> `roll` 启动器仅对 `chat`、`schedule`、`doctor`、`update` 四个子命令自动注入 `--experimental-sqlite`。若在 Node.js 22.6–22.12 下运行 `roll runtime migrate`，请先升级至 Node.js >=22.13，或显式附带环境变量运行：
>
> ```sh
> NODE_OPTIONS=--experimental-sqlite roll runtime migrate --confirm-stopped-clients
> ```

如需指定会话库目录，可传入 `--threads-dir <dir>`（配置来自其他目录时，请指向该配置实际解析出的 `threads-dir`）。显式迁移同样会先创建并校验备份，已有会话消息与未分类状态保持不变。

受支持的旧版会话库仍可通过 `--list --all-projects`、`--view` 只读查看。仅支持 schema `v11` 的旧版 CLI 或桌面端无法打开升级后的 `v12` 会话库；多个客户端共用同一会话库时，请先统一升级至支持 `v12` 的版本。
