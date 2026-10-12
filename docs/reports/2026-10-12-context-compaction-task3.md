# Task 3 与半窗口误停修复交付

日期：2026-10-12。基线：`dev@31816c3a88c250565dafa5032eb9e5d645c7ceb8`。

状态：代码已实现，本地验证通过，停在用户验收点。用户已将实现交给 Codex，Roll 未再收到写代码指令。因此本报告是实现者的验证报告，不冒称新的独立验收。Task 4、Phase 2 未展开。

## 本轮修复

半窗口事件的原始证据、隔离复现和归因限制保留在 [incident report](2026-10-12-context-budget-half-window-incident.md)。本轮修复的是已证明的回归链路；没有声称从缺失的现场日志恢复了那个请求的精确 token 数。

- 请求预算允许兼容实测纠正高估。负残差在历史缩小时按比例缩减，避免固定负偏移把小请求算成零；opaque 内容的摘要参与兼容性检查，密文被移除、替换或改成普通文本时，不继承旧折扣。原始估计、实测、校准估计仍分别保留，均不称为精确 tokenizer 结果。
- 普通用户文本不再使请求配置指纹每轮失效。实际 system、工具 schema、Provider options、Skill 内容和 opaque 内容变化仍使对应校准失效。
- 派发判断使用当前兼容校准；维护的 before/after 使用整段固定的比较基准。校准失效或重置不能伪造空间释放。Provider 已拒绝的未知窗口请求，仍须在相同比较基准下实际缩小，不能仅换 checkpoint ID 再发。
- 工具结果持久化、临时 reasoning 清理后，先让下一次真实 SDK 准备验证请求。该路径必须有新完成的步骤，并共享原回合步数上限，不会绕过最大步数或重放工具。
- CLI 在每个 `step-finish` 更新最近实测输入，不再一直等 `message-finish`。预算错误同时说明估计输入、可用上限和最近实测；没有新增诊断表或公开协议事件。

## Task 3 实现

- 证据仍限制为 32 项、生产 48k 字符。序列化后必须容纳最旧消息和最旧工具记录；当前目标额外保留，前一语义目标在剩余预算内优先保留；消息与工具交替，资源使用空余位置。无法容纳的最旧证据明确失败，不跳过并伪造覆盖。
- `CompactionPassResult` 只报告真正提交的历史变化、coverageBefore/coverageAfter、checkpoint ID/generation。它没有伪造的 finalized after。维护状态把此安装结果与本 pass 的 before 绑定，下一次真实 SDK 准备才补齐 after、局部/累计 token 差值。取消、失败或超时前没有发生准备时，after 保持缺席。
- 允许覆盖推进而 active history 完全不变的 checkpoint，继续使用原有 Store CAS 和来源验证。仅当前受保护用户目标、没有旧证据的情况不建立重复 checkpoint。
- 每段维护共享绝对截止时间和成本上限。草稿调用额度为 `min(32,max(4,max(ceil(messages/15),ceil(tools/15))+2))`；准备和 pass 上限为草稿额度加 2，包含初始准备并预留最终实际检查。生产摘要仍 `maxRetries:0`；provider middleware 在实际委托调用前计费，失败和测试中的重试均计数。
- 每四个 pass 让出事件循环，不更新截止时间或额度。等价状态最多一次摘要和一次确定性 fallback；checkpoint UUID/generation/time 不重置状态。新的真实工具进展可以开始下一段维护，同一 send 不再有“两次成功压缩后停用”的限制。
- 累计实质空间进展按 `max(256,ceil(baseline*0.005))` 判断，小窗口最多取窗口的 5%；微小变化不续期。证据覆盖推进与完整请求变小分别记录。
- 维护额度耗尽后仍会实际检查可发送性：低于硬上限、只高于 75% 软目标的请求可继续；真实超限或未缩小的已拒绝请求停止并保留输入和操作。

## 验证证据

| 检查 | 最终结果 |
| --- | --- |
| Runtime 全量 | 1604 项：1587 通过、17 跳过、0 失败 |
| Core 全量 | 1939 项：1934 通过、5 跳过、0 失败 |
| Protocol | 48/48 通过 |
| Runtime、Core（含 UI）、Protocol 类型检查 | 通过 |
| 仓库 lint | 通过 |
| 三包发布构建 | 通过 |
| 发布态 CLI `agent health` | 独立临时目录与空 Agent 配置，输出“暂无已注册 Agent” |

关键回归包含：

1. 50% 实测输入、每步 25k 字符加密 reasoning：7 次模型调用、6 次工具操作，正常完成，无重放；不带密文的对照也完成。
2. 同一 send 中至少三段维护后完成七次工具操作，输入身份一致，原始 deadline/maxSteps 不扩张。
3. 40 条消息与 40 条工具记录，三批覆盖位置都推进到 39；active history 不变，SQLite 重开后覆盖位置及工具记录 ID 一致。第一批没有把全部 captured range 当成覆盖。
4. 摘要超时后仍保留实际检查机会，能容纳但高于软目标的请求正常完成；超时结果不能提交 checkpoint。
5. 原来的 schema 刷新污染、未知窗口拒绝后请求增大、取消后由新回合补 after 等缺陷没有复发。真实临时文件只写一次，成功续跑/拒绝后重开账本身份不变，必要持久化失败后不重放副作用。
6. 真正超限、关闭压缩、用户拒绝、未知副作用、非法调度重试、Skill 及取消/超时等保护继续通过 Runtime 回归。

第一次与发布构建同时跑的后期 Runtime 回归有两个失败：scheduler SQLite `database is locked`，以及 verifier 子进程 `--version` 探测超过 3 秒。两条原用例在独立重跑中通过；随后不并行构建的 Runtime 全量再次 1587/17/0。没有改这两个模块，也没有跳过测试。

历史 probe 的“必须恰好两次准备”改成 Task 3 有限上限；其“一旦原始估计变大就必须压缩”的断言也不适用于兼容实测高估已经纠正的请求。保留原脚本，另存 Task 3 适配副本；真实超限、效果次数、持久化身份和不重放断言保留。仓库内真实压力 fixture 按实际 prepared request 报告 mock usage，继续验证压缩和完整请求派发。

主要日志：`/tmp/codex-context-fix-runtime-confirm.log`、`/tmp/codex-context-fix-core-final.log`、`/tmp/codex-context-fix-protocol-1.log`、`/tmp/codex-context-fix-types-final.log`、`/tmp/codex-context-fix-lint-final.log`、`/tmp/codex-context-fix-build.log`、`/tmp/codex-context-fix-cli.log`、`/tmp/codex-budget-half-window-fixed-final.log`、`/tmp/codex-task3-regression-probes.log`。永久回归在相应 `*.test.ts` 文件中。

## 边界与交接

GitNexus 在修改前将 AgentSession/RequestBudgetTracker 影响判为 CRITICAL，已提前告知。图用于定位影响面；动态调用、符号未解析与索引的流程裁剪仍有覆盖限制，不能据此声称全仓无风险。

最终索引刷新成功：41,745 nodes、265,855 edges、1046 flows。MCP 与 CLI `detect_changes --scope all` 都只映射到 23 个已跟踪变化文件中的 4 个 class，报告 0 个 affected processes / low；它不覆盖本轮新增的未跟踪文件，而且没有提供 partial/truncated 完整性字段。索引日志另有 candidate cap 和流程裁剪告警。此结果视为受限映射，不能用其零结果推翻修改前的 CRITICAL 影响判断或证明完整覆盖。日志在 `/tmp/codex-context-fix-index-final.log`、`/tmp/codex-context-fix-graph-changes.log`。

没有真实订阅模型调用，没有完整 Core E2E，也没有把 mock 通过说成现场会话验证。未重启 Metalterm 中已加载旧代码的 Roll 进程，所以该进程不会因源码改动自动获得本轮修复。没有修改认证、模型/thinking/审批设置、现场线程数据库，未恢复自动化，未暂存、commit、push 或发布。

当前输入、工具证据和工作区中的其他未提交成果均保留。下一步为用户验收本地实现；Task 4 继续关闭。
