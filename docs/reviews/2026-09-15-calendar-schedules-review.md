# 日历定时：对抗性审查与修复记录

## 结论与范围

审查基线为 `dev` / `f58fd78` 上未提交的日历定时实现，包含新增文件。以用户确认的语义为准：实际 08:07 领取的间隔任务下一次是 08:37；日历任务默认取运行机器时区，创建后固定；rounds 是总自动轮数，不是成功回复次数。

共确认并修复六类问题，其中旧连接写入兼容性为 P1，其余为 P2。没有遗留本次审查已确认的 P1/P2 问题。修复没有增加 cron、每天开启一组循环、业务截止时间或 BOSS 业务逻辑。

## 已确认发现与原始反例

| 级别 | 问题及触发场景                                                                                                                                                                                 | 修复与验证                                                                                                                                                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1   | 旧 daemon 已打开 v8 数据库，新进程升级到 v9 并登记 calendar；旧代码解析失败后把新任务写成 paused。提高 user_version 只能阻止重新打开，不能隔离已有连接。                                       | 用 `f58fd78` 的真实旧源码复现。Runtime 增加连接级写入版本标识和数据库写入守卫；旧连接现在被拒绝，任务保持 active/0 轮，新连接可以领取。Core 检测旧/不可确认的 daemon，登记及写存储打开前要求重启；维护占用检查改为只读，避免“检查能否重启”先迁移账本。 |
| P2   | Asia/Kolkata 与 Asia/Calcutta 指向同一时区，JSON 去重却创建了两份等价任务。                                                                                                                    | 时区校验后统一为 Intl 的规范名称；原别名相等断言修复前失败、修复后通过。时间偏移等价、星期顺序和重复项也纳入验证。                                                                                                                                     |
| P2   | 创建和持久化共用带系统默认值的 schema：直接验证缺失 timeZone 的 trigger 会成功并补值，parseTriggerJson 却拒绝；实际模型 JSON Schema 还携带生成时的机器时区 default。未知顶层参数也可能被丢弃。 | 区分可省略时区的创建输入与必须显式含时区的规范规则，去掉读取时的补值分支；模型 schema 不再冻结机器默认值，顶层未知字段明确拒绝。                                                                                                                       |
| P2   | 小终端的确认框只保留一行参数，长 prompt 把后面的首次时间、时区和轮数挤掉；结构化 ApprovalRequest 正确不代表用户看得到。                                                                        | 加入 PgUp/PgDn 完整参数页，保留原有选择与批准按键。实际 Ink 渲染在 45 列、9 行下翻页能读到具体时间、时区、20 轮；原 No 默认值、方向键、y/n/Esc、会话授权和 diff 界面测试保留通过。                                                                     |
| P2   | 网页按浏览器本地时区格式化 nextRunAt，任务规则却显示保存的时区，两者无明确区分。                                                                                                               | Core 提供带任务时区的显示值，网页直接消费。把修改前后的真实 React 组件放在纽约时区渲染：旧版缺少预期的上海 08:00 标签，新版正确展示。不是计时器错误，而是显示语义缺口。                                                                                |
| P2   | Node 22.6 会忽略 SQLite readOnly 选项，名义上的只读连接实际可以 INSERT。                                                                                                                       | Fable 复审后改为优先原生 readOnly，并在所有版本启用和验证 query_only，恢复旧 Node 的查询、update/service 检查兼容性；拒绝 SQL 写入。该回退不提供文件级只读保证，连接打开阶段的底层恢复不在保证内。                                                     |

## 模块与架构审查

- `packages/runtime/src/scheduler/` 保持规则、时间计算、状态机与存储所有权；`calendar.ts` 的日历计算接收显式时区，不按执行机器重新解释保存的规则。
- 创建输入和持久化 schema 分离，类型从 schema 派生。已有 interval 数据保持可读，新 daily/weekly 复用既有轮数、重试、单例和清场逻辑。
- `database-version.ts` 只实现 SQLite 连接兼容性；它不是授权边界。标识使用空的连接内内存数据库，不包含业务状态，连接关闭即释放。没有把 PID/OS 判断放进 Store。
- Core 持有 daemon 身份与版本判断、机器环境、权限、CLI 和显示值；服务维护使用 Runtime 的只读占用查询，不复刻 SQL 状态规则。
- Tool Bridge 负责参数、审批和调用；网页优先消费服务端显示值。旧字段及 ISO 时间保留，新增显示字段可选。
- 保留旧接口的 everyMs/everyDisplay 兼容字段，没有为消除命名偏好进行额外重构。测试中的原始 SQL 连接显式采用当前写入版本，旧连接反例使用不带标识的真实连接。

## 已证伪的算法与生命周期假设

- 独立 UTC 分钟枚举器与生产算法对照，覆盖纽约春秋切换、Lord Howe 半小时切换、Chatham、Casablanca、Apia 日期跳跃及非整小时时区；18 个 daily/weekly 对照场景通过。
- 闰日、跨月跨年、星期切换、开始时间前后 1ms、时间戳上下限、非法日期/时区以及等价 ISO 偏移均有断言。
- 修改进程时区后，已保存规则和下次触发不变；新输入仍按当前机器时区解释。
- 原始“明天 08:00 / 每 30 分钟 / 20 轮”不会提前领取；20 轮后终结；重启、重试、暂停、恢复、追加轮数和手动运行不会重置或误扣额度。
- 停机多日只补一次，日历下一次重新对齐；未清场进程树保持单例。现有取消、超时重分类和身份未知拒绝释放的回归继续通过。

## 测试有效性与实际消费

- 原“两个连接轮流调用”不当作真实竞争证据。新增两个真实子进程，通过 IPC 屏障同时放行，断言仅一个领取且额度只增加一次。
- 审批等待测试使用真实 SQLite 写锁和独立进程。进入 BEGIN 前通知父进程，父进程推进独立时钟并放锁；断言锁获取后的时间校验拒绝过期首次时间，且无任务写入。
- 三种场景经过真实工具、Core binding、临时配置与 SQLite，再验证到期领取；读取 SDK 实际生成的 JSON Schema。没有把 mock port 的返回值当成落库证明。
- Core、Runtime 及依赖的六个本地 tarball 解包到隔离目录，关闭 TypeScript stripping 后验证 CLI 创建、Core 公开 binding、Runtime 真实领取。Roll 包使用解包产物，第三方依赖复用本地安装；没有发布到 npm。
- 在 Node 24.21 和经过官方 SHA-256 校验的 Node 22.6 上执行产物验证。Fable 复审补充验证 22.6 上 query_only 查询可用且 SQL 写入被拒绝；这不等价于文件级只读。
- 修复过程中拒绝了依赖 DatabaseSync.function 的版本标识方案，因为该 API 从 Node 22.13 才支持；改用早期 SQLite 已支持的内存 ATTACH。全量回归又捕获标识注册早于 busy_timeout 的独占锁失败，调整顺序后重跑原始测试通过。

## 验证记录与边界

- Fable 复审后的完整回归：642 项，640 通过、0 失败；2 项仅适用于 Linux environ 进程探测的测试在 macOS 跳过。包含 update 流程、SQL 查询保护、真实进程竞争、审批锁等待、诊断命令及小终端参数翻页。
- Core/Runtime 类型检查、改动 TypeScript/TSX 的 ESLint/Prettier、六个相关包生产构建和 diff 空白检查通过。
- Node 官方依据：[readOnly 在 22.12 加入](https://nodejs.org/en/blog/release/v22.12.0)、[SQLite function 在 22.13 加入](https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html#databasefunctionname-options-function)。发布包不提高 engines 下限；旧 Node 采用 [query_only SQL 保护](https://www.sqlite.org/pragma.html#pragma_query_only)，不再硬拒绝正常查询，但不宣称具有文件级只读保证。

## Fable5 复审跟进

1. 守卫安装改为比较 SQLite 中保存的定义：相同定义不执行 DDL，缺失时创建、变化时仅替换该守卫；相同 user_version 也不重复写。实测第二次打开 schema_version 不再增加 24，缺失/错误守卫仍能修复。
2. 恢复旧 Node 的查询兼容性，所有查询连接开启 query_only 并验证生效。明确纠正“query_only 等同于真正文件只读”的说法；兼容性和底层恢复保证分开描述。
   Node 22.6 的连续读写产物测试进一步发现，close_v2 的延迟关闭可能保留显式读事务。快照读取现会在 finally 中明确 ROLLBACK 后再关闭连接；复现中的后续写入不再遭遇 database is locked，并增加了最低版本的锁释放回归。
3. list/show/status/runs 走查询连接，不更改磁盘 schema、不迁移、不 chmod；旧 daemon 存在时仍可查询。status 提供 requiresRestart，写入口保持版本门禁。
4. --weekly 非法星期名直接输出值和允许列表，不再暴露含义不明的数字最小值校验。
5. Windows 卸载和 installing 回滚的 openStore 均发生在 daemon fence 内；该调用点使用已有持锁豁免，消除残留元数据误拒。update 激活前的未知身份保护保持不变。
6. 保留已确认的 DST 跳过语义；不把日历任务改为跳时当天自动顺延。其余低价值展示小项不扩大改动。

- 没有调用真实模型提供商验证所有自然语言表达，也没有执行真实 BOSS 回复；验证的是实际模型 schema、工具及调度消费链路。
- 没有操作真实调度账本、安装/重启用户服务、commit 或 push。Windows/macOS 服务控制包含既有隔离测试，不等同于在 Windows 真机重装服务验收。
- GitNexus 用于影响定位；其索引会报告部分动态调用/执行流未覆盖，缺失符号以源码和运行反例补证。不能将图上的空调用方或风险分数视为完整正确性证明。
- Fable 复审后 `detect_changes(scope=all)` 覆盖 54 个变更文件，报告风险为 critical，结果未带 partial/truncated 标记。新增文件以 intent-to-add 纳入完整 diff，实际暂存内容为空；风险通过源码复核及上述回归验证处理，没有解释成“没有影响”。

本轮可复用临时证据位于 `/tmp/roll-calendar-audit.kWWB1S/`：`verify-legacy.mjs`、`verify-artifacts.mjs`、`regressions-final.log`，以及隔离 tarball 消费目录。临时证据可用于本机复查，持久回归测试已放在对应源码目录。

## OpenClaw skill / changeset 与端到端复验

- 更新维护中的 `openclaw-roll-core-skill-template/`，去掉“仅间隔”说明，补全 CLI/聊天参数映射、保存时区、DST、首次时间、追加轮数和 v9 升级诊断。明确 `run-now` 会在未来开始时间前产生真实副作用，不能自动用于业务冒烟测试；CLI add 的模糊结果不能假设幂等而盲目重试。
- skill-creator 的 `quick_validate.py` 通过；UI 元数据及 9 个本地引用链接通过。新增真实 `roll skills install --dir <temp>` 用例，验证主文档、references 和 `agents/openai.yaml` 完整复制。
- Changesets 的实际 release plan 只包含 Core `0.39.1 → 0.40.0` 与 Runtime `0.22.1 → 0.23.0`。补充旧 Node 读事务释放及模板消费说明；没有执行版本改写或发布。
- 官方完整 E2E 首轮 63/67：1 处旧测试裸 SQL 夹具被 v9 写入守卫拦截；3 处 doctor 断言继承了开发者 home 状态，在隔离 home 下原样复测全部通过。夹具改用当前写入标识，公共 E2E 子进程默认隔离 home；未削弱生产守卫或修改预期退出码。
- 修复并新增测试后，`pnpm test:e2e` **69/69 通过，0 跳过**。新增三类任务均由真实 CLI 创建，在真实未来分钟由 daemon 领取、exec 子进程执行、通过 HTTP 模拟模型响应并落库，最终各消耗一轮且正常清场退出。断言首次时间前无调用、机器时区变化不移动保存的时间、每轮模型收到当前机器时区与 scheduled origin，以及执行历史可读取。没有 mock claim、daemon 或执行引擎。
- 额外 CLI / 聊天工具 / Core binding / 账本领取及 daemon 轮数生命周期回归 **8/8 通过**。Core/Runtime 类型检查、改动测试 ESLint/Prettier、Core 生产构建、编译后 `agent health` 懒加载入口、六包隔离 tarball 消费及 React 时区显示反例均通过。
- GitNexus 刷新后，公共 E2E helper 的文件级影响为 MEDIUM，直接影响 11 个测试文件；源码确认无生产入口依赖。全量未提交变更的图风险仍为 critical，包含此前日历/状态机变更，不能解释为本次测试修补没有风险。图中动态调用及新文件覆盖不足之处仍以源码和真实回归补证。
- 本次成功链路使用本地模拟模型，不证明真实 OpenClaw 模型的自然语言理解或真实 BOSS 回复效果；未安装/重启真实用户服务，未 commit/push。日志：`template-e2e-before.log`、`template-isolated-diagnostics.log`、`template-e2e-final.log`、`template-calendar-regression.log`、`template-artifacts-final.log`（均在上述临时证据目录）。
