# 使用 `roll schedule` 定时运行 Chat 任务

`roll schedule` 可以按固定间隔，在没有人守着终端时自动运行一轮 `roll chat`。
每次运行都会创建一个新线程，并把状态、结果摘要和失败原因写入本地账本。

本文中的两个术语：

- **任务（schedule）**：长期保存的定时规则，例如“每 30 分钟检查一次未读消息”。
- **运行（invocation）**：任务的一次具体执行。排查问题或取消运行时使用 invocation ID。

## 快速导航

- [快速开始](#快速开始)
- [常用命令](#常用命令)
- [理解运行状态](#理解运行状态)
- [重试、补跑和单例](#重试补跑和单例)
- [安全地取消运行](#安全地取消运行)
- [进程清理与平台差异](#进程清理与平台差异)
- [配置](#配置)
- [升级 roll / 切换 Node 之后](#升级-roll--切换-node-之后)
- [排查问题](#排查问题)

## 前置条件

- Node.js 版本不低于 22.6。
- 已安装 `roll`，并且 `roll --version` 可以正常运行。
- LLM 已配置；建议先确认 `roll doctor` 通过，且 `roll chat "hi" --json` 能返回
  `completed`。

> **Node.js 22.6–22.12**
>
> 已安装的 `roll` 启动器会为 `chat` 和 `schedule` 自动启用实验性的 `node:sqlite`。
> Windows 用户仍建议使用 Node.js 22.13 或更高版本。

## 快速开始

### 1. 登记任务

下面的任务每 30 分钟运行一次。`--now` 表示把首次运行设为立即到期；真正执行仍需要
daemon。

```bash
roll schedule add "检查未读消息并汇总，不要调用需要确认的工具" \
  --name "未读消息巡检" \
  --every 30m \
  --cwd ~/work \
  --now
```

`--every` 支持 `s`、`m`、`h`、`d` 四种单位，例如 `60s`、`30m`、`2h`、`1d`。
间隔最短 60 秒，最长 365 天。

`--max-run` 设定这个任务单次运行的时长上限，语法与 `--every` 相同，范围 60 秒到 24 小时，
缺省 1 小时。daemon 和 `run-now --inline` 都会在超过上限时终止本次运行；daemon 按失败
重试，`--inline` 只尝试一次并退出 1。需要跑几个小时的任务写
`--max-run 6h`；但更推荐把长任务拆成多轮短任务（每轮只处理固定数量，其余留给下一轮），
因为每次触发都是新线程，中途失败会整轮重来。`roll schedule list` 行尾和 `show --json` 的
`maxRun` / `maxRunMs` 会显示显式设置的值；字段缺省表示使用 1 小时默认上限。

`--cwd` 是任务实际运行时的工作目录，默认使用登记命令的当前目录。Roll 会保存该目录的
真实绝对路径，并在这里加载 LLM、Agent、Skill、Shell 和审批配置。

### 2. 前台试跑 daemon

首次使用时，建议先在前台运行 daemon：

```bash
roll schedule daemon --foreground
```

daemon 启动后会立即检查到期任务；空闲时最长每 15 秒检查一次。你应该很快看到类似下面的
触发日志：

```text
触发 未读消息巡检（schedule=… invocation=… attempt=1 max-run=3600000 ms）
```

任务何时完成取决于模型和工具的执行时间，并不保证在 15 秒内完成。按 Ctrl+C 可以停止
前台 daemon。

### 3. 安装用户服务

确认试跑正常后，可以把 daemon 安装成当前用户的常驻服务：

```bash
roll schedule service install
roll schedule service status
```

- macOS 使用 LaunchAgent。
- Windows 使用当前用户的 Scheduled Task，并在登录时启动。
- Linux 暂不提供内建安装命令；请用 systemd user unit 运行
  `roll schedule daemon --foreground`。

安装前请先退出同一 `data-dir` 上的前台 daemon。Roll 会等待这次安装对应的 daemon 真正启动；
仅仅完成 LaunchAgent / Scheduled Task 注册不算成功。如果启动握手失败，安装状态会保留为
`installing`，新触发不会被领取。处理报错原因后重新运行 `roll schedule service install` 或
`roll schedule service restart` 即可继续恢复。

### 4. 查看任务和结果

```bash
roll schedule list
roll schedule runs <schedule-id>
roll schedule status
```

如果某次运行已经创建线程，可以继续打开它：

```bash
roll chat --session <thread-id>
```

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 登记任务 | `roll schedule add <prompt> --name <name> --every 30m` |
| 列出任务 | `roll schedule list` |
| 查看任务详情 | `roll schedule show <schedule-id>` |
| 手动入队一次 | `roll schedule run-now <schedule-id>` |
| 前台执行并等待结果 | `roll schedule run-now <schedule-id> --inline` |
| 查看运行记录 | `roll schedule runs <schedule-id>` |
| 暂停任务 | `roll schedule pause <schedule-id>` |
| 恢复并重新授权 | `roll schedule resume <schedule-id>` |
| 取消一次运行 | `roll schedule cancel <invocation-id>` |
| 删除任务及其运行记录 | `roll schedule remove <schedule-id>` |
| 查看 daemon 状态 | `roll schedule status` |
| 查看用户服务状态 | `roll schedule service status` |
| 停止并卸载用户服务 | `roll schedule service uninstall` |
| 重启用户服务（升级 roll / 切换 Node 后） | `roll schedule service restart` |

大多数查询命令支持 `--json`。`roll schedule runs` 默认返回最近 20 条记录，也可以用
`--limit <n>` 调整数量。

## 理解运行状态

`roll schedule runs <schedule-id>` 可能显示以下状态：

| 状态 | 含义 |
| --- | --- |
| `pending` | 已入队，等待 daemon 接管 |
| `claimed` | daemon 已取得本次运行的所有权，exec 尚未正式开始 |
| `running` | exec 正在运行，或因退出/进程树状态无法确认而继续占用单例 |
| `retry` | 本次尝试失败，等待退避后重试 |
| `completed` | 已成功完成 |
| `needs_confirmation` | 任务已结束，但有工具调用因无人值守无法确认而被拒绝 |
| `failed` | 已终止，不会再自动重试 |

每次 invocation 都会创建一个标题为 `[定时] <任务名>` 的新 Chat 线程，不会自动继承上一轮
的上下文。

## 无人值守策略

定时任务使用与普通 `roll chat` 相同的 Agent 和工具，但不会等待人工输入：

- 原策略为 `allow` 或 `deny` 的工具调用保持不变。
- 原策略需要 `confirm` 的调用会直接改为 `deny`。
- 只要本轮出现这类拒绝，结果就会记录为 `needs_confirmation`，不会因此重试或暂停任务。
- 如果模型明确需要用户输入，本次尝试按普通失败处理，并进入下文所述的重试流程。

## 重试、补跑和单例

### 失败重试

普通执行失败后，Roll 会等待 10 秒再重试。默认最多尝试 3 次，即首次执行加两次重试。

- scheduled invocation 用完重试次数后会记录为 `failed`，并自动暂停任务。
- `run-now` 创建的 manual invocation 即使用完重试次数，也不会自动暂停任务。
- `run-now --inline` 只尝试一次；结果不是 `completed` 或 `needs_confirmation` 时，命令退出码
  为 1。
- 单次运行超过该任务的 `--max-run`（缺省 1 小时）时，daemon 会终止 exec 子进程并按失败重试；
  `run-now --inline` 也会按同一上限终止，但不重试。上一个 daemon 留下的孤儿 exec 也按各自任务的上限清理。

### 同一任务不会并行运行

同一个 schedule 同一时刻只允许一条 invocation 进入 `claimed` 或 `running`。仍持有未清进程树
的 `retry` 也会继续占用这个单例。

如果周期到期时上一轮仍未结束，Roll 不会为每个错过的周期分别排队。上一轮结束后，最多补
一次到期运行，然后从补跑时刻重新计算下次时间。

`run-now` 默认只负责入队：

- daemon 正在运行时，由 daemon 接管。
- daemon 未运行时，记录保持 `pending`，直到 daemon 启动。
- `--inline` 会由当前命令启动一个独立的 `roll schedule exec` 子进程，等待它结束并返回结果。
  它不依赖 daemon，但仍遵守该任务的 `--max-run`。如果同一任务已有运行，`--inline` 会退出 1；
  不加 `--inline` 则继续排队。

### 暂停与恢复

`pause` 只停止新的周期触发，不修改原来的 `nextRunAt`：

```bash
roll schedule pause <schedule-id>
roll schedule resume <schedule-id>
```

恢复时如果原定时间已经过去，任务会按“最多补一次”的规则执行。

暂停还会放弃尚未开始、进程树已清的 scheduled retry。manual invocation 不受影响；如果某条
运行仍持有未清进程树，它会继续保持 `retry` 或 `running`，直到完成清场或被显式放弃。

暂停状态下仍可以使用 `run-now` 手动试跑。若任务是因为权限摘要变化而暂停，应先执行
`resume` 完成重新授权，否则手动试跑也会因摘要不一致而失败。

## 权限配置变化

登记任务时，Roll 会保存以下配置的摘要：

- `runtime.approval.default`
- `runtime.approval.overrides`
- `runtime.shell.enabled`
- `runtime.shell.auto-approve-safe`
- `runtime.shell.session.enabled`

每次执行前都会重新计算摘要。无论配置变得更宽松还是更严格，只要与登记时不一致，就不会
执行模型：

- scheduled invocation 会失败并自动暂停任务。
- manual invocation 会失败，但不会自动暂停任务。

确认新配置后，用下面的命令重新授权：

```bash
roll schedule resume <schedule-id>
```

`resume` 会按任务 `--cwd` 中的当前配置更新摘要，即使任务原本已经是 `active` 也一样。

> 权限摘要目前不包含已注册 Agent 和 Skill 的变化。修改这些能力不会自动触发权限漂移保护。

## 安全地取消运行

先查出 invocation ID：

```bash
roll schedule runs <schedule-id>
```

### 取消尚未运行的记录

没有存活 exec 或未清进程树时，可以直接取消：

```bash
roll schedule cancel <invocation-id>
```

这通常适用于 `pending`、尚未开始的 `claimed`，以及不再持有进程树的 `retry`。

### 终止运行中的记录

`running` 或仍持有进程树的记录需要 `--kill`：

```bash
roll schedule cancel <invocation-id> --kill
```

在 POSIX 上，Roll 会先发送 SIGTERM，让 active turn 和 Bash 协作清理；grace 结束后仍未退出
才升级为 SIGKILL。只有确认 exec 已退出、且可枚举进程树已经清空，账本才会写入终态并释放
单例。

如果进程仍存活、身份无法验证、进程树无法枚举，或者这条 invocation 已被另一个 worker
接管，取消会失败并保持原状态。

### 最后的人工出口：`--abandon`

只有在进程身份或持久化树状态无法验证时，才考虑：

```bash
roll schedule cancel <invocation-id> --abandon
```

> **危险**
>
> `--abandon` 不会确认或终止旧进程，只是放弃追踪并释放单例。旧进程如果仍在运行，可能继续
> 发送消息、修改文件或产生其他副作用。

`--kill` 与 `--abandon` 互斥。

删除任务也遵循同样的保护：存在 live invocation 或未清进程树时，普通 `remove` 会失败。
`remove --abandon` 会直接删除任务和账本记录，但不会停止残留进程。

## 进程清理与平台差异

POSIX 上，scheduled exec 会在开始运行前和写入最终结果前清理自己负责的残留进程。清理不
成功时，invocation 保持 `running`，不会释放单例或启动下一轮。

| 平台 | Roll 能识别和清理的范围 | 已知边界 |
| --- | --- | --- |
| Linux | invocation 环境标记、exec 进程组、每条内建 Shell 命令的进程组 | 再次 `setsid`/daemonize，或系统崩溃时，仍可能逃离协作清理链 |
| macOS | exec 进程组、每条内建 Shell 命令的进程组 | 不读取其他进程的环境和命令行；已离开进程组的 Chromium、Node/Python 守护进程不可见 |
| Windows | 取消和超时时通过 `taskkill /T /F` 终止 exec 进程树 | 不执行 POSIX 式结束前枚举；只能独立确认 exec 根进程，无法证明所有脱离根进程的后代都已退出 |

Linux 和 macOS 的结束前清场先发送 SIGTERM，2 秒后仍存活才发送 SIGKILL。系统会通过 PID
和 OS 启动身份避免把已经复用同一 PID/进程组编号的新进程当成旧成员。

在 Windows 上，`cancel --kill` 成功后仍会提示“后代不可验证”；JSON 输出中的
`unverifiedDescendants` 会是 `true`。这表示 Roll 已确认 exec 根进程退出，但不能独立证明
所有后代都已退出。

如果账本显示 `tree=unsettled(pid …)`，先尝试：

```bash
roll schedule cancel <invocation-id> --kill
```

只有无法验证或元数据损坏时才使用 `--abandon`。更多 Windows 平台细节见
[Windows 兼容性说明](./windows-compatibility.md)。

> `roll schedule` 防止的是两个由 Roll 管理、且仍可验证存活的执行进程树同时运行。它不是
> 严格的 exactly-once 系统：已经发送的消息和已经写入的文件不会因重试或取消自动回滚。

## 停止 daemon

前台 daemon 可用 Ctrl+C 停止；用户服务请使用：

```bash
roll schedule service uninstall
```

- POSIX：先向 exec 进程树发送 SIGTERM，等待 10 秒；仍未退出再发送 SIGKILL。
- Windows：正常 Ctrl+C/Ctrl+Break 会先等待 10 秒，再通过 `taskkill /T /F` 强制终止；直接
  关闭控制台窗口时可用时间很短，因此会跳过 grace，立即强制终止。

如果无法确认某个 exec 已退出，相关 invocation 会继续保持 `running`。下次 daemon 启动后会
按照进程身份和 lease 状态复核，不会直接释放单例。

## 配置

```yaml
scheduler:
  data-dir: ~/.roll-agent/scheduler
  max-schedules: 50
  max-concurrent-runs: 2
```

| 配置项 | 默认值 | 有效范围 | 说明 |
| --- | --- | --- | --- |
| `scheduler.data-dir` | `~/.roll-agent/scheduler` | 路径 | 存放 `schedules.db`、`scheduler.log` 和 `daemon.json` |
| `scheduler.max-schedules` | `50` | 1–500 | 可登记的任务数上限 |
| `scheduler.max-concurrent-runs` | `2` | 1–8 | daemon 可同时运行的不同任务数量 |

相对 `data-dir` 以配置文件所在目录为基准；如果没有配置文件，则以当前工作目录为基准。

`service install` 会把当时解析出的 `data-dir` 和 `max-concurrent-runs` 固化进服务定义，并把
安装状态保存到 `~/.roll-agent/scheduler-service.json`：

- metadata 同时记录安装当时的 node 绝对路径、roll CLI 入口路径和 roll 版本（`binary`）。
- 每次安装还会生成一个启动 generation。只有服务进程回写同一个 generation 并取得 daemon
  lifecycle lock 后，metadata 才会从 `installing` 变为 `installed`。
- 配置未变化、固化的二进制也仍是当前 roll 时，再次 install 只刷新服务定义，不重启正在运行的
  daemon。
- 配置发生变化，或固化的 roll 版本 / node / 入口路径与当前不同时，install 会先按旧设置完成
  卸载，再安装新定义（daemon 随之切换到新二进制）。如果此时有 `claimed` / `running`
  invocation，或 `retry` 记录仍持有未清进程树，install 会拒绝替换；等待完成或先完成清场。
  替换已安装的服务时，也可以显式执行 `service restart --force`。
- 升级 `roll` 或切换 Node 之后请直接运行 `roll schedule service restart`，见下一节。

## 数据保留

daemon 会自动清理终态 invocation：

- 每个任务最多保留最近 100 条终态记录。
- 终态记录最长保留 30 天。
- `pending`、`claimed`、`running`、`retry` 不会被保留策略删除。

Chat 线程不随 invocation 账本一起清理，仍可通过 `roll chat --session <thread-id>` 打开。

## 升级 roll / 切换 Node 之后

服务定义固化的是安装当时的 node 绝对路径与 roll CLI 入口路径，正在运行的 daemon 也是安装
当时的代码：

- `roll update` 在更新 Agent 期间会暂停 scheduler 领取新任务。自更新成功后，如果没有
  `claimed` / `running` invocation 或持有未清进程树的重试，会保留 service metadata 中已经安装的
  `data-dir` 和并发设置，只按新二进制重装并重启；有任务正在运行时只提示，等空闲后手动执行
  `roll schedule service restart`。`roll update --check` 发现服务固化的版本或路径与当前不同时也会
  提示。即使上次替换已停在 `installing` 且 OS 服务暂时不存在，`roll update` 也会继续恢复，而不是
  把它当成“从未安装”。
- `roll schedule service restart`：卸载后按当前 roll 与配置重装（`--json` 输出 `action` / `liveInvocations` / `reason`，供脚本判断）。有占用中的 invocation 时拒绝
  （退出码 1）；`--force` 会中断 daemon-owned invocation，但 `run-now --inline` 不受 service
  teardown 影响。未安装时同样退出 1；上次重装停在 `installing` 时可用同一命令继续恢复。若同一
  `data-dir` 仍有前台 daemon，先在它的终端按 Ctrl+C，再重试。
- 用 nvm 切换或删除 Node 版本后，固化的 node 路径会失效，LaunchAgent / Scheduled Task 起不来
  daemon。`roll schedule service status` 会报「服务定义指向的 node 已不存在」，`roll doctor` 的
  「Scheduler service」检查记为 fail 并给出 `roll schedule service restart`；`roll schedule status`
  在「已装服务但 daemon 未运行」时也会提示去看 `service status`。metadata 由旧版本安装、没有
  `binary` 记录时这些检查报 unknown，重装一次即可开始检测。

## 当前限制

- 仅支持固定间隔触发，不支持 Cron、日历时间或时区；“每个工作日 9 点”尚不可用。
- 模型不能自行创建或管理定时任务；当前只有 CLI 管理面。
- 每次 invocation 都创建新线程，不会续接上一轮上下文。
- 内建用户服务只支持 macOS 和 Windows；Linux 需自行配置 systemd user unit。
- macOS 无法发现已经离开受管进程组的后台进程。
- Windows 无法独立确认已经脱离 exec 根进程的后代是否退出。
- `max-run` 的超时判定由当轮 daemon 持有。如果 daemon 恰在发出超时停止信号后自身崩溃，
  exec 又随后迟到写入成功结果，新 daemon 无法还原那次尚未落账的超时判定。
- `roll update` 的 scheduler admission lock 只覆盖 update 进程存活期间；如果进程在包替换中途被
  强制结束，请重新运行 `roll update`，再用 `roll schedule service status` / `restart` 完成恢复。

## 排查问题

### 任务一直没有运行

```bash
roll schedule status
```

确认 daemon 为 `running`，并核对输出中的 `data-dir` 是否与登记任务时使用的配置一致。daemon
在运行但日志里出现「scheduler admission 连续拒绝领取新任务」时，说明 service metadata 停在
`installing` 或无法解析（或另一个 service 维护命令正持锁），此时不会触发任何任务，按
`roll schedule service status` 的提示恢复。
macOS 或 Windows 如果安装了用户服务，再运行 `roll schedule service status` 检查服务状态；
输出里的 `binary` 一行会指出固化的 node / roll 入口是否已失效或版本过期，`roll doctor` 的
「Scheduler service」检查给出同样结论。失效时执行 `roll schedule service restart`。

### 查看 daemon 日志

```bash
roll schedule status
```

输出中的“日志”字段指向 `scheduler.log`。

### 任务因权限变化暂停

确认任务工作目录里的 `runtime.approval` 和 `runtime.shell` 配置，然后运行：

```bash
roll schedule resume <schedule-id>
```

### 运行一直停在 `running`

先查看记录中的错误和进程树提示：

```bash
roll schedule runs <schedule-id>
```

如果提示进程树未清，使用 `cancel --kill`。只有无法验证且你愿意承担残留进程风险时，才使用
`cancel --abandon`。
