# Runtime configuration context：实施验收与 Review

## Review scope

- 日期：2026-11-05；分支：`codex/runtime-config-context`。本报告记录提交前审查快照，后续远端验证以 PR Checks 为准。
- 模式：工作区审查，包含 tracked diff 和新增源文件、测试、说明、Changeset；index 原先为空。
- 基线 / HEAD：`fc6346bdccb15440a52bb91cd2b8b8500fac43df`；本次功能尚未 commit、push、创建 PR 或发布。
- 范围：Core 配置上下文、Runtime 中立调度持久化、Core 调度执行与重新授权、相关测试及文档。
- 排除：另一个项目中的 Electron UI/IPC/打包实现、已安装 CLI、用户配置和真实会话数据、OS service 安装、发布工作流。PR 准备阶段另将本轮配置绑定单测和真实执行 E2E 加入 Windows CI 显式清单；Linux 由全量 globs 覆盖。
- 环境：macOS arm64，Node 24.21.0，pnpm 11.24.0，与当前仓库声明一致。本报告是同一任务内的第二遍审查，没有独立审查者。

## 理解（问题 → 方案）

执行目录和配置发现起点原先默认相同，桌面日常任务无法在独立任务目录内稳定复用既有配置。
仅改变 stdio 启动参数会遗漏后台执行、续期和重新授权，daemon 重启后可能重新读取任务目录的配置。
Core 现在显式解析配置来源与资源基准目录，并将所需执行设置映射给 Runtime。
Runtime 只验证、事务性保存可选的 opaque host context；配置内容仍由 Core 解释。
旧任务不增加绑定，继续按原有 cwd 发现配置；新的显式绑定在来源失效时拒绝回退。

## 设计验收项 → 状态

| 验收项 | 状态 | 当前证据 |
| --- | --- | --- |
| 配置 B 与执行目录 A 分离，包含浏览器 executable/profile/session 路径 | 完成 | `runtime-context.test.ts` 验证独立资源基准、绝对路径、`~/`、auto/off、无参数等价；真实 stdio/Agent 读取 B 的浏览器配置并在 A 执行 Shell |
| 定时任务创建、列表、续期与重启执行保持绑定 | 完成 | Core binding 回归、Runtime reopen/idempotency 测试、真实 daemon 停止后重新启动并执行 |
| 从其他配置管理既有任务时，按任务保存的来源重新授权 | 完成 | 跨来源续期回归，以及真实 CLI resume 和默认 UI controller 调用 |
| 缺失/损坏来源不能降级到任务目录配置 | 完成 | 真实 daemon 记录 terminal failed，provider 调用次数不增加；旧无绑定任务仍可成功执行 |
| 公开 API 与构建产物实际可用 | 完成 | 六个内部包的真实 tarball 组成隔离应用，裸 Node 禁用 type stripping 后加载公开 API 与构建 CLI |

## Scorecard

| Axis | Score | Evidence / reason |
| --- | --- | --- |
| Correctness | 9/10 | 绑定参与事务性创建及幂等身份；确认期间配置变化拒绝；旧记录与旧 writer、真实失败路径均有覆盖 |
| Design / Architecture | 9/10 | Core 解释配置；Runtime 保存中立上下文；未反向依赖 Core，未新增桌面专用 Protocol 字段 |
| Testing | 8/10 | 全量单测/E2E、真实进程与打包探针通过；43 项全量单测跳过，Windows/Linux 原生执行仍待 CI/对应机器验证 |
| Operability | 8/10 | schema 10、旧 writer fence 和重启要求有说明；原生服务安装、已发布 standalone 与 Electron bundle 未在本轮重新发布验证 |
| Docs / Contract | 9/10 | 参数、路径基准、旧行为、失效规则和升级边界已记录；Changesets 预览为 Core 1.4.0 / Runtime 1.3.0 |
| Complexity / Maintainability | 9/10 | 复用 loader、既有 ledger 和执行状态机；没有复制配置、影子数据库、自动安装服务或新增未使用的 RPC |

**Overall: B+ (8.7/10), provisional**。Raw aggregate = (9 + 9 + 8 + 8 + 9 + 9) / 6 = 8.666…，一次四舍五入为 8.7；没有未解决的 Critical/High，未应用 severity cap。此为 Google-inspired principles + 本地六轴量表。

**Merge disposition: Not assessed**：本地实现验收通过、未发现可确认的遗留阻断缺陷；远端 CI、Windows/Linux 原生路径及 Electron 集成不在本轮已执行验证内。本结论不代表已经合并或发布。

## Findings

### Critical / High

无剩余可确认问题。

### Medium

无需要用户另行接受的已确认设计缺陷。

### Low / Questions

本轮收尾删除了 UI 权限回调中不再需要的 cwd 回退：参数契约要求完整 `ScheduleRecord`，默认实现统一调用 `loadScheduleConfig(schedule)`。配置路径保持引用，用户后续编辑配置会在下一次使用时生效；这符合本轮要求，不提供冻结配置快照的重现保证。

## Design notes

| Load-bearing decision | 可信替代方案及优势 | 结论与不变量 |
| --- | --- | --- |
| 显式 Core 配置上下文 | 全局 cwd/env override 能减少参数接线 | 显式上下文不会改变其他会话的隐式进程状态；资源基准和执行目录可分别验证；默认入口直接复用既有 loader |
| Runtime ledger 保存 opaque context | Core sidecar 无需 Runtime schema 迁移 | sidecar 需要维护两份状态的一致性与生命周期；在现有事务中保存 nullable 字段更直接，Runtime 不理解 Core 配置 |
| 保存路径引用而非有效配置快照 | 快照可固定执行配置，便于重现 | 快照会复制凭证并阻碍更新；当前需求是沿用所选来源，Core 在使用时加载，确认用私有 revision 检查变化 |
| 复用现有 Protocol/client-node | 新增配置管理 RPC 可进一步收敛 Desktop 接入面 | 本轮新增的是 Core 宿主能力与调度持久化，不需要让 Runtime 接管产品配置；更广的宿主管理接口整理是独立工作 |

- Essential complexity：区分 legacy/bound、确认后复核、schema 迁移/旧 writer fence，以及执行前和执行后的进程树门禁。
- Accidental complexity：未发现需要新增抽象的重复子系统；UI 中多余的 fallback 已删除。没有为未来需求增加未使用的 API。
- Security / trust boundaries：宿主路径由受信任 Core/桌面 Main 授权，模型的调度输入不能指定绑定。Core context 使用严格 Zod 对象，Runtime opaque 字符串限制 1–8192 字符；SQL 值参数化。账本只保存路径引用，确认 revision 使用进程私有 HMAC；未将有效配置或密钥写入 ledger/tool 输出。
- 执行顺序：`executeInvocation` 获取权威任务并完成原有 preflight 后，Core 才加载该任务的配置；配置失败仍经过既有 settle/fail 路径。未绕过 claim、有限轮次、CAS、进程树清场或资源关闭。
- Regex / hardcoded filters：本次无新增业务或安全 regex。`auto/off` 是现有 instructions 保留值，已在实际 JavaScript 测试中验证；路径使用 Node path API，结构使用 Zod/JSON 解析。

## Verification performed

| 验证 | 结果及证明范围 |
| --- | --- |
| `pnpm typecheck`、`pnpm lint` | 全仓库通过；最后 UI 回调契约收紧后另跑 Core typecheck 和变更文件 lint |
| `pnpm test` | 5,007 项，4,964 pass，43 skipped，0 fail；之后新增独立资源基准用例，配置专项 3/3 通过 |
| `pnpm test:e2e` | 103/103 通过，包含本轮真实 stdio/daemon/CLI/UI 验证 |
| 收尾回归 | UI controller、配置、calendar 迁移及真实 stdio/daemon E2E 在最终回调契约上再次验证 |
| `pnpm test:scripts` | 65 项，55 pass、10 skipped、0 fail |
| `pnpm build` | 全仓库构建通过；收紧 UI 回调后另跑 Core build |
| `pnpm verify:published-packages` | 所有发布包 tarball 审计及 dependency denylist 通过 |
| 打包产物探针 | `pnpm pack` 的 Core/Runtime/Protocol/Relay Protocol/Client Node/Companion 组成临时应用；Node `--no-experimental-strip-types` 加载公开配置 API、绑定 schedule capture、运行 `agent health` 与参数 help 均通过 |
| Changesets status | Core 1.3.0 → 1.4.0、Runtime 1.2.0 → 1.3.0；没有执行 version/publish |
| GitNexus | 在临时 Git index 纳入新增文件，不改真实 index；完整 detect_changes 的 partial/truncated 均为 false。静态风险因共享配置和 Store 入口列为 critical，非已确认 Critical 缺陷；结合源码与上述真实执行检查 |

真实执行使用临时 HOME、独立配置/账本/历史、127.0.0.1 HTTP provider 和 fixture MCP Agent。provider 实际返回工具调用，Shell 实际执行 `pwd`，MCP 实际读取 B 的环境；断言后续模型请求中的工具结果、持久化历史位置与账本终态。没有使用用户凭证、真实浏览器 profile 或外部付费模型，也没有安装 OS service。

主要假设均已被执行证据反驳：任务目录配置能覆盖显式来源；daemon 重启丢失绑定；不同绑定合并为同一任务；确认期间配置变化被忽略；损坏来源退回 legacy；旧 writer 升级后仍能写入。对这些结论的范围分别限于对应回归和本地进程执行。

## Unverified coverage

- Applicable checks not run：远端 CI、Windows/Linux 原生执行、launchd/schtasks 安装/升级与新 standalone/Electron bundle 分发。尚未创建 PR 或发布，因此不能声称这些环境已通过。
- Untraced callers/integration/orchestration paths：另一个 Electron 项目的 Main/renderer 与 bundled artifact 接入未在此任务端到端运行。GitNexus 索引的全局 flow 提取存在 entry/branch 截断，detect_changes 本身完整不表示全仓库调用图穷尽；本轮相关动态调用另外沿源码和真实子进程验证。
- Non-applicable protocols/major sections：没有新增 HTTP/IPC endpoint、账户/租户、签名/支付或 UI rendering 逻辑；对应安全协议 N/A。本轮不改变时间计算/TTL/重试算法，既有 calendar/claim/timeout 回归仍执行。原生平台验证是 unverified，非 N/A。

## What looks strong

- 绑定跨对话、持久化和子进程边界一致，且旧任务兼容通过真实执行证明。
- Core/Runtime 职责保持清晰，公开类型由 schema 派生，避免完整配置反向流入 Runtime。
- 成功和失败都验证了产物与账本后置条件，而非只检查参数透传或退出码。

## Residual risks / follow-ups

后续 PR 应运行跨平台 CI；Electron 任务需使用本次公开 helper/flags 的新构建做集成验证。打包探针复用本地已安装第三方依赖，未模拟全新机器下载 standalone；其结论只覆盖发布导出与本地构建产物。升级前按现有运维流程重启旧 scheduler，schema writer fence 会拒绝旧连接继续写入。

## PR CI 跟进中的修复

- Windows 启动 smoke 使用 `file://` URL 传递 ESM preload，并在临时根目录加入空格；失败诊断保留 Runtime stderr。
- CI 暴露已有的首次建库竞态：一个宿主创建 `threads.db` 后、schema 提交前，另一个宿主将 v0 误判为旧库。受控 Worker 在该窗口暂停，修改前稳定失败；修复后等待第一个初始化提交再预检。既存 v0 内容仍拒绝隐式迁移且字节不变，当前库的活跃同级会话仍能保持占用。
- 修复复用 Runtime 的 occupancy SQLite；预检与初始化持有同一写门禁，SQL busy timeout 保持 15 秒。显式 maintenance 与 session claim 的既有排他语义保留，OS 探活仅在事务外进行，没有新增 Core 依赖、数据库版本、自动迁移或接管。
- 相关 ownership/lifecycle/初始化回归 25 项通过。Core/Runtime 完整单测及真实 CLI E2E 另行复跑；远端最终状态以 PR #309 的当前 HEAD checks 为准。
- Windows 重跑另暴露 `/show-think` 测试在草稿未提交渲染时发送 Enter 的时序依赖。测试改为等待实际草稿渲染，保留原输出断言和超时。

首次初始化门禁的释放在异常和正常路径均幂等执行。对存量旧库的预检失败会回滚 occupancy 事务、关闭连接，不修改历史；新库初始化事务仍由 ThreadStore 负责，跨包职责保持不变。
