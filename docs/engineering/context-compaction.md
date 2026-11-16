# 上下文压缩与历史兼容契约

修改压缩预算、摘要、checkpoint、transcript 回查、旧会话恢复或相关协议兼容时读取。

本文承接根 [AGENTS.md](../../AGENTS.md) 的专项工程约定。下文源码路径均相对于仓库根目录。

## 长上下文压缩契约

- 默认压缩路径是有界任务摘要、近期原文与按需历史回查。摘要是有损历史上下文，不是 system 指令、审批凭据或工具执行事实源。
- 每次维护最多一次摘要调用，禁用隐式重试；保留当前用户输入和完整 Tool call/result 步骤。超时、取消、空摘要或候选没有实际缩减时不替换原上下文。
- 完整 SDK 请求决定预算准入。75% 为软触发阈值；失败后仍能满足硬预算则继续，不能满足则明确结束本轮。整轮 deadline、maxSteps 和已完成工具执行不重置。
- V3 checkpoint 与 active messages 经事务/CAS 原子提交；必须用最终待提交 checkpoint 验证完整变化投影确实缩小。原始 transcript 与 Tool ledger 保留，遵循既有脱敏/retention。
- `roll__transcript` 是只读、按需回查工具；分页列出（`afterSequence`/`limit`）与单条分块（`sequence`/`offset`/`maxChars`，跟进 `nextOffset`）两组参数互斥，切换模式时省略另一组字段。较早片段通过 `previousCheckpointId` 继续回查。没有 ready、receipt 或恢复门禁。
- V1/V2 会话复用有界 checkpoint 提示打开，首次压缩复用普通 V3 摘要路径；不拼接或要求完整旧上下文。旧 checkpoint、账本与恢复备注通过 `roll__transcript` 的 `legacy_context` 分页/分块回查，沿 previousCheckpointId 访问。仅把将移出 active 且尚未存入 transcript 的旧摘要片段原子补存为 legacy_snapshot；旧表不删除。
- 旧来源因 retention 缺失只影响该记录的回查，不阻断会话打开或正常压缩；不能据此推断未授权或未执行。数据库仍为 v11，未知高版本拒绝打开、已知损坏 checkpoint 回退与事务失败回滚规则保留。
- Runtime 1.6 / Relay 1.3 旧事件仍可解析与重放；新会话不广播恢复生命周期，快照 contextRecovery 为 null。Relay Wire 1.3 仍须协调服务端升级，默认保持 1.2。

## 使用与回查

用户操作、分块参数和旧会话使用方式见 [长对话压缩与历史回查](../how-to-context-compaction.md)。
