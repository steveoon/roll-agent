# 使用 `roll schedule` 定时运行 Chat 任务

`roll schedule` 可以按固定间隔、每天或每周的日历时间，在无人值守时自动运行一轮 `roll chat`。
每次运行都会创建一个独立的会话线程，并把状态、结果摘要和失败原因写入本地账本。

本文中的两个术语：

- **任务（schedule）**：长期保存的定时规则，例如“每 30 分钟巡检一次服务错误日志”。
- **运行（invocation）**：任务的一次具体执行。查看执行详情或取消运行时使用 invocation ID。

## 快速导航

- [快速开始](#快速开始)
- [在 roll chat 里创建与追加任务](#在-roll-chat-里创建与追加任务)
- [查看执行对话与继续讨论](#查看执行对话与继续讨论)
- [常用命令](#常用命令)
- [理解运行状态](#理解运行状态)
- [重试、补跑和单例](#重试补跑和单例)
- [权限配置变化](#权限配置变化)
- [安全地取消运行](#安全地取消运行)
- [进程清理与平台差异](#进程清理与平台差异)
- [配置](#配置)
- [升级 roll / 切换 Node 之后](#升级-roll--切换-node-之后)
- [当前限制](#当前限制)
- [排查问题](#排查问题)

## 前置条件

- Node.js 版本不低于 22.6。
- 已安装 `roll`，并且 `roll --version` 可以正常运行。
- LLM 已配置；建议先确认 `roll doctor` 通过，且 `roll chat "hi" --json` 能返回 `completed`。

> **Node.js 22.6–22.12**
>
> 已安装的 `roll` 启动器会为 `chat`、`schedule`、`doctor` 和 `update` 自动启用实验性的 `node:sqlite`。
> Windows 用户仍建议使用 Node.js 22.13 或更高版本。

## 快速开始

### 1. 登记任务

下面的任务每 30 分钟运行一次。`--now` 表示把首次运行设为立即到期；真正执行仍需要 daemon。

```bash
roll schedule add "检查最近 30 分钟的服务错误日志并汇总，不要调用需要确认的工具" \
  --name "错误日志巡检" \
  --every 30m \
  --cwd ~/work \
  --now
```

`--every` 支持 `s`、`m`、`h`、`d` 四种单位，例如 `60s`、`30m`、`2h`、`1d`。
间隔最短 60 秒，最长 365 天。

#### 指定开始时间、每天或每周执行

例如“2026 年 9 月 16 日上午 8 点开始巡检构建状态，每 30 分钟一次，20 轮后结束”：

```bash
roll schedule add "巡检 CI 构建状态并汇总异常" --name "构建状态巡检" \
  --every 30m --start-at 2026-09-16T08:00 --rounds 20
```

`--start-at` 不带时区偏移时，按**运行 Roll 的机器时区**解释；日历任务显式指定了 `--time-zone` 时则按该时区解释。也接受带偏移的 ISO 时间，例如 `2026-09-16T08:00:00+08:00`。创建时必须是未来时间，命令行中不能直接写“明天”这类自然语言相对日期（在 `roll chat` 对话中可以说“明天上午 8 点”，模型会结合机器当前日期和时区换算，并在确认框中展示具体日期、时区与 ISO 时间）。
终端确认框内容较长时，可用 PgDn 打开完整参数页，用 PgUp/PgDn 翻页；方向键选择与回车确认方式不变。

```bash
# 每天本机当地时间 08:00 执行日报汇总，共自动执行 20 次
roll schedule add "汇总昨日提交与测试结果生成早报" --name "早间日报汇总" --daily 08:00 --rounds 20

# 每周一、三、五 08:00，显式使用上海时区
roll schedule add "检查依赖安全告警并生成巡检摘要" --name "工作日安全巡检" \
  --weekly mon,wed,fri --at 08:00 --time-zone Asia/Shanghai
```

- `--every`、`--daily`、`--weekly` 必须三选一。`--weekly` 必须配合 `--at`；星期使用 `mon,tue,wed,thu,fri,sat,sun`，可用逗号连接。`--time-zone` 仅用于日历规则。
- 日历时区省略时读取本机系统时区，并**在创建时保存**。以后机器切换时区，已有任务仍按保存的时区运行。显式时区使用 IANA 名称，例如 `Asia/Shanghai`、`America/New_York`（等价别名会规范化后再保存和去重）。`roll ui` 配置台的下次／上次时间优先展示服务端按任务时区生成的时间，避免浏览器时区造成误读。
- 日历任务的 `--start-at` 是开始下限：寻找该时间起第一个匹配的日历时段；间隔任务则在 `--start-at` 执行第一轮，之后按每轮实际领取时间加间隔计算。
- `--now` 只用于没有 `--start-at` 的普通间隔任务；手动 `run-now` 仍可执行任意任务，不消耗自动轮数，也不改变自动规则。
- 每天 `08:00` 不等于固定每隔 24 小时。跨夏令时仍对齐保存时区的 `08:00`；如果当地钟表跳过目标时刻，当天跳过且不扣轮数；如果目标时刻出现两次，只执行较早的一次。
- 停机、睡眠、服务未运行或上一轮未结束时，不保证准点执行，也不会唤醒休眠中的电脑。恢复后最多补一次错过的运行；日历任务的下一轮重新对齐日历时段。
- 聊天确认期间如果已错过日历任务或指定开始任务的首次时间，会要求重新发起确认，不会把原定时间悄悄改成立即执行。
- `rounds` 始终是整个任务的总自动轮数。暂不支持任意 Cron 表达式，也不支持“每天 08:00 开启一组每半小时 20 轮循环”的嵌套规则。

#### 单次时长上限与有限轮数

`--max-run` 设定单次运行的时长上限，语法与 `--every` 相同，范围 60 秒到 24 小时，默认 1 小时。daemon 和 `run-now --inline` 都会在超过上限时终止本次运行；daemon 按失败重试，`--inline` 只尝试一次并以状态码 1 退出。需要运行数小时的任务可显式传入 `--max-run 6h`，但更推荐把长任务拆成多轮短任务（每轮处理固定批次，其余留给下一轮），因为每次触发都是新线程，中途失败会整轮重跑。`roll schedule list` 行尾和 `show --json` 的 `maxRun` / `maxRunMs` 会显示显式设置的值；缺省表示使用 1 小时默认上限。

`--rounds` 设置最多自动执行的轮数，只接受正安全整数；省略时不限轮数：

```bash
roll schedule add "巡检服务错误日志并生成摘要" --name "错误日志巡检" --every 30m --rounds 20
```

一轮指账本成功登记的一次自动运行。启动失败、执行失败、取消或本轮无异常事项都占一轮；同一轮内的重试不额外计数。`add --now` 的首次自动触发算一轮，`run-now` 手动运行不占自动额度。暂停、恢复、重启服务和清理历史记录都不会重置计数。

第 20 轮领取后不再产生第 21 轮，当前轮仍可正常执行、重试和清理进程树。任务状态展示会区分「最后一轮执行中」「等待重试」「等待清场」；全部结算后显示「已结束 · 达到轮数上限」，具体成功或失败结果保留在运行历史中。若在额度耗尽前重试预算用完，任务会暂停等待处理。

`list`、`show`、聊天 `/schedule` 和配置台均展示轮数进度。JSON 中的 `rounds: { max: 20, started: 7 }` 表示已占用 7 轮，`max: null` 表示不限轮数；`roundsDisplay` 提供可读说明。`started` 不等于成功次数；无限任务的文字展示只显示「不限轮数」，JSON 仍保留累计计数。可用 `list --status completed` 查看已结束任务。已结束任务保留历史，`pause` 不改变其状态，`resume` 不会重置额度；要继续同一任务，请使用 `extend` 追加轮数。已结束任务仍可使用 `run-now` 手动试跑（遵守单例与权限规则）。调度器最多补一次错过的周期，停机期间不消耗轮数，因此 20 轮 × 30 分钟不保证在 10 小时内结束；不支持设置任务截止时间或清零已执行计数。

#### 工作目录与配置来源

`--cwd` 是任务运行时的实际工作目录（工具执行、项目内自动发现的 `.agents/skills` 与 `AGENTS.md` 均基于该目录），默认取创建命令所在的当前目录。

任务运行与重授权时的配置文件加载规则取决于创建方式：

- **绑定配置的会话创建的任务**：在绑定了配置文件（例如通过 `--config` / `--config-workspace` 指定，或在工作目录中发现了 `roll.config.yaml`）的 `roll chat` 会话中创建的定时任务，会在账本中持久化该配置来源引用（`hostContext`，仅记录路径引用，不保存密钥）。后续任务执行、`resume` 与 `extend` 重授权均从该绑定来源读取最新配置；若绑定配置文件缺失或损坏会直接报错，不会回退到 `--cwd`。
- **无绑定配置的任务**：通过 CLI `roll schedule add` 创建的任务，或在未绑定任何配置文件（使用内置默认配置）的聊天会话中创建的任务，后续执行、`resume` 与 `extend` 均按任务自身的 `--cwd` 向上查找配置文件。

### 2. 前台试跑 daemon

首次使用时，建议先在前台运行 daemon 验证流程：

```bash
roll schedule daemon --foreground
```

daemon 启动后会立即检查到期任务；空闲时最长每 15 秒检查一次。你应该很快看到类似下面的触发日志：

```text
触发 错误日志巡检（schedule=… invocation=… attempt=1 max-run=3600000 ms）
```

任务何时完成取决于模型和工具的执行时间，并不保证在 15 秒内结束。按 Ctrl+C 可停止前台 daemon。

### 3. 安装用户服务

确认试跑正常后，可以把 daemon 安装成当前用户的常驻服务：

```bash
roll schedule service install
roll schedule service status
```

- macOS 使用 LaunchAgent。
- Windows 使用当前用户的 Scheduled Task，并在登录时启动。
- Linux 暂未内置系统级开机自启安装命令；请以前台 `roll schedule daemon --foreground` 配合 systemd user unit 等方式托管运行。

安装前请先退出同一 `data-dir` 上的前台 daemon。Roll 会等待本次安装对应的 daemon 真正启动握手后才记为成功，仅完成 LaunchAgent / Scheduled Task 注册不算完成。如果启动握手失败，安装状态会保留为 `installing`，新触发不会被领取；处理报错原因后重新运行 `roll schedule service install` 或 `roll schedule service restart` 即可恢复。

### 4. 查看任务和结果

```bash
roll schedule list
roll schedule runs <schedule-id>
roll schedule inspect <invocation-id>
roll schedule status
```

如果想基于某次已生成会话的运行快照继续交互排查，可派生一段新对话：

```bash
roll chat --from-run <invocation-id>
```

（若已知该次运行的会话线程 ID，执行 `roll chat --session <thread-id>` 同样会基于其快照派生一段新的普通讨论会话，而不会直接改写原执行线程。）

不想记命令时，可打开 `roll ui` 左侧的「定时任务管理」面板：支持查看任务列表与最近运行（含失败原因）、安装／重启／卸载服务、暂停／恢复任务、为已结束任务追加轮数以及取消运行。

## 在 roll chat 里创建与追加任务

在交互式 `roll chat` 中，模型可通过内建工具协助登记、查询和延长定时任务：

- **`roll__schedule_create`**：根据自然语言描述登记定时任务。例如直接说「帮我每隔 30 分钟巡检一次服务错误日志，执行 20 轮后停止」。
- **`roll__schedule_list`**：查看当前配置下已登记的定时任务（含状态、触发频率、轮数进度、下次运行时间与最近错误摘要）。
- **`roll__schedule_extend`**：在用户明确要求为已结束的有限轮数任务延长执行时（例如「给这个已结束的巡检任务再追加 30 轮」），保留原任务 ID 与历史并追加自动轮数。

交互与安全边界说明：

- 开始时间、重复规则和总轮数是三个独立维度。「今天／明天某时」仅表示首次开始时间，不代表每天重复；如果只给出开始时间和多轮次数却未说明间隔，模型会先向你询问确认，不会擅自补成每天一次。
- 创建与追加轮数都会弹出终端确认框，完整展示任务名称、频率、工作目录、任务内容、时长上限、轮数变化、预计运行时间与当前调度服务状态；单次批准只授权当前这一次操作。
- 确认框还会展示预计第二轮时间（仅剩一轮时不展示）；间隔任务按每轮实际领取时间顺延重算，预计时间不承诺准点。
- 若模型在同一轮推理中连续重复提交相同的无效创建参数，系统会中止重复重试并给出原因；修正参数或下一轮用户输入不受影响。
- 相同定义（内容 + 工作目录 + 配置来源 + 完整触发规则 + 时长上限 + 轮数上限）的 `active` 任务已存在时不会重复创建，工具会直接返回既有任务并保留累计轮数；已结束任务不参与复用。
- 调度服务尚未安装或未运行时，任务仍可登记成功，工具会如实提示「不会自动执行」，安装服务需由用户手动执行。
- 暂停、恢复、取消运行与删除任务需通过 CLI 或 `roll ui` 面板执行；定时任务自身的无人值守轮次内不提供创建与追加工具（定时任务不能自行繁殖定时任务）。

## 查看执行对话与继续讨论

普通对话从 `/resume` 查找；定时自动执行和 `run-now` 产生的会话归入 `/schedule` 查看。
`roll chat --list`、`roll chat --last` 及普通会话列表只展示普通对话。

1. 在 `roll chat` 中输入 `/schedule`，选择任务，再选择某次运行。
2. 运行列表每页 20 条，按时间倒序显示；同一次运行的重试归在一起，可切换 attempt。
3. 在详情中阅读执行结果、报错及完整归档对话；工具执行记录在对话之后单独分页展示。
4. 需要继续排查时，在全屏界面底部操作区按 `C`（或 `c`）“继续对话”，基于该次运行派生一段普通对话（基础 REPL 提供对应的选择菜单）。

全屏界面用方向键和回车选择，Esc 逐级返回聊天；详情中 `n` / `p` 翻页，`[` / `]` 切换尝试，`r` 刷新，`c` 继续讨论。查看和刷新属于纯只读操作，不调用模型、不更新会话活跃时间，也不会创建新会话。

也可以直接在终端查看某次运行或派生新对话：

```bash
roll schedule inspect <invocation-id>
roll schedule inspect <invocation-id> --attempt 2 --json
roll chat --from-run <invocation-id>
roll chat --from-run <invocation-id> --attempt 2
```

省略 `--attempt` 时默认选择最新有关联会话的尝试。`--from-run` 与 `--session`、`--last` 互斥。若对某次定时执行的线程执行 `roll chat --session <thread-id>`，系统同样会基于快照派生（fork）一段新的普通讨论会话并输出新会话 ID，原执行线程本身保持只读不变。

派生出的新讨论保留原执行的对话内容、压缩摘要及可读取的历史证据，但沿用**当前聊天的目录、模型和审批权限**（原任务工作目录会在界面中明确提示）。原任务的后台进程、待定审批和未完成动作不会继承，也不会自动重跑任务。若原运行尚未结束，新讨论仅包含派生时刻已提交的快照，后续输出不会自动同步。来源说明由 `derivedFrom` 元数据动态注入模型上下文，不占用用户发言历史。

`schedule inspect --json` 的 `status` 返回稳定枚举（如 `completed`、`failed`），`mode` 返回 `scheduled` 或 `manual`。当账本状态不可用时，`status` 为 `null` 并附带 `statusUnavailableReason`：`ledger_missing` 表示账本记录已清理或不存在，`attempt_not_current` 表示所选早期尝试未单独保留终态。

已建立会话关联的运行，即使原任务后来被删除或超出账本保留期，只要会话数据仍在，依然能在 `/schedule` 中查到（账本状态缺失时标注“历史状态不可用”）；执行会话及其关联记录不会自动删除。聊天与 `/schedule` 仅以只读方式查询 scheduler 账本（兼容 `v5–v10`）来关联当前会话库中的历史记录，不会修改消息或主动迁移数据库。早期未记录关联的旧线程可能仍留在普通对话列表中（仅凭 `[定时]` 标题前缀不会自动归类）。Runtime 客户端可按 ID 只读读取执行记录，不能直接向原执行线程发送人工消息或触发手动压缩。

## 常用命令

| 目的                                     | 命令                                                     |
| ---------------------------------------- | -------------------------------------------------------- |
| 登记任务                                 | `roll schedule add <prompt> --name <name> --every 30m`   |
| 列出任务                                 | `roll schedule list`                                     |
| 查看任务详情                             | `roll schedule show <schedule-id>`                       |
| 手动入队一次                             | `roll schedule run-now <schedule-id>`                    |
| 前台执行并等待结果                       | `roll schedule run-now <schedule-id> --inline`           |
| 查看任务的运行记录列表                   | `roll schedule runs <schedule-id>`                       |
| 查看单次运行详情与归档对话               | `roll schedule inspect <invocation-id>`                  |
| 暂停任务                                 | `roll schedule pause <schedule-id>`                      |
| 恢复并重新授权                           | `roll schedule resume <schedule-id>`                     |
| 为已结束任务追加自动轮数                 | `roll schedule extend <schedule-id> --rounds <n>`        |
| 取消一次运行                             | `roll schedule cancel <invocation-id>`                   |
| 删除任务及其运行记录                     | `roll schedule remove <schedule-id>`                     |
| 查看 daemon 状态                         | `roll schedule status`                                   |
| 安装并启动用户服务                       | `roll schedule service install`                          |
| 查看用户服务状态                         | `roll schedule service status`                           |
| 停止并卸载用户服务                       | `roll schedule service uninstall`                        |
| 重启用户服务（升级 roll / 切换 Node 后） | `roll schedule service restart`                          |

大多数查询命令支持 `--json`。`roll schedule runs` 默认返回最近 20 条记录，可用 `--limit <n>` 调整数量。

## 理解运行状态

`roll schedule runs <schedule-id>` 可能显示以下状态：

| 状态                 | 含义                                                     |
| -------------------- | -------------------------------------------------------- |
| `pending`            | 已入队，等待 daemon 接管                                 |
| `claimed`            | daemon 已取得本次运行的所有权，exec 尚未正式开始         |
| `running`            | exec 正在运行，或因退出/进程树状态无法确认而继续占用单例 |
| `retry`              | 本次尝试失败，等待退避后重试                             |
| `completed`          | 已成功完成                                               |
| `needs_confirmation` | 任务已结束，但有工具调用因无人值守无法确认而被拒绝       |
| `failed`             | 已终止，不会再自动重试                                   |

每次 invocation 都会创建一个标题为 `[定时] <任务名>` 的新 Chat 线程，不会自动继承上一轮的上下文。

## 无人值守策略

定时任务使用与普通 `roll chat` 相同的 Agent 和工具，但不会等待人工输入：

- 原策略为 `allow` 或 `deny` 的工具调用保持不变。
- 原策略需要 `confirm` 的调用会直接改为 `deny`。
- 只要本轮出现这类拒绝，结果就会记录为 `needs_confirmation`，不会因此重试或暂停任务。
- 如果模型明确需要用户输入才能继续，本次尝试按普通失败处理，并进入下文所述的重试流程。

## 重试、补跑和单例

### 失败重试

普通执行失败后，Roll 会等待 10 秒再重试。默认最多尝试 3 次，即首次执行加两次重试。

- scheduled invocation 用完重试次数后会记录为 `failed`；尚有自动额度时暂停任务，额度已用尽时则在运行结算后结束任务。
- `run-now` 创建的 manual invocation 即使用完重试次数，也不会自动暂停任务。
- `run-now --inline` 只尝试一次；结果不是 `completed` 或 `needs_confirmation` 时，命令退出码为 1。
- 单次运行超过该任务的 `--max-run`（默认 1 小时）时，daemon 会终止 exec 子进程并按失败重试；`run-now --inline` 也会按同一上限终止，但不重试。上一个 daemon 留下的孤儿 exec 也按各自任务的上限清理。

### 同一任务不会并行运行

同一个 schedule 同一时刻只允许一条 invocation 进入 `claimed` 或 `running`。仍持有未清进程树的 `retry` 也会继续占用这个单例。

如果周期到期时上一轮仍未结束，Roll 不会为每个错过的周期分别排队。上一轮结束后，最多补一次到期运行，然后从补跑时刻重新计算下次时间。

`run-now` 默认只负责入队：

- daemon 正在运行时，由 daemon 接管。
- daemon 未运行时，记录保持 `pending`，直到 daemon 启动。
- `--inline` 会由当前命令启动一个独立的 `roll schedule exec` 子进程，等待它结束并返回结果。它不依赖 daemon，但仍遵守该任务的 `--max-run`。如果同一任务已有运行，`--inline` 会以退出码 1 结束；不加 `--inline` 则继续排队。

### 暂停与恢复

`pause` 只停止新的周期触发，不修改原来的 `nextRunAt`：

```bash
roll schedule pause <schedule-id>
roll schedule resume <schedule-id>
```

恢复时如果原定时间已经过去，任务会按“最多补一次”的规则执行。

暂停还会放弃尚未开始、进程树已清的 scheduled retry。manual invocation 不受影响；如果某条运行仍持有未清进程树，它会继续保持 `retry` 或 `running`，直到完成清场或被显式放弃。若被放弃的是已占用最后一轮额度的重试，任务会在结算后进入「已结束」；之后 `extend` 增加的是新的自动轮次，不会恢复这次已放弃的重试。

暂停状态下仍可以使用 `run-now` 手动试跑。若任务是因为权限摘要变化而暂停，应先执行 `resume` 完成重新授权，否则手动试跑也会因摘要不一致而失败。

### 已结束任务追加轮数

例如原任务已执行 20/20 轮，再追加 30 轮后变为 20/50——任务 ID、内容、频率、工作目录、累计轮数和运行历史全部保留：

```bash
roll schedule extend <schedule-id> --rounds 30 --json
```

只有有限额度已用尽且处于 `completed` 状态的任务可以追加；任何尚未结算的运行（包括手动 `pending`、执行中、等待重试或未清进程树）都必须先结算完毕。追加成功时，系统会按任务的绑定配置来源（无绑定时按任务 `--cwd`）读取当前配置重新授权，任务恢复为 `active`，下一轮从追加成功时刻起等待一个原有周期后触发，不会立即执行。

CLI 执行前会输出 `request-id`（JSON 输出同样包含该字段）。若执行途中连接中断、未收到明确结果，可携带相同的 `--request-id` 与原总额度 `--expected-max-rounds` 安全重试：

```bash
roll schedule extend <schedule-id> --rounds 30 --expected-max-rounds 20 --request-id <request-id> --json
```

携带相同的 `--request-id`、`--expected-max-rounds` 和 `--rounds` 重试是幂等的：若上次已成功，直接返回已处理回执（`extended: false`），不会重复累加额度或改动下次运行时间；若复用同一请求 ID 却修改参数，或基于已过期的原额度发起新请求，均会被拒绝。

你也可以在 `roll chat` 中明确要求为已结束任务追加轮数，或在 `roll ui` 配置台的已结束任务上点击「追加轮数」（网络中断后直接重试会自动复用原请求 ID 防止重复加额）。`resume` 仅用于恢复暂停任务，不能增加轮数；`extend` 也不会清零已累计的执行计数。

## 权限配置变化

登记任务时，Roll 会计算并保存以下权限相关配置的摘要：

- `runtime.approval.default`
- `runtime.approval.overrides`
- `runtime.shell.enabled`
- `runtime.shell.auto-approve-safe`
- `runtime.shell.session.enabled`

每次执行前都会从该任务的配置来源（有 `hostContext` 绑定的任务读取原绑定配置文件，无绑定的任务从 `--cwd` 发现配置）重新加载并比对摘要。无论配置变得更宽松还是更严格，只要与已授权摘要不一致，就不会启动模型执行：

- scheduled invocation 会记为失败；尚有自动额度时暂停任务，额度已用尽时则在结算后结束。
- manual invocation 会记为失败，但不会自动暂停任务。

确认新配置无误后，运行以下命令重新授权：

```bash
roll schedule resume <schedule-id>
```

`resume` 会按该任务对应的配置来源（绑定配置或 `--cwd`）重新计算并更新权限摘要，即使任务当前已是 `active` 状态也适用；已达到轮数上限并结束的任务不能通过 `resume` 恢复，请使用 `extend` 显式追加轮数并完成重授权。

> 权限摘要目前不包含已注册 Agent 和 Skill 列表的变化。增删这些能力不会自动触发权限漂移暂停。

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

在 POSIX 上，Roll 会先发送 SIGTERM，让当前对话回合和内建 Shell 协作清理；宽限期结束后仍未退出才升级为 SIGKILL。只有确认 exec 已退出、且可枚举进程树已清空，账本才会写入终态并释放单例。

如果进程仍存活、身份无法验证、进程树无法枚举，或者这条 invocation 已被另一个 worker 接管，取消会失败并保持原状态。

### 最后的人工出口：`--abandon`

只有在进程身份或持久化树状态无法验证时，才考虑：

```bash
roll schedule cancel <invocation-id> --abandon
```

> **危险**
>
> `--abandon` 不会确认或终止旧进程，只是放弃追踪并释放单例。旧进程如果仍在运行，可能继续发送请求、修改文件或产生其他副作用。

`--kill` 与 `--abandon` 互斥。

删除任务也遵循同样的保护：存在未结束的 invocation 或未清进程树时，普通 `remove` 会失败；`remove --abandon` 会直接删除任务和账本记录，但不会停止残留进程。

## 进程清理与平台差异

POSIX 上，scheduled exec 会在开始运行前和写入最终结果前清理自己负责的残留进程。清理不成功时，invocation 保持 `running`，不会释放单例或启动下一轮。

| 平台    | Roll 能识别和清理的范围                                       | 已知边界                                                                                  |
| ------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Linux   | invocation 环境标记、exec 进程组、每条内建 Shell 命令的进程组 | 再次 `setsid`/daemonize，或系统崩溃时，仍可能逃离协作清理链                               |
| macOS   | exec 进程组、每条内建 Shell 命令的进程组                      | 不读取其他进程的环境和命令行；已离开进程组的 Chromium、Node/Python 守护进程不可见         |
| Windows | 取消和超时时通过 `taskkill /T /F` 终止 exec 进程树            | 不执行 POSIX 式结束前枚举；只能独立确认 exec 根进程，无法证明所有脱离根进程的后代都已退出 |

Linux 和 macOS 的结束前清场先发送 SIGTERM，2 秒后仍存活才发送 SIGKILL。系统会通过 PID 和 OS 启动身份避免把已经复用同一 PID/进程组编号的新进程误判为旧成员。

在 Windows 上，`cancel --kill` 成功后仍会提示“后代不可验证”；JSON 输出中的 `unverifiedDescendants` 为 `true`。这表示 Roll 已确认 exec 根进程退出，但不能独立证明所有后代进程都已退出。

如果账本显示 `tree=unsettled(pid …)`，先尝试：

```bash
roll schedule cancel <invocation-id> --kill
```

只有无法验证或元数据损坏时才使用 `--abandon`。更多 Windows 平台细节见 [Windows 兼容性说明](./windows-compatibility.md)。

> `roll schedule` 防止的是两个由 Roll 管理、且仍可验证存活的执行进程树同时运行。它不是严格的 exactly-once 系统：已经发出的外部请求和已经写入的文件不会因重试或取消自动回滚。

## 停止 daemon

前台 daemon 可用 Ctrl+C 停止；用户服务请使用：

```bash
roll schedule service uninstall
```

- POSIX：先向 exec 进程树发送 SIGTERM，等待 10 秒；仍未退出再发送 SIGKILL。
- Windows：正常 Ctrl+C/Ctrl+Break 会先等待 10 秒，再通过 `taskkill /T /F` 强制终止；直接关闭控制台窗口时可用时间很短，因此会跳过宽限期立即强制终止。

如果无法确认某个 exec 已退出，相关 invocation 会继续保持 `running`。下次 daemon 启动后会按照进程身份和 lease 状态复核，不会盲目释放单例。

## 配置

```yaml
scheduler:
  data-dir: ~/.roll-agent/scheduler
  max-schedules: 50
  max-concurrent-runs: 2
```

| 配置项                          | 默认值                    | 有效范围 | 说明                                                  |
| ------------------------------- | ------------------------- | -------- | ----------------------------------------------------- |
| `scheduler.data-dir`            | `~/.roll-agent/scheduler` | 路径     | 存放 `schedules.db`、`scheduler.log` 和 `daemon.json` |
| `scheduler.max-schedules`       | `50`                      | 1–500    | 可登记的任务数上限                                    |
| `scheduler.max-concurrent-runs` | `2`                       | 1–8      | daemon 可同时运行的不同任务数量                       |

相对 `data-dir` 以配置文件所在目录为基准；如果没有配置文件，则以当前工作目录为基准。

`service install` 会把当时解析出的 `data-dir` 和 `max-concurrent-runs` 固化进服务定义，并把安装状态保存到 `~/.roll-agent/scheduler-service.json`：

- metadata 同时记录安装当时的 node 绝对路径、roll CLI 入口路径和 roll 版本（`binary`）。
- 每次安装还会生成一个启动 generation。只有服务进程回写同一个 generation 并取得 daemon lifecycle lock 后，metadata 才会从 `installing` 变为 `installed`。
- 配置未变化、固化的二进制也仍是当前 roll 时，再次 install 只刷新服务定义，不重启正在运行的 daemon。
- 配置发生变化，或固化的 roll 版本 / node / 入口路径与当前不同时，install 会先按旧设置完成卸载，再安装新定义（daemon 随之切换到新二进制）。如果此时有 `claimed` / `running` invocation，或 `retry` 记录仍持有未清进程树，install 会拒绝替换；请等待运行完成或先完成清场。替换已安装的服务时，也可以显式执行 `service restart --force`。
- 升级 `roll` 或切换 Node 之后请运行 `roll schedule service restart`，见下一节。

## 数据保留

daemon 会自动清理终态 invocation：

- 每个任务最多保留最近 100 条终态记录。
- 终态记录最长保留 30 天。
- `pending`、`claimed`、`running`、`retry` 不会被保留策略删除。

执行产生的 Chat 会话线程不随 invocation 账本一起清理：可随时通过 `roll chat --view <thread-id>` 只读查看，或用 `roll chat --session <thread-id>` 基于其快照派生新的普通讨论会话。

## 升级 roll / 切换 Node 之后

### 服务二进制更新与重启

服务定义固化的是安装当时的 node 绝对路径与 roll CLI 入口路径，正在运行的 daemon 也是安装当时的代码：

- `roll update` 在更新 Agent 期间会暂停 scheduler 领取新任务。自更新成功后，如果没有 `claimed` / `running` invocation 或持有未清进程树的重试，会保留 service metadata 中已安装的 `data-dir` 和并发设置，自动按新二进制重装并重启服务；有任务正在运行时只给出提示，等空闲后手动执行 `roll schedule service restart`。`roll update --check` 发现服务固化的版本或路径与当前不同时也会提示。即使上次替换停在 `installing` 且 OS 服务暂时不存在，`roll update` 也会继续完成恢复。
- `roll schedule service restart`：卸载后按当前 roll 与配置重装（`--json` 输出 `action` / `liveInvocations` / `reason`，供脚本判断）。有占用中的 invocation 时拒绝（退出码 1）；`--force` 会中断 daemon 托管的 invocation，但 `run-now --inline` 不受影响。未安装服务时同样退出 1；上次重装停在 `installing` 时可用同一命令继续恢复。若同一 `data-dir` 仍有前台 daemon，请先在对应终端按 Ctrl+C 停止后再重试。
- 用 nvm 等工具切换或删除 Node 版本后，固化的 node 路径会失效，LaunchAgent / Scheduled Task 无法拉起 daemon。此时 `roll schedule service status` 会报「服务定义指向的 node 已不存在」，`roll doctor` 的「Scheduler service」检查会记为失败并提示执行 `roll schedule service restart`；`roll schedule status` 在「已装服务但 daemon 未运行」时也会引导查看 `service status`。若 metadata 由早期版本生成且缺少 `binary` 字段，重装一次服务即可启用路径检测。

### 账本自动迁移与跨版本兼容（`v10`）

当前 scheduler 账本 schema 版本为 **`v10`**：

- **写入口自动迁移与旧进程隔离**：升级后首次通过新版 `roll schedule` 写入口操作或启动新版 daemon 时，受支持的旧版账本会在事务内自动迁移至 `v10`，完整保留原有任务规则、累计轮数、追加凭据、运行历史与会话关联（升级前无轮数上限的任务仍保持不限轮数，不会根据可能已清理的历史反推计数）。若检测到旧版或身份不可确认的 daemon 仍在运行，CLI 与聊天写入口会拒绝写入并提示先重启服务，数据库触发器也会阻止旧连接继续写入。不降级高于当前版本的未知账本。
- **只读诊断跨版本兼容（`v5–v10`）**：`list`、`show`、`status`、`runs`、`inspect`、聊天 `/schedule` 历史视图以及 `roll ui` 任务面板均使用只读查询连接，兼容读取 `v5–v10` 账本，不会创建空账本、修改文件权限或触发迁移。即使旧版 daemon 尚未重启，`roll ui` 和 CLI 查询命令仍可正常展示任务与状态（`roll ui` 在读取失败时会保留上次结果并禁用写操作，点击刷新即可重试）。

## 当前限制

- **触发规则边界**：支持固定间隔（`--every`）、每日定时（`--daily`）和每周定时（`--weekly` + `--time-zone`），暂不支持任意 Cron 表达式，也不支持“每天固定时刻开启一组多轮短间隔循环”的复合规则。
- **对话内工具范围**：聊天内模型仅可通过工具创建任务（`roll__schedule_create`）、查看列表（`roll__schedule_list`）及为已结束任务追加轮数（`roll__schedule_extend`）；暂停、恢复、取消运行与删除任务需通过 CLI 或 `roll ui` 执行，且定时任务自身的无人值守轮次内不能再创建或追加定时任务。
- **会话隔离**：每次运行（invocation）都会创建独立的新会话线程，不会自动续接上一轮运行的上下文。
- **常驻服务平台支持**：内建开机/登录自启用户服务支持 macOS（LaunchAgent）和 Windows（Scheduled Task）；Linux 暂未内置系统级开机自启服务安装命令，需以前台 `roll schedule daemon --foreground` 或配合 systemd user unit 等方式自行托管运行。
- **进程树可见性边界**：macOS 无法追踪已脱离受管进程组的后台守护进程；Windows 无法独立证明已脱离 exec 根进程的后代进程是否全部退出。
- **崩溃与中断极端边界**：`max-run` 超时判定由当轮 daemon 持有——若 daemon 恰在发出超时信号后自身崩溃，而 exec 随后迟到写入成功结果，新启动的 daemon 无法还原那次尚未落账的超时判定。`roll update` 的 scheduler admission lock 仅覆盖 update 进程存活期间；若进程在包替换中途被强制杀死，请重新运行 `roll update` 并通过 `roll schedule service status` / `restart` 恢复。

## 排查问题

### 任务一直没有运行

```bash
roll schedule status
```

确认 daemon 为 `running`，并核对输出中的 `data-dir` 是否与登记任务时使用的配置一致。daemon 在运行但日志里出现「scheduler admission 连续拒绝领取新任务」时，说明 service metadata 停在 `installing` 或无法解析（或另一个服务维护命令正持锁），此时不会触发任何任务，请按 `roll schedule service status` 的提示恢复。
macOS 或 Windows 如果安装了用户服务，再运行 `roll schedule service status` 检查服务状态；输出里的 `binary` 一行会指出固化的 node / roll 入口是否已失效或版本过期，`roll doctor` 的「Scheduler service」检查也会给出同样结论。失效时执行 `roll schedule service restart`。

### 查看 daemon 日志

```bash
roll schedule status
```

输出中的“日志”字段指向 `scheduler.log`。

### 定时任务报「apiKey 仍是未解析的环境变量占位符」

调度服务由 launchd（macOS）/ schtasks（Windows）启动，不会加载交互式终端的 `.zshrc`，因此 `roll.config.yaml` 里的 `${ENV_VAR}` 占位符可能在交互终端里能解析、在定时任务里却解析失败。

1. 运行 `roll doctor`，查看「Secrets 与占位符解析」检查项列出的未解析变量清单；
2. 把缺失的值写入 `~/.roll-agent/secrets.env`（`chmod 600`，每行 `KEY=VALUE`）；
3. 占位符解析发生在每次 invocation 子进程启动时，下一次触发即生效，无需重启服务；on-demand Agent 的下一次调用也会直接读取新值；core-managed Agent 持有长进程配置，轮换后需要依次执行 `roll agent stop <name>` 与 `roll agent start <name>`；external-managed Agent 则需要在外部管理系统中重启（`streamable-http` 只是传输协议，不决定由谁管理进程）；
4. 修复后如果任务处于暂停状态，运行 `roll schedule resume <schedule-id>`。

`roll schedule service install` 会在安装前预检并警告未解析占位符；用 `--skip-env-check` 可以跳过该预检。解析优先级：`process.env` 的非空值优先（空串视为未设置），随后回退 `secrets.env`。

### 定时任务里 Agent 启动失败「spawn xxx ENOENT」

调度服务（launchd / 计划任务）启动的进程只有系统最小 PATH（如 `/usr/bin:/bin:/usr/sbin:/sbin`），不含 Homebrew 等用户安装目录。定时任务运行时若某个 Agent 的启动命令（或任务中 Shell 工具执行的命令）不在这个 PATH 里，就会报 `spawn xxx ENOENT`，该 Agent 的工具在无人值守轮次中直接缺席。

- **`node` 已自动修复**：exec 子进程会把自身 node 所在目录前置进 PATH，`node` 系 Agent 无需配置；
- **其他命令**（python、专有 CLI 等）在 `roll.config.yaml` 的 `scheduler.env` 里补充 PATH：

  ```yaml
  scheduler:
    env:
      PATH: /opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
  ```

  `scheduler.env` 也可声明代理等任意环境变量（值支持 `${ENV_VAR}` 占位符与 `secrets.env` 回退），在每次任务运行前合入进程环境；

- 运行 `roll doctor`，「定时任务 Agent 命令可达性」检查项会列出调度环境下找不到的 Agent 启动命令。

### 任务因权限变化暂停

检查该任务对应配置来源（绑定的配置文件或任务 `--cwd` 下的配置）中的 `runtime.approval` 和 `runtime.shell` 设置，确认无误后运行：

```bash
roll schedule resume <schedule-id>
```

### 运行一直停在 `running`

先查看记录中的错误和进程树提示：

```bash
roll schedule runs <schedule-id>
```

如果提示进程树未清，使用 `cancel --kill`。只有无法验证且你愿意承担残留进程风险时，才使用 `cancel --abandon`。
