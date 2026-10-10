# ChatGPT 订阅最小接入验证记录

验证环境：2026-10-10，macOS，Node 24.21.0，pnpm 11.24.0；独立 worktree 基于 `344750ab`。
实现方案见 [保存的方案](../plans/2026-10-10-chatgpt-subscription.md)，使用说明见 [订阅聊天指南](../how-to-use-chatgpt-subscription.md)。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| Core 全量测试 | 1910 通过，0 失败，5 跳过（Review 修复后重跑） |
| Runtime 全量测试 | 1519 通过，0 失败，17 跳过 |
| Core 和 Runtime 类型检查 | 通过，Core 包括 React UI |
| Lint | 通过 |
| Core 发布构建和 React UI 构建 | 通过 |
| 发布态 CLI | auth/chat 帮助、共享账户状态、agent health 可执行；未残留懒加载 .ts 错误 |
| Core E2E | 73 通过，0 失败 |
| 冻结依赖安装 | 通过；新增依赖仅 Core 的 jose 6.2.2 |
| 格式检查 | 修改的源代码和文档全部通过；生成锁文件的格式警告在基线亦可复现，保留 pnpm 输出 |
| Changeset | Core patch；changeset status 校验通过 |

新增测试覆盖 OAuth PKCE/state/nonce、JWT 签名/issuer/audience/exp、拒绝/取消/超时和畸形回调、注册隔离、目录文件权限及原子保存、并发续期/终态失效/临时网络失败、撤销不确认、模型目录、账号解析和固定账号、订阅模型目录隔离、请求参数/工具 namespace、生成流聚合、结构化压缩、取消/不完整流，以及 UI session/Origin/CSRF 与脱敏公开响应。

## 真实账户验收

由用户在系统浏览器完成 OpenAI 登录及订阅用量授权。调用模型为账号目录返回的 `gpt-6.1-sol`，共获取 7 个模型，真实上下文窗口为 272000。测试仅使用 `/tmp/roll-chatgpt-live-validation` 内的临时配置、会话和随机文件；未读取业务文件。

| 项目 | 结果与证据 |
| --- | --- |
| 登录 | 通过。CLI、发布态 CLI 与真实 Chrome 配置台共享同一个有效注册，均显示订阅已授权；公开 UI status/models 响应不含 OAuth token；凭证目录 0700、文件 0600 |
| 模型列表 | 通过。真实账户返回 7 个订阅模型，显示 display_name，实际调用 slug `gpt-6.1-sol`；账号切换目录、配置预览及保存另有 Chrome 隔离夹具验证 |
| 多轮及恢复 | 通过。三次独立 CLI 进程恢复同一会话，正确记住随机信息 `ROLL-MEM-8f20c93da7`；中间计算结果 42 正确 |
| 本地工具 | 通过。实际调用 `roll.read_file` 读取临时随机测试文件，输出与文件中 `ROLL-TOOL-d9e20081752bde33cb1158f5` 完全一致，有工具执行记录 |
| token 刷新 | 通过。遵守 earliest_refresh_at（03:57:28 UTC），于 03:57:31 UTC 持久化轮换后的凭证。access / refresh token 均替换，同一模型实例继续调用返回 `ROLL-REFRESH-AFTER`；证据仅保存布尔值及时间，未保存 token |

额外验收：

- 真实 `/compact` 使用流式结构化摘要，移除 6 条消息、保留 4 条；压缩后的聊天仍正确返回上述随机信息。
- 临时 `sampling-proof-agent.sampling_proof` 实际通过 MCP `createMessage` 借用当前订阅模型，返回 `ROLL-SAMPLING-7a84c91e`，有工具执行记录。
- `maxOutputTokens` 在 Sampling 和压缩中明确警告不支持服务端硬上限；超时和取消仍由 Roll 控制。
- 真实测试 JSON/stderr 文件扫描未发现 access_token/refresh_token/id_token 或对应 camelCase 字段；未保存或展示 token 值。

## 影响和边界

开工前保存方案并刷新落后索引；共享模型解析影响为 HIGH。随后 worktree 建立独立 GitNexus 索引，对新增认证和适配器、UI 路由、模型解析执行影响分析；Review 后完整 all diff 变更分析覆盖 54 个文件、499 个图符号、43 条执行流程，评级 CRITICAL，未返回 partial/truncated。增量索引曾出现 symbol UID 错误关联；全量 --force 重建后 context 和变更流程关联恢复正常。索引仍提示全仓执行流程存在预算裁剪，不将未发现流程视为无影响。图风险表示共享入口影响范围，需要结合代码和回归验证，不能视作缺陷判定。

按用户 Review 后扩展范围，支持普通 `roll chat`（含单次调用、恢复、Sampling 和压缩）及 scheduler。旧 chat --server、Runtime 服务、Companion 暂不支持订阅；保存共用默认配置前明确提示。`roll ask` 使用独立的 `llm.defaultProvider`，不受聊天订阅配置误拦截。不支持入口、授权或额度错误不自动改走付费 API Key。认证和凭证只存在 Core，本次未改 Runtime 引擎或数据库格式。

未发布、未 push、未合并；原工作区未修改。五项真实验收现已全部通过，另有真实压缩、Sampling 及订阅 scheduler 验证。

## UI 细节调整（2026-10-10）

按用户反馈调整订阅卡片，继续复用配置台字体、颜色、圆角、按钮和原生 select 控件。收紧嵌入式卡片标题、替换亮色外框为现有面板边框；宽屏并排展示账号与模型，窄容器自动改单列；去掉重复注册 ID 和模型 slug，将低频重新授权、凭证刷新、退出及有效期收进“账号管理”。保留显式登录入口、授权状态、配置审阅／保存提示、取消登录和错误反馈，加载期间不会闪现未登录 CTA。

此次修改仅涉及 ChatGptAccountPanel.tsx 与局部 CSS；组件上游影响为 LOW（App → main.tsx），无服务端／凭证流程修改。Core／React 类型检查、相关 ESLint／格式检查、Vite 发布构建与 UI 78 项测试通过。Chrome 隔离配置验证：账号／模型切换和目录更新、三项配置预览／保存、管理区折叠、刷新反馈、登录轮询／取消及退出后的登录入口均通过；390px 窗口单列布局、面板和页面均无横向溢出，1000px 窗口并排布局正常。真实账号页面已刷新展示新设计，未通过 UI 刷新、退出或重新授权真实账户。

## Review 修复与新增验收（2026-10-10）

优先修复推理参数、API Key ask 回归、聊天启动阻塞和默认配置影响。用户明确要求扩展 scheduler：复用 Core 认证和 Responses，保留 Runtime 原有无人值守审批、任务时限、取消、线程持久化与 authority 校验。

- 推理档位：Roll 通用档位保留，各 Provider 独立映射。订阅 `off` 对应 `none`，但需账号模型目录声明支持。真实 `gpt-6.1-sol` 拒绝 `none`；其目录提供 low/medium/high/xhigh/max 等档位，因此补充目录能力解析及初始化校验。不支持 `off` 时明确提示使用 low，聊天调整失败保持原档位；聊天与压缩配置均预先校验。发布态 CLI 在隔离配置中分别设置聊天 off 与压缩 off，均在初始化退出并显示能力提示。自动化覆盖映射请求体、目录能力、压缩及交互失败后状态。
- scheduler：发布态 `schedule add` → `run-now --inline` 启动真实独立 executor，以 `gpt-6.1-sol` / low 完成任务。调用 `roll.read_file` 读取隔离文件，工具结果与最终输出均为 `ROLL-SCHEDULE-2d847e9a`；invocation `02bca004-dc5b-41dd-a56d-2009c84af053` 状态 completed，线程 `f185c38b-266a-404e-bebd-d4b16181eb64` 保留实际 tool_executions 记录。未配置付费 API Key。测试任务已删除，未启动用户 scheduler daemon。
- API Key 聊天：初始化不读取订阅认证或目录；仅打开 `/model` 时异步加载，加载可取消，过期结果不会重新打开弹窗。交互 CLI 子进程回归将 OAuth 服务设为抛错、隔离全部网络，仍正常到达输入框并退出。
- ask：只检查其实际使用的 `llm.defaultProvider`，新增真实 CLI 子进程回归，runtime.provider=chatgpt 时仍到达 API Key ask 路径。
- 配置台：单选账号不改 provider / model；订阅模型保存前在面板和预览明确提示共用默认值，以及 Runtime / Companion 的剩余边界。Chrome 验证账号单选只产生 account 字段 diff，模型选择产生完整三项 diff；视觉截图 `/tmp/roll-chatgpt-review-ui.png`。诊断使用“暂不支持”，不再误报“配置不完整”。
- 额外修复：自动续期临时失败时只复用尚未到期且未被撤销的最新凭证；temperature/topP 明确警告；发送 Bearer 前限定 Responses origin/path，禁止 HTTP 重定向。

Review 后重跑 Core 全量测试、Core/React 和 Runtime 类型检查、lint、Core/UI 发布构建、73 项 E2E，均通过。发布态 auth 帮助与隔离配置下 agent health 通过。Runtime 全量测试使用本次功能的先前结果，Review 未改 Runtime 源码。本次未运行完整 monorepo 测试或发布供应链全套检查。

低优先级的无桌面登录 URL、孤儿注册管理、损坏文件隔离、账号 ID 友好校验、不同 API provider 的模型回退及上游 HTTP 状态映射仍待后续处理；未宣称修复全部低优先级建议。Changeset 按用户原方案保留 Core patch。
