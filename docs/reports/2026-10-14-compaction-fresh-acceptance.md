# 清理后长上下文独立验收（2026-10-14）

## 结论

**整体未通过；独立高压单阶段通过，三阶段恢复任务未通过。** 当前摘要路径可以直接释放空间，不能再把所有归档都解释为摘要错误。旧的回查副本反馈问题已经被当前代码排除，但真实执行暴露了恢复读回与步骤预算的矛盾，以及结构化摘要证据引用质量问题。

## 基线与边界

- `dev@12878256b9355dee29ca5cc00256278fc4805ccf`，使用当前未提交修复。两次均新建临时项目和 SQLite 数据库，未使用 `--resume`，未读取已清理的旧数据库。
- 模型 `chatgpt / gpt-6.1-sol`，执行与摘要均继承当前 `medium`。窗口 128000，阈值 0.75，整轮期限 300 秒、24 个模型步骤。
- 本机已有配置的摘要期限是 **300 秒**，未改用户配置；产品默认 120 秒未改。恢复场景两次摘要分别超过 120 秒，因此本次不构成默认期限的通过证明。
- 两个场景各执行一次，保留所有失败，没有为了得到通过而反复重跑。测试包含受控长历史和旧 checkpoint 种子，但数据库本身是全新。
- 宿主断言直接导入实际生成文件执行；额外检查另起 Node 进程执行，不采用模型自报完成作为验收依据。

## 结果

| 场景 | 摘要与空间变化 | 真实编码及恢复 | 判定 |
| --- | --- | --- | --- |
| 高压保留历史 `advisory` | 1 次摘要，65.268 秒，正常 stop；直接移除 22 条、保留 19 条；0 次 fallback。维护估算输入 102247 → 46003，非 Provider tokenizer 的释放量 | 恢复门禁最终通过，继续 read/edit/read/verify；宿主 14/14，独立额外 4/4；无请求错误，共 18 个模型请求 | 该单阶段通过 |
| 三阶段 `recovery` | 2 次正常摘要，129.611 / 125.554 秒；各自 valid checkpoint 但 removed 0。3 次 fallback 分别移除 20 / 6 / 15 条 | 第一阶段 14/14；第二阶段及最终 18/24；独立额外 5/7。隐藏标签确实被回查，但最终 tagged batch 断言失败 | 未通过 |

不能用 `progressingCompactions: 3` 表示“三次摘要成功释放空间”：该计数包含三次归档兜底。

## 为什么三阶段仍然走归档

### 1. 两次 removed 0 的直接原因包含手动切分策略，不能简单归因于摘要异常

两个摘要都有正常输出、生成 valid checkpoint，并推进消息语义水位 0 → 27 → 57。手动压缩开始时，活跃消息分别只有 21 / 16 条，且都只有索引 0 一条 user 消息，即只剩一轮；估算消息 tokens 为 8190 / 4814，远低于窗口阈值 96000。

`keepRecentTurns=2` 留下该轮。`planCut()` 在现有内容已低于目标时直接返回，不进入轮内步骤切分。`runCompactionTurn()` 随后只要 `historyChanged=false` 就调用归档恢复。因此，**手动压缩低压力单轮内容，即便摘要有效，也会出现 valid/removed 0 后接 fallback**。这不是原先“请求卡在硬上限之外”的同一个现象。

代码依据：[planCut](../../packages/runtime/src/engine/compactor.ts#L270)、[手动压缩入口](../../packages/runtime/src/engine/agent-session.ts#L3793)。第三次归档 `manual-followup` 则在已有恢复状态下直接发生，根本没有调用摘要模型。

### 2. 旧积压已清除，但仍有有限批次与引用质量问题

相较旧样本遗漏 433 / 524 / 598 项，本次两份实际摘要请求只遗漏 **26 / 59** 项，每批仍送入 32 项。旧数字不适用于这次新库。

当前 `captureCompactionEvidence()` 自动覆盖已持久化的纯 `roll__context` 调用/结果副本；包含新文字的混合消息仍须作为证据。离线回放分别识别 16 / 54 条派生消息、11 / 61 条回查执行记录，5 个针对门禁与证据的测试全部通过。旧的纯回查副本反馈环未在本次重现。

两份摘要仍分别有 **9 / 5 项语义候选被拒绝**：

- 第一份有 8 项 completed_work 在多条引文中重复同一个 `sourceEvidenceIds`，被 `resolveEvidence()` 的唯一性要求拒绝；另有 1 项资源未经观测。
- 第二份有 2 项重复来源 ID、2 项未观测资源、1 项缺成功执行证据。
- 工具语义水位停在 11，最早未覆盖来源是序号 12 的真实 `edit_file`，随后是 `read_file`，已经不是 context 回查副本。
- 消息水位仍在推进，不能称为完全死锁。批次遗漏和引用拒绝影响提取完整性，但不是本次低压力手动 removed 0 的唯一、也不是最直接的解释。

代码依据：[派生证据排除](../../packages/runtime/src/engine/agent-session.ts#L3487)、[重复来源 ID 拒绝](../../packages/runtime/src/engine/compaction-semantic-state.ts#L1101)。离线回放第一份缺少三个会话动态资源行；实际 32 个 presented IDs 和 9 项拒绝结果匹配，但不将它宣称为完整请求精确重放。第三份请求重建一致。

### 3. 新的恢复推进缺口：27 项必读内容超过逐条读取时的步骤预算

最后一轮的 `required=27`。模型每个步骤读取一项，24 次模型请求结束时仍 `remaining=3`，没有 successful ready，也没有进入文件修复。运行时同一整轮的恢复与正常工作共享 `maxSteps=24`；代码会在达到步骤上限时停止。

这说明先前补强的“完整覆盖后才允许 ready”门禁确实在工作，但 **安全门禁通过测试不等于真实恢复能够及时完成**。实际模型没有稳定地批量读取，当前提示、分页与预算组合会在约束较多时耗尽步骤。本次 benchmark 未记录 `message-finish.stoppedAtStepLimit` 字段，直接证据是 24 次请求、24 项读取、3 项剩余及对应源码上限，未把缺失字段当成已观测事件。

应优先补一个 27 项以上、逐条读取、实际步骤/时间预算下的端到端反例，并实现有界的批量读回或可推进恢复方案，保留完整覆盖要求。代码依据：[共享步骤停止条件](../../packages/runtime/src/engine/agent-session.ts#L2643)、[恢复工具指引](../../packages/runtime/src/tool-bridge/context-tool.ts#L132)。

### 4. 两次外部请求错误单列

- 第一阶段代码已通过 14 项宿主断言，但最后模型请求触发 `ChatGPT Responses stream ended without response.completed.`。当前 guard 还会在 finishReason 为 error 或 usage 缺失时抛出同一句，因此只能确认流完整性检查失败，不能唯一认定服务端缺某个事件。
- 第二阶段报 `AI_APICallError → ChatGptAuthError(network_error) → TypeError(fetch failed)`，当时 signal 未 abort。该次日志的 cause 深度限制未保留更深传输错误，不能断言是 TLS、代理或具体网络节点。
- 第一条错误不是摘要请求错误；第二条发生在恢复/执行请求中。本次两份摘要本身都正常 stop。
- 既有脚本会在第二阶段中断后继续第三阶段；未完成的 `planBatch` 影响后续 tagged batch。最终编码失败不能全部归因于另一个独立产品 bug。

代码依据：[Responses 完整性 guard](../../packages/core/src/llm/chatgpt-model.ts#L218)。

## 本次改动与验证

只改基准脚本可观测性，未改 Runtime/Core 产品实现：

- `scripts/bench/compaction-continuity.mjs` 保存错误原因链、实际摘要证据批次、水位和 checkpoint 状态。
- 新增 `compaction-diagnostics.mjs` 和 3 个测试；错误诊断过滤凭证并排除响应头/body/stack。第一次运行后将 cause 深度 3 扩展为 5，避免 SDK/auth 包装遮住传输错误，并补测试；不声称恢复了前次未保存的数据。
- `pnpm test:scripts`：52 通过、10 跳过、0 失败；其中包括上述 3 个测试。
- `context-recovery-evidence.test.ts` + `context-recovery-gate.test.ts`：5/5。
- 三个脚本的 Prettier、ESLint 与 `git diff --check` 通过。
- 基线共 1709 个已有文件，除基准脚本外逐文件 SHA256 均未变化。13 个工具参数 UI 文件保持不变，两个 live run 的四个产品实现文件哈希与当前一致。HEAD 未变，未提交、未推送。

## 下一步

1. 优先修复恢复的可推进性：保留完整覆盖门禁，补 27+ 必读项、逐条读取、24 步预算的端到端反例，再验证批量读取/分页方案。
2. 明确来源 ID 与多条引文的契约，对重复来源引用做受控处理，并继续拒绝未知来源、越界引用、缺成功证据的完成声明。
3. 将手动低压力整理与自动高压力压缩分开验收。连续高压测试应检查每次压缩前后的实际请求预算，不用“三次归档计数”替代“三次摘要释放空间”。

## 证据文件

- [结构化结果](2026-10-14-compaction-fresh-acceptance-results.json)
- 恢复场景原始报告：`/var/folders/s3/6g1jk25x6w540ddns5r0_yh00000gn/T/roll-clean-acceptance-20261014-yqk1b313/fresh-recovery.json`
- 高压场景原始报告：`/var/folders/s3/6g1jk25x6w540ddns5r0_yh00000gn/T/roll-clean-acceptance-20261014-yqk1b313/fresh-advisory.json`
- 恢复项目：`/var/folders/s3/6g1jk25x6w540ddns5r0_yh00000gn/T/roll-continuity-live-M93Wbl`
- 高压项目：`/var/folders/s3/6g1jk25x6w540ddns5r0_yh00000gn/T/roll-continuity-live-rimDfk`
- 原始 prompt、snapshot、SQLite 和生成代码均保留在上述临时目录，未清理。
