# Context window 压缩简化验收（2026-10-16）

## 结论与边界

已按用户选择实现“任务摘要＋保留近期原文，旧细节按需回查”。本地确定性行为测试、消费端回归、类型检查、lint、构建和 Core E2E 通过。真实 Provider 的三次压缩续跑尚未执行，不将模拟模型测试认定为真实摘要质量或延迟验收。

基线为 `dev@17705aeb885b8fdec0d9916ac771a15af25eec3e` 加实施前全部未提交修改。对照 `origin/dev@f95f4980`、`origin/main@b166e2e3`，两者相关压缩基线一致。实现先在 `codex/context-compaction-simplify` 隔离 worktree 验证，再同步当前工作区；不改写分支历史，不提交或推送。ChatGPT/auth、推理档位、网络恢复、工具参数 UI、聊天历史分页及原有无关 staged 文档删除保持原样。

集成后逐文件校验实现与隔离副本相同；原暂存区 patch 字节不变，无关文件哈希保持不变。当前工作区再次通过 32 项关键回归、Runtime 类型检查和最后修改文件的 lint。

完整备份：`/tmp/roll-context-simplification-baseline-20261016/`，包含 HEAD、index、工作区 patch、文件归档和 1697 个文件的 SHA256。

## 原有扩展与本次取舍

远端基线已经包含结构化语义摘要、引用验证和 checkpoint，并非只有简单摘要。本地 `7792a1b7`、`12878256`、`25601f2e`、`70f706e1` 等变更又加入/扩展完整请求预算、输入持久化、持久化语义账本、覆盖水位/游标、维护调度、归档恢复、强制读回/ready 门禁及跨进程恢复状态。多层机制交叉，使“摘要完成”“覆盖推进”“释放窗口”“允许继续执行”成为不同状态。

| 机制 | 本次处理 |
| --- | --- |
| 最终 SDK 请求预算、输出预留、实测 usage 校准及形状失效 | 保留；软阈值与硬准入分开 |
| 输入先落盘、工具结算落盘、原整轮 deadline/maxSteps、不重放副作用 | 保留并回归 |
| checkpoint/CAS/事务、tool-call/result 完整配对、原始记录 | 保留 |
| 逐条 semantic registry、quote/coverage 验证、覆盖游标、MaintenanceEpisode | 移除新运行路径 |
| 摘要失败后主动归档、coverage-only 成功判据 | 移除；失败保留原上下文 |
| `roll__context`、receipt/notes/ready 和普通工具恢复门禁 | 移除；回查不再控制工具权限 |
| 摘要 | 一次有界纯文本请求，输入旧摘要和实际拟移除的完整历史 |
| 成功判定 | 非空有界摘要、最终请求投影确实缩小、原子提交成功 |
| `roll__transcript` | 保留分页，新增指定原文序号的脱敏分块读取及续读 offset |
| 数据兼容 | 新 V3 checkpoint / DB v11；保留 V1/V2、旧表和旧协议事件读取 |
| 既有显式 `truncate` | 保留配置兼容；不作为摘要失败自动 fallback |

候选仅缩减摘要正文不算成功：校验的是存储层即将提交的最终 checkpoint reminder 和消息投影。摘要不可用但请求仍满足硬预算时继续；否则明确结束本轮，已接受输入和已完成工具工作保留。之后增加新的历史仍可再次压缩。

旧会话复用现有有界 checkpoint 提示，首次压缩复用普通 V3 路径，不再拼接完整旧上下文。旧 checkpoint、账本和恢复备注通过 `legacy_context` 分页/分块回查；只有将移出 active 且未存入 transcript 的旧摘要片段需要原子补存为 `legacy_snapshot`。retention 缺失只影响具体回查，不阻断打开或压缩。剩余 semantic/checkpoint 代码承担旧格式读取，不删除已有历史数据。

## 复杂度变化

按实施前实际工作区与实施后逐文件计数，变更涉及的生产 TypeScript 从 **18,586 行变为 13,148 行，净减少 5,438 行**，不含测试、基准脚本和文档。不是相对旧 HEAD 的数字，避免漏算原有未提交修改。

| 文件 | 实施前 | 实施后 |
| --- | ---: | ---: |
| `engine/agent-session.ts` | 5340 | 3556 |
| `engine/compactor.ts` | 693 | 340 |
| `engine/compaction-semantic-state.ts` | 2560 | 679 |
| `engine/compaction-checkpoint.ts` | 1228 | 1030 |
| `store/semantic-ledger.ts` | 354 | 164 |
| `store/thread-store.ts` | 3167 | 2922 |
| `tool-bridge/transcript-tool.ts` | 254 | 378 |

相比 `origin/dev`，`AgentSession` 也从 4080 行降为 3556 行，`compactor` 从 588 行降为 340 行；本次是围绕选定设计做针对性简化，并不是机械退回远端实现。

完整删除 `compaction-evidence-batch`、`compaction-recovery`、`compaction-retention`、`maintenance-fingerprint`、`context-tool`。旧语义门禁专用测试与实验脚本随已删除契约撤除，输入持久化、预算和工具副作用回归保留/改写；新增摘要连续压缩及存储迁移测试。

## 验证证据

工具链：Node 24.21.0、项目指定 pnpm 11.24.0。隔离副本复用既有 node_modules，执行时使用 `pnpm --config.verify-deps-before-run=false`，避免 pnpm 自动安装拒绝临时 symlink；未改依赖或 lockfile。需要本地 shell 输出目录的测试在正常本机权限运行。

| 检查 | 结果 |
| --- | --- |
| Runtime 全部测试 | 1581 项：1564 通过，17 跳过，0 失败 |
| Core 单元/集成测试 | 1971 项：1966 通过，5 跳过，0 失败 |
| Protocol / Client Node / Relay Protocol / Relay Client | 50 / 68 / 40 / 38 项全部通过 |
| 根级 scripts 测试 | 56 项：46 通过，10 跳过，0 失败 |
| Core E2E | 75/75 通过 |
| 全 workspace typecheck、lint、build | 通过 |
| 最后输入/摘要/存储边界回归 | 32/32 通过 |

新行为覆盖：

- 三次摘要后关闭并重开 SQLite，任务继续且已接受输入不丢失。
- 单一长工具轮自动摘要 7 次、模型推理流 9 次、写副作用恰好 8 次，call/result 配对完整。
- 模拟模型通过真实内建 transcript 工具分块读到摘要未保留的长原文尾部标识，并用于后续答案；不只检查数据库中存在该值。
- Provider 抛错、空摘要、摘要变长时同状态不循环；软预算继续，硬预算结束后重启仍保留输入。
- 最终提交元数据造成不缩减时回滚；旧格式、旧库升级、fork、旧账本详情分块回查和失败事务验证。
- 摘要失败也先发送无变更的结束事件，再恢复推理，避免 CLI 持续显示“压缩中”。
- 120 秒默认期限通过默认参数断言验证；缩短期限下验证忽略 abort 的 Provider 仍被及时停止等待。未宣称真实 Provider 在 120 秒内完成。

日志：`/tmp/roll-simplify-runtime-final.log`、`/tmp/roll-simplify-consumer-tests.log`、`/tmp/roll-simplify-script-tests.log`、`/tmp/roll-simplify-e2e.log`、`/tmp/roll-simplify-typecheck-all.log`、`/tmp/roll-simplify-lint-all.log`、`/tmp/roll-simplify-build.log`、`/tmp/roll-simplify-runtime-build-final.log`、`/tmp/roll-simplify-final-boundaries.log`。

真实续跑脚本 `scripts/bench/compaction-continuity.mjs` 已改为新契约：临时项目、全新 SQLite、三轮默认 120 秒摘要、重开数据库、隐藏标识回查及 24 项宿主代码断言。当前配置为 `chatgpt / gpt-6-astra`。自动审批审查拒绝了真实调用，原因是缺少对发送模拟对话/临时代码到模型服务的明确授权；已向用户询问，未绕过限制。新脚本尚未真实执行，成功率和真实延迟未知。

## GitNexus

CLI 1.6.12 的 analyze/status/query/context/impact/detect-changes 可用。最初旧索引的增量分析出现 FTS `Invalid UTF-8`，全量重建后消失。GitNexus MCP `list_repos` 在当前会话仍报 `Transport closed`；索引修复不等于 MCP 传输恢复。

编辑前的图分析覆盖 Session、compactor、checkpoint、Store 等关键符号；`runCompaction` 为 HIGH（12 个上游符号），`runTurn` 和跨层核心入口为 CRITICAL。已验证自动、手动、overflow、存储、CLI/Protocol/Relay 消费路径。Store 方法部分动态接收者无法解析，使用实际源码/测试补证，未把空调用集视为无影响。

原工作区全量重建后 status 匹配全部 1413 个 covered 文件，query/context 实际返回结果。detect-changes 报告 62 个 tracked 变更文件、269 个符号、25 条流程、critical 风险。因 CLI 展示只打印前 15 个符号和 10 条流程，又调用同一 LocalBackend 获取完整结构化结果：269 个符号和 25 条流程均返回，`partial=false`、`truncated=false`。索引本身仍有执行流程入口/深度/步数上限，不将图中缺席路径判为无影响。完整结果保存于 `/tmp/roll-simplify-original-nexus-changes.json`；查询、状态和索引日志位于 `/tmp/roll-simplify-original-nexus-*.log`、`/tmp/roll-simplify-original-index.log`。

## 后续旧会话兼容修复

针对 `--last` 的实际失败，删除了全量 legacy context 拼接和“所有历史来源必须齐全”的转换前置检查，复用已有 V1/V2 有界提示与正常 V3 摘要路径。原来的数据库升级、未知高版本拒绝、损坏 checkpoint 回退和事务/CAS 保持原样，数据库仍为 v11。

`roll__transcript` 新增 `legacy_context`，按旧 checkpoint 代际分页读旧账本，长条目复用脱敏后分块；旧恢复 memo/notes 作为历史资料保留并随 fork 复制。只有移出 active 且尚未存入 transcript 的旧摘要片段才补存，失败事务回滚、已经归档的片段不重复写入，即使片段到第二次 V3 压缩才移除也能保留。

本次验证：Runtime 1598 项（1581 通过、17 跳过、0 失败）；Core chat 启动及会话入口定向回归 35/35；Runtime/Core 类型检查、修改文件 lint 与 Runtime TypeScript 构建通过。最后的存储/Engine/Runtime 兼容测试 18/18。V7/V8 测试移除了当时尚不存在的表再升级，覆盖 V1/V2 打开、首次摘要失败与成功、重启、fork、大账本代际分页、备注脱敏分块和事务回滚。

另从此前报错的真实第 32 代会话取得只读快照，复制到临时数据库，用模拟模型走真实 Engine/Runtime 和内建回查工具。42 条 active 消息正常加载，旧提示 7998 字符；1154 条旧账本事实加 checkpoint 元数据全部分页可读。加入一轮新输入后，只调用一次摘要即转为 V3，保留 2 条近期消息；1343 条原 transcript 保留，另有新增输入/回答 2 条。重启后旧账本条目经工具进入下一次模型请求，fork 的历史定位可用，1119 条已有工具执行未重放。原数据库仅只读访问，模型网络调用为 0；这验证的是兼容与持久化行为，不评估真实模型的摘要质量。

日志：`/tmp/roll-legacy-compat-runtime.log`、`/tmp/roll-legacy-compat-core-entry.log`、`/tmp/roll-legacy-compat-focused-final.log`、`/tmp/roll-legacy-compat-typecheck.log`、`/tmp/roll-legacy-compat-core-typecheck.log`、`/tmp/roll-legacy-compat-lint.log`、`/tmp/roll-legacy-compat-build.log`、`/tmp/roll-legacy-compat-acceptance.log`。本次修复前快照在 `/tmp/roll-legacy-compat-before-20261016-230206/`；原暂存区 patch 保持不变。

GitNexus 增量图谱出现跨文件符号归因异常，完整重建后再取结构化变更结果：整个工作区已有 62 个 tracked 变更文件、287 个符号、25 条流程，未标记 partial/truncated，风险为 critical。这包含此前全部压缩简化修改，不是本次四项修复的独立计数；图谱有解析边界，仍以源码和实际入口回归为验收依据。结果位于 `/tmp/roll-legacy-compat-changes-full.json`。

## 明确取舍和下一步

纯摘要不再提供逐条事实覆盖证明。模型可能遗漏旧细节，回查也依赖模型主动调用；系统保留原文和回查入口，但不保证每条旧约束必然被读回。巨大单条来源无法在摘要预算内完整容纳时保持原上下文，可能最终触发硬预算失败。已有 retention 删除的数据不会恢复。

实现和本地回归已完成。剩余验收是用户允许后运行一次真实三轮续跑，保留失败结果；观察真实摘要质量和默认期限，不再增加新的恢复状态机。
