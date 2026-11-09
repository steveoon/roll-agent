# 会话内模型接口修订与 Review

日期：2026-11-09。分支：`codex/chat-workspace-experience`。HEAD：`4a2af7dce284ac8f7ccb3f57d36145e62c3353ad`。本地未提交、未 push、未发布。

本记录已更新为整体 Review 之后的修复复审，取代此前“无剩余缺陷”的阶段性结论。Antigravity 的审查内容来自本机应用中本项目的 Benchmark Code Review Skill 对话；该内容仅作为待验证意见。

## Prior issues → status

| 问题 | 状态 | 当前证据 |
|---|---|---|
| P2：detach 后迟到的首次 model.set 在拒绝旧 revision 前重新打开、占用会话 | fixed | Service 仅查找已附着会话，不调用 requireSession。回归确认无新宿主、占用仍 available；真实 Runtime 拒绝后，另一个 CLI 进程立即续聊成功。 |
| P3：基础 REPL `/model` 被当作未知 skill | fixed | 恢复本地“请在全屏模式使用”提示。真实 CLI 连续输入两种命令均不请求模型，之后普通消息正常执行。 |
| P3：注释/计划仍称 schema 13 和模型策略持久化 | fixed | Store 注释及 workspace 计划改为 schema 12；模型选择仍不持久化，没有新增迁移。 |
| Antigravity：默认模型应用失败但全局重载报告成功 | fixed | 默认跟随者准备/应用失败会使 reload 拒绝。两种故障注入均确认全局和会话 failed、执行被阻止，修复后重载和实际轮次恢复。 |
| Antigravity：open/reload 并发提前完成 | fixed | 重载等待 opening；open 等待当前准备任务，包括被取消任务的后继。受控 bootstrap/prepare 屏障确认两种提前返回均不再发生，实际轮次使用最新模型。 |
| Antigravity：新模型缺少可选字段时继承旧启动参数 | fixed | Core 工厂从宿主基础选项剔除模型相关可选字段，仅从当前 selection 注入。真实 ConversationEngine bootstrap 捕获的 Provider 参数不再残留。 |
| Antigravity：ChatApp 内联回调导致重复订阅 | fixed | useCallback 稳定回调；Ink 回归确认模型变更和父组件重渲染只订阅一次，草稿保留，卸载正常取消订阅。 |
| 额外发现：关闭等待 bootstrap，而 bootstrap 等待子 Engine 的关闭信号 | fixed | dispose 先启动子 Engine 清理，再等待 opening/prepare；宿主初始化取消回归通过。 |
| Antigravity：未跟踪计划/报告应清理 | accepted | 尚未提交时的 untracked 状态不是运行缺陷。这些设计、实施计划为用户要求的交付物，保留并更新同一份报告；提交时明确纳入范围。 |

## Review scope

工作区修复复审，包含已跟踪及未跟踪改动。分支 HEAD 如上，与本地 main 文件树相同；merge-base 为 `7f4eaef316f1d33cace4a7e215b1ee64f38e72cf`，本轮有效改动主要在工作区。真实 Git index 未暂存。

重点追踪 Service → ThreadModelEngine → ConversationEngine/AgentHost，以及 Core 工厂、模型重载、基础 REPL、Ink 订阅和 Protocol/client-node 文档。保留先前项目归属、只读浏览和配置绑定功能。没有修改 Desktop、真实用户配置、数据库、安装或凭证。

环境：macOS、Node 24.21.0、pnpm 11.24.0。真实 CLI/stdin/stdout、HTTP 和 MCP 验证使用独立 HOME、临时配置/历史和 localhost 服务；不是调用在线模型。

## 理解（问题 → 方案）

第三方 App 需要为已打开的会话临时选择模型。Core 持有配置、凭证、Provider 构造，Runtime 负责会话执行、隔离和生命周期；Protocol/client-node 暴露有界的 list/get/set。
选择不持久化，App 自己决定是否保存并在重新打开后显式恢复。既有 CLI/scheduler 仍使用原 ConversationEngine。
本轮补齐拒绝操作无副作用、异步打开/重载收敛及失败状态一致性；复用原 switchModel，不新增存储策略或跨层依赖。

## Scorecard

| Axis | Score | Evidence / reason |
|---|---|---|
| Correctness | 9/10 | 迟到请求、故障恢复、受控竞态、bootstrap 关闭及真实 Sampling/CLI 通过；没有剩余已确认缺陷 |
| Design / Architecture | 9/10 | Core 仍负责 Provider 和配置，Runtime 使用中立宿主契约；模型选择无存储字段，CLI/scheduler 不经过多会话适配器 |
| Testing | 9/10 | 回归在修复前暴露缺陷；全量单测/E2E 与真实子进程验证通过；原生 Windows/Linux 尚未执行 |
| Operability | 8/10 | 重载成功/失败与实际就绪一致，关闭取消可收敛；未做大量附着会话的资源负载验证 |
| Docs / Contract | 9/10 | 明确已打开前置条件、历史标签含义、迁移版本及全局/局部失败区别 |
| Complexity / Maintainability | 8/10 | 删除重复模型准备/切换，稳定 UI 回调；多会话异步生命周期仍需专门管理与测试 |

**Overall: B+ (8.7/10), provisional**。Raw aggregate 8.7，无未解决 Critical/High 上限。评分为 benchmark-code-review 本地六轴规则，不是官方标准。

**Merge disposition: Not assessed**：本地修复复审完成；未创建 PR，未运行 Windows/Linux CI 或 Desktop UI 验收，不等同于发布/合并结论。

## Findings

### Critical / High

没有剩余已确认问题。

### Medium

没有剩余已确认问题。Antigravity 三项 Medium 均已针对真实实现验证并修复，不能仅以已有测试通过来否定。

### Low / Questions

未跟踪文件是提交范围管理问题；设计和报告继续保留。回调身份变化是父组件重渲染时的重复订阅，不应夸大为每个 token/每次输入都会订阅。无新增未证实缺陷作为阻断项。

## Design notes 与实际场景影响

1. **独立会话 Engine/AgentHost 是必要隔离。** MCP Sampling 绑定连接。若 A/B 共享连接，A 修改 Sampling 模型会影响 B；全局锁则牺牲多会话并发。当前只在多会话协议宿主使用独立资源，复用原 Engine/Session。Desktop 同时打开多个会话会增加 MCP 连接和可能的 stdio 子进程，应对不再执行的会话 detach，列表浏览不需要打开全部会话。普通 CLI/scheduler 没有这层额外开销。
2. **workspace 存储是跨客户端共享数据，模型选择不是。** schema 12 的 workspace 让 CLI/Desktop 按同一项目归类；旧数据库仍走既有显式备份迁移，共用该库的旧客户端须升级。模型接口本身不新增迁移。数据库 `threads.model` 只是历史标签，不保证反映当前 active；App 应查询 get 的 active/status。不能为了处理打开期间的重载而重新引入模型持久化。
3. **只读占用检查和实际取得占用必须分开。** 列表展示仅为提示，不能创建、回收或续租 claim；真正续聊仍需原子 claim。此次修复还保证关闭标签页后迟到的切换请求不会偷偷重新占用，CLI 可接着使用。
4. **版本检查、进程探活和 ChatGPT 能力预检属于必要复杂度。** 删除它们会分别破坏跨版本数据保护、跨客户端排他和模型可执行性。反之，子 Engine 初始化后再准备/切换同一初始模型属于多余步骤，现已删除；它原本主要是重复配置/宿主工作，并不等于两次推理或两笔 token 消耗。
5. **全局失败和单会话失败应区分。** 默认跟随者无法应用新配置时，全局不能说 applied。显式选择的候选被移除时，只让该会话 failed，其他会话继续工作。用户修正配置后可 reload，或为局部失败的会话改选有效模型。
6. **启动参数残留的影响有边界。** 旧参数确实会进入新子 Engine 的 bootstrap/Sampling 接线；原流程后续切换往往会清掉，因此不能据此认定每一轮都用了错误参数，更不是已证实的凭证泄漏。工厂现明确从当前选择取得全部模型参数。
7. **安全边界。** 候选/错误不返回密钥、base URL、Provider options 或内部堆栈；数据库查询使用绑定参数，模型修改保留所有权、revision、configRevision、幂等和安全结算门禁。没有新增高风险正则；基础 `/model` 的精确/空格前缀判断保留 `/model-*` 自定义 skill 的路由。

## Verification performed

- 修复前回归确认：迟到请求重占用、基础 `/model` 路由错误、默认应用失败被报告为成功、open/reload 提前完成、Core 工厂旧参数残留；无用的重复初始准备也由计数回归确认。schema 版本问题由实际常量和文档比对确认。
- `pnpm test`：5,089 项，5,046 通过，43 按平台/已有条件跳过，0 失败。Core 2,221 项；Runtime 1,721 项。
- `pnpm test:e2e`：112/112 通过。其中 workspace/模型的 8 项真实子进程场景包括 MCP Sampling、迟到请求后独立 CLI 续聊、App 显式恢复、Runtime 重启不继承、项目筛选、只读占用浏览、配置重载和任务配置绑定。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过。
- 本轮修改的 TypeScript 文件经 Prettier 校验无需进一步变更；`git diff --check` 通过，真实暂存区仍为空。
- 编译产物 `node packages/core/dist/cli/index.js agent health` 在隔离 HOME/cwd 返回“暂无已注册 Agent”。这项验证发布后的懒加载入口，不等同于完整安装包验收。
- GitNexus 编辑前 impact 显示共享 Engine/工厂为 HIGH，已告知并核对调用链。刷新索引后，以临时 Git index 纳入未跟踪文件执行 `detect_changes(scope=all, limit=2000)`：75 文件、666 符号、78 受影响执行流程、critical 范围；结果未标记 partial/truncated，真实 index 哈希不变。critical 是变更范围提示，不是已发现 Critical 缺陷。
- `detect_changes(scope=compare, base_ref=main, limit=2000)` 同样完成，返回相同范围且未标记 partial/truncated。
- 图解析仍存在动态 receiver 未解析、跨语言字段和全库流程预算限制；通过源码及真实 server/CLI/MCP 测试补充关键调用路径，不能把未返回调用者视作没有影响。

## Unverified coverage

- Applicable checks not run：Windows/Linux 原生及 CI、生产 Desktop UI、打包安装分发验收、大量同时附着会话的资源负载。它们不由当前 macOS 的源码 CLI 测试替代。
- Untraced callers/integration/orchestration paths：图工具无法穷尽动态调用；关键 Core 工厂 → server、CLI、scheduler 路径已补查，第三方 App 如何展示和保存选择由其自身实现负责。
- Non-applicable protocols/major sections：本轮未改变传输认证、发布流程、OS 服务或新增数据库迁移，对应专项审计 N/A；现有机制保留回归，不宣称全面安全审计。

## What looks strong

- 真实 stdio 与独立 CLI 的接力证明失败请求没有资源占用副作用，而非只检查错误码。
- 竞态使用可控制的 bootstrap/prepare 屏障验证前后条件，避免依赖随机重跑。
- 配置和数据库不写入、实际模型请求及 Sampling 隔离都有行为证据；Core/Runtime 职责保持单向。

## Residual risks / follow-ups

提交前纳入现有源码、测试、changeset、设计与计划；创建 PR 后验证 Windows/Linux CI。Desktop 对接时确认先 open 再 get/set、pending/failed 的界面处理及闲置会话 detach。当前未提交、未 push。
