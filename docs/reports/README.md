# 验收记录

本目录保留当前设计的验收快照及仍有参考价值的专项结论。每份报告只证明其记录的版本和场景，不能替代当前代码的独立验收。

## Context window 压缩

当前设计为“任务摘要＋近期原文＋按需历史回查”，使用与兼容边界见[上下文压缩说明](../how-to-context-compaction.md)。

- [10 月 16 日简化与旧会话兼容验收](2026-10-16-context-compaction-simplification.md)：记录设计取舍、本地回归、旧数据库升级及真实旧会话副本的兼容验证。
- 该报告中的连续压缩和旧会话验证使用模拟模型；真实 Provider 三轮续跑未在该报告中完成验收。真实摘要质量、延迟与本地持久化正确性分别判断。
- [连续压缩验收脚本](../../scripts/bench/compaction-continuity.mjs)和[编码质量对照脚本](../../scripts/bench/compaction-coding-quality.mjs)继续保留，用于后续显式发起的真实 Provider 验收。

旧语义覆盖、归档恢复和强制读回门禁已退出新运行路径。旧设计的多阶段验收结果不再作为当前压缩机制的基线。

## ChatGPT 专项记录

- [订阅接入](2026-10-10-chatgpt-subscription-validation.md)
- [xhigh/max 推理档位](2026-10-10-chatgpt-extended-efforts.md)
- [网络切换恢复](2026-10-12-chatgpt-offline-recovery.md)

这些报告保留各自的测试环境、成功与失败证据及限制，不替代当前版本的完整回归。最新使用方法见[订阅聊天指南](../how-to-use-chatgpt-subscription.md)。

## 历史资料

已被实现或新设计替代的开工方案、旧压缩过程报告及逐轮 JSON 已从工作树移除，可通过 Git 历史回溯。仍适用的契约、兼容限制与待验收事项保留在现行指南和上述报告中。
