# 验收记录与必要结论

本目录保留当前真实验收基线、独立功能结论，以及被现有方案引用的历史结论摘要。历史通过只适用于对应快照，不代表 Cursor 当前改动已通过验收。

- **当前真实验收基线**：[10 月 14 日报告](2026-10-14-compaction-fresh-acceptance.md)及[结构化结果](2026-10-14-compaction-fresh-acceptance-results.json)，本次清理原样保留。独立高压单阶段通过，三阶段恢复未通过；Cursor 后续修复仍需重新独立验收。
- **独立功能结论**：[ChatGPT 订阅接入](2026-10-10-chatgpt-subscription-validation.md)、[xhigh/max](2026-10-10-chatgpt-extended-efforts.md)、[网络切换恢复](2026-10-12-chatgpt-offline-recovery.md)。这些是历史专项记录，不替代当前压缩验收。
- **历史契约与根因**：[输入持久化](2026-10-10-context-compaction-reliability-task1.md)、[工具参数 UI](2026-10-10-context-compaction-reliability-task1a.md)、[请求预算设计](2026-10-12-context-compaction-task2-design-review.md)、[Task 2](2026-10-12-context-compaction-task2.md)、[半窗口误停](2026-10-12-context-budget-half-window-incident.md)、[Task 3](2026-10-12-context-compaction-task3.md)。保留原路径，避免破坏方案引用。

压缩过程报告合并保留以下结论：

- 10 月 12 日发现短摘录遗漏长来源中尾事实；完整证据校验与分批吞吐修复后，特定编码夹具通过且可释放约 70% 空间。这不能证明持续多轮压缩已经闭环。
- 10 月 13 日验收仍出现重复继续指令挤满语义提醒、保留检查无进展及摘要超时；后续同一 SQLite 项目三轮续跑通过，主要依赖归档后的只读恢复，不能称为三次摘要成功。
- 四项 Review 缺口曾通过本地专项验收；10 月 14 日新夹具随后暴露多项必读与步骤预算的冲突。旧专项通过不能替代新反例和真实恢复验收。
- 推理强度 A/B 证据不足；保留继承策略，不能把实验未完成算作压缩修复通过。各次摘要配置不同，不能把 300 秒测试当作默认 120 秒的通过证明。
- 原网络调查复现 TLS 建立前断连／连接超时，未确定故障属于代理、线路还是服务端；它不需要压缩代码即可发生。修复行为与验证边界保留在网络恢复报告。

## 清理说明

过期过程报告、旧轮次原始 JSON 及外部归档已删除，不再保留副本。本目录只保留必要结论和当前验收记录；历史测试结果不替代当前代码的独立验收。
