# 会话模型接口实施计划（修订）

日期：2026-11-09。分支：codex/chat-workspace-experience。用户明确要求模型选择不持久化；第三方 App 自行决定保存/恢复。

设计见 ../thread-model-selection-design.md。保留既有 workspace、只读浏览、配置重载及两项 P2 修复；无 commit/push/release 操作。

- [x] 撤除模型策略持久化、schema 13 和自动跨启动恢复；保留 workspace schema 12。
- [x] 恢复 CLI 原有模型候选、临时切换、默认值写入及 Fast/思考参数行为；scheduler 保持原 Engine。
- [x] 只在协议服务使用独立 Engine/AgentHost 资源范围；复用原 Session 与模型切换，不替换活跃资源。
- [x] 将会话选择修订改为内存 UUID；旧实例请求不能覆盖新实例。保留请求幂等、所有权、配置快照和安全结算检查。
- [x] 更新 Protocol/client-node 文档，说明生命周期、状态查询、App 恢复步骤及兼容性。
- [x] 回归：并发、异常恢复、模型与 Sampling 隔离、无数据库写入、关闭重开及 CLI 不继承。
- [x] 验证：全量受影响测试、E2E、typecheck/lint/build、编译 CLI smoke 和完整图变更分析。
- [x] 按 benchmark-code-review 复查边界、并发、生命周期、冗余代码；报告验证范围与剩余限制。

结果与限制见 [Review 报告](../reports/2026-11-09-thread-model-selection-review.md)。本地验证完成；Windows/Linux CI 和 Desktop UI 对接未执行。

## 整体 Review 后的修复（2026-11-09）

- [x] model.set 只操作已附着的可写会话；拒绝 detach 后的迟到请求时不创建宿主或重新取得占用。
- [x] 恢复基础 REPL 的本地 `/model` 提示，修正文档/注释中的 schema 版本。
- [x] 复现并修复 Antigravity 提出的默认重载失败、open/reload 竞态和启动模型可选参数残留。
- [x] 删除重复初始模型准备/切换；稳定 Ink 配置订阅回调；关闭先取消子 Engine 的 bootstrap 再等待收敛。
- [x] 补齐故障恢复、受控并发、真实 Runtime/独立 CLI 接力、基础 CLI 命令和 Ink 订阅回归。
- [x] 全量单测/E2E、类型、Lint、构建、编译 CLI、完整图分析及修复后复审；记录 Antigravity 设计取舍的实际影响。
