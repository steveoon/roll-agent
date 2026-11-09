# Runtime 模型配置更新复审

本次检查涵盖 codex/runtime-model-config-reload 的实现、文档、Changeset 和新增回归测试。目标基线为 origin/main 的 7657a7f4，开始检查时 HEAD 为 cafa2072，文件内容与基线一致，实现位于工作区。检查环境为 macOS ARM64、Node 24.21.0 和 pnpm 11.24.0。

**问题与方案**

设置写入后，已打开的 Runtime 会话继续持有旧模型。Core 重读启动时绑定的配置来源并构造 provider，Runtime 在全部活动轮次结算后调用同步宿主接口应用模型。待应用和失败时暂停新轮次准入。Protocol 1.6 提供可选查询与更新方法，client-node 通过既有类型化 request 接口消费。

**既有约束的复核**

| 约束 | 当前状态与证据 |
| --- | --- |
| Core → Runtime → Protocol | Runtime 只持有中立宿主接口、模型标识和固定错误分类。YAML、环境变量及 provider 选择位于 Core |
| 当前轮次保持原模型 | 审批等待期间未调用更新宿主。审批或取消结算后才应用 |
| 连续保存与幂等 | 多个待应用请求只在最后结算时执行一次更新，旧 requestId 重放返回原结果，当前状态保持最新版本 |
| 异常恢复 | 宿主抛出异常时返回固定 apply-failed，拒绝新轮次。新的更新请求可以恢复，再次执行轮次成功 |
| 异步准入 | turn.start 等待会话查找时并发发生更新失败，查找后的第二次检查阻止旧模型执行 |
| 配置来源与资源 | 真实 stdio 验证读取绑定来源、端点和 secrets.env，同一会话保留历史及暂存附件 |
| Reasoning 能力 | 已修复错误声明和订阅准入。21 项真实 stdio reasoning 场景通过，热更新验证从 thinking off 切到 text 并显式订阅 |

**Scorecard**

| Axis | Score | Evidence |
| --- | --- | --- |
| Correctness | 9/10 | 真实请求验证和审批、取消、幂等、并发准入、失败重试回归 |
| Design / Architecture | 9/10 | Core 负责配置及 provider，Runtime 负责轮次与资源生命周期，Protocol 负责公开契约 |
| Testing | 9/10 | 原有 stdio E2E 加四项针对并发和异常的回归，Windows CI 增加服务测试 |
| Operability | 9/10 | 可查询 pending/failed，使用固定错误分类并允许显式重试 |
| Docs / Contract | 9/10 | 协议、client-node 文档和 Changeset 对应可选 1.6 能力 |
| Complexity / Maintainability | 9/10 | 复用现有模型切换、配置解析、幂等缓存和请求接口 |

Overall 为 A-，原始均分 9.0/10，没有未解决的阻塞项，因此不应用严重程度上限。该评分采用 benchmark-code-review 的本地六轴量表。提交前意见为本地检查通过，PR 的实际合并条件还包括 Windows/Linux CI 成功。

**发现与处理**

确认并修复一项 Medium 契约缺陷。新增配置更新能力时，RuntimeService.initialize 无条件声明 reasoning-summary，subscribeReasoningText 也绕过了当前模型的 text 能力检查。只需用配置文件启动 Runtime，即使模型不提供 summary 或已关闭 thinking，也会声明相应能力。完整 E2E 首轮出现 12 项 reasoning 契约断言失败，属于本变更新引入的问题。

修复后握手和订阅继续按当前模型判断。新模型应用结果通过 active.reasoning 返回 summary、text 或 null，客户端据此刷新展示并显式订阅本地 text。21 项既有 reasoning stdio 场景全部通过，新热更新 E2E 也验证 thinking off 到 text 的切换及实际增量。该问题已修复，因此不构成未解决项。

原有验证还缺少等待审批、取消、同步宿主异常和异步会话查找竞态的覆盖，已添加四项回归。Windows 工作流加入服务测试和完整 reasoning E2E。

**设计判断**

Engine 级门禁复用了共享 MCP Sampling 的现有模型归属。逐会话同时使用新旧模型需要增加 Sampling 和模型资源的轮次归属，本次保留既定 Engine 级范围。应用结果通过查询获取，复用现有事件形状。配置来源切换和非模型设置变化走安全重连，避免将历史库、策略或 Agent 配置局部混入当前 Engine。

**安全边界与失败语义**

更新请求不接受配置路径或凭证，客户端只能要求宿主重读已绑定来源。加载器和 provider 异常不会作为原始错误返回。应用失败后的 active 表示最后一次确认成功的模型，新轮次被拒绝，允许修复配置后发起新请求。底层存储或会话占用损坏仍遵循既有 fail-closed 和重连路径。

**验证范围**

实际执行了新增四项服务回归。提交验证执行工作区测试、typecheck、lint、Core E2E、生产构建及发布入口冒烟，命令结果见本次 PR。真实 stdio E2E 使用隔离 HOME、临时历史库和 loopback provider，不使用个人配置或外部模型服务。

**未验证及不适用范围**

- 提交时尚未完成的 Windows/Linux 检查由 PR CI 运行，最终结果以对应提交的 checks 为准。
- Desktop 设置页接线及成品客户端验证在另一个仓库执行，本次只交付 Roll Agent 接口。
- 未进行真实 provider 付费调用或存储硬件故障注入。
- 未增加新的正则或字符串策略门禁，regex audit 无新增适用项。
- 未变更依赖、数据库 schema、Relay wire 或发布权限。
