# Core / Runtime 反向引用迁移表

状态：M01–M16 已实现，功能与包独立性检查通过。验收范围为解耦稳定性和功能完整性；长性能测量未完成，不宣称全面性能不退化。下方保留改造前引用表用于追溯，当前实现与证据见“实施结果”。

基线：2026-10-26，`dev@6264c34a190c30189f7718a94f0a4ce22b4ad112`。下方原始行号与统计只适用于该提交；开工时已用 AST 重新核对反向引用，原始引用清单保留在本文附录中。

## 实施结果

当前依赖方向为 `Core → Runtime → Protocol / 第三方基础库`。Runtime 的 Core devDependency 已移除；本次验收确认源码、测试、发布 `.js/.d.ts` 与包图的反向引用均为零。公共 API 迁移见 [Runtime 宿主 API 迁移](runtime-core-api-migration.md)，验收结果见本文清单。

| 迁移项  | 实现位置与结果                                                                                                                          | 验证证据                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| M01     | Runtime `host-contracts/runtime-settings.ts` 定义执行设置；Core `runtime-host/engine-factory.ts` 显式映射，凭证和宿主配置不进入 Runtime | Core `runtime-settings.test.ts` 验证默认值及自定义字段等价                            |
| M02     | Engine 必需注入模型与标识；Core API Key / ChatGPT 接线提供 Provider options、schema 策略及恢复能力                                      | 原有恢复、摘要、切模型测试；Runtime `engine-host.test.ts` 验证切换与 Sampling 一致性  |
| M03–M05 | Runtime `AgentHost` 端口；Core `runtime-host/agent-host.ts` 持有注册、进程、租约与 scoped MCP acquisition                               | Core MCP / Host 生命周期测试、迁后的 30 项宿主集成测试；Runtime 44 项原纯引擎测试保留 |
| M06     | Core Host 发现目录与安装；Runtime 分别记录安装事实和刷新结果，关闭等待已开始的副作用结算                                                | 安装成功但刷新失败、取消后迟到结果、幂等关闭和清理失败回归                            |
| M07–M08 | Core Host 规范化工具与扫描 Skills；Runtime 消费快照，不隐式扫描目录                                                                     | Core App output / 工具发现集成，Skills 告警与 Runtime 无宿主测试                      |
| M09–M10 | Runtime `/skills` 统一读取契约、来源常量和前缀解析；Core 旧出口转接同一实现                                                             | Skills 前缀、快照、持久化与叶子加载测试                                               |
| M11–M15 | Runtime `/tool-contracts` 统一 schema、preflight、超时、结果与执行元信息；Core 使用同一实现                                             | ask/run 接线及相关纯逻辑回归；源码和 dist 叶子加载探针                                |
| M16     | Runtime `/host-contracts` 定义完整调度端口，Core binding 实现；账本和状态机未改                                                         | Runtime 端口测试、Core 日历/Provider 集成及 scheduler 全量回归                        |

三个叶子出口均配置源码与发布路径，导入不加载 Engine、Session、Store 或 SQLite。仓库外 tarball 消费已验证类型、工具调用、SQLite 重开和资源退出。`skipLibCheck: false` 下的 20 个既有 AI SDK 声明错误与独立 Provider 控制程序相同；标准仓库类型检查通过。

## 目标与统计口径

目标依赖方向为 `Core → Runtime → Protocol / 第三方基础库`。Core 提供具体宿主能力；Runtime 定义消费接口并负责会话执行、审批、恢复和持久化。Runtime 的源码、测试、类型声明和依赖树最终均不反向依赖 Core。

| 项目                                  |                                        基线结果 |
| ------------------------------------- | ----------------------------------------------: |
| 直接引用 Core 的 Runtime 生产源码文件 |                                              14 |
| 包含值导入或值再导出的生产文件        |                                               8 |
| 生产静态引用语句                      |         38：22 条值导入/再导出，16 条纯类型导入 |
| 被引用的 Core 模块子路径              |                                              20 |
| 直接引用 Core 的 Runtime 测试文件     |                                              18 |
| 测试静态引用语句                      |                                              23 |
| 测试中的其他引用                      | 1 处动态 `import()`，1 处 `import()` 类型表达式 |

统计通过 TypeScript AST 区分类型和值引用；混合导入算值引用，每个语句只计一次，包含 `export ... from`。补充扫描动态导入、导入类型表达式及跨目录相对路径；基线生产源码未发现额外的动态/类型表达式引用或相对路径绕行。

Core 在 `packages/core/package.json:133` 声明 Runtime 为生产依赖；Runtime 在 `packages/runtime/package.json:51` 将 Core 声明为开发依赖。生产值引用证明后者不能仅按测试依赖处理。

原计划时 GitNexus 仓库 `roll-agent` 索引停留在 `25645f43`，落后基线 4 个提交并有未完成重建状态。实施时已刷新至基线 HEAD；`ConversationEngine` 与 MCP 边界仍按 **CRITICAL** 风险处理，UNKNOWN 项逐一核对实际调用点。图谱存在流程抽取预算和动态引用解析限制，调用者数量不作为行为正确性的证明。

## 归属原则

- **Core 保留宿主实现**：配置发现与解析、凭证与登录、Provider 工厂、MCP 连接、Agent 注册/安装/进程管理、Skills 文件发现与读取、scheduler 服务接线。
- **Runtime 保留执行语义**：模型调用与切换的会话一致性、整轮预算、工具执行/审批、Skills 上下文、输入与工具事实持久化、压缩和恢复、scheduler 账本。
- **接口由 Runtime 定义**：宿主适配器满足这些接口。Core 将全局配置映射为 Runtime 所需的有限配置；接口不携带 Core 的完整配置、注册对象或具体管理器类。
- **共享纯逻辑保留单一实现**：本表优先建议放进 Runtime 的独立叶子模块，Core 通过明确的子路径使用。具体出口命名在实施时确定；叶子模块不导入 Runtime 根入口，不触发 Engine/Store 初始化。
- **Protocol 保持跨进程契约职责**：已公开的 App output、事件等契约继续复用；进程内宿主接口、配置解析和工具算法不为消除循环而全部搬进 Protocol。当前清单不要求新建公共包。
- Runtime 仍可依赖 AI SDK、MCP 的中立类型以及已有文件工具、SQLite、shell 执行能力。此次范围是消除 Core 反向依赖，不要求把 Runtime 改成无 I/O 或浏览器运行的库。

## A. 宿主能力迁移表

表中“位置”为 `packages/runtime/src/` 下的基线位置。新增接口和模块位置均为建议；现有函数名表示当前证据。

| ID  | 当前 Core 引用与 Runtime 位置                                                                                                                                                                                                               | 当前用途                                                                       | 建议归属与迁移方式                                                                                                                                                                                                         | 关键验收                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| M01 | `config/schema` 的 `RollConfig`；`config/helpers` 的 `getAgentEnv`。`engine/conversation-engine.ts:39,45`                                                                                                                                   | 引擎直接读取 runtime、chat、llm、agents、install、skills 配置，解析 Agent 环境 | 配置加载、凭证、Agent 环境映射留 Core。Runtime 定义有限的运行设置；Core Host 在创建引擎前完成映射。shell/compaction/deadline/context window 等执行参数传入 Runtime；`agents.dataDir`、安装源和 Provider 密钥留在适配器内部 | 默认值、环境覆盖、工作区指令设置保持一致；Runtime 公开 API 和 `.d.ts` 不再出现 `RollConfig`；独立实例不读取真实 Core 配置或凭证          |
| M02 | `llm/providers` 的 `createProviderModel`、`providerAcceptsToolSchemaIssues`。`engine/conversation-engine.ts:18`                                                                                                                             | 未注入模型时创建实例；按 Provider 判断工具 schema 是否可用                     | Provider 创建与差异适配留 Core；Runtime 接收模型实例、模型能力及工具 schema 接受策略。移除 `resolveModel()` 对 Core 的默认回退。首次创建、模型切换、摘要请求与 MCP Sampling 的接线均遵循此边界                             | 注入模型后无需 Core；缺少必需模型明确失败；切换后模型、Provider options、schema 策略和 Sampling 一致更新；上下文预算与摘要策略保持原行为 |
| M03 | `mcp/client-manager` 的 `McpClientManager`、`McpConnectionAcquisition`。`engine/conversation-engine.ts:14`                                                                                                                                  | 构造时默认 new 管理器；连接、列工具、Sampling 更新、失败回滚、退出断连         | Core 适配器拥有连接实现；Runtime 消费工具来源、调用和生命周期契约，不接收具体 Core 管理器类。连接获取的 commit/rollback 语义由适配器实现；共享资源和引擎专有资源显式区分                                                   | 连接超时/取消无泄漏；新连接失败不影响旧连接；一个引擎关闭不误断其他引擎共享连接；Sampling 切换与已有功能一致                             |
| M04 | `registry/store` 的 `AgentStore`，以及完整 `RegisteredAgent`。`engine/conversation-engine.ts:22,46`                                                                                                                                         | 初始化/刷新时读取注册表，向会话生成工具来源和 Agent 元信息                     | 注册表与完整注册对象留 Core；Host 提供规范化的工具来源、能力快照和刷新能力。Runtime 仅保留路由、审批、资源协调所需的元信息，见 M15                                                                                         | 发现顺序、部分 Agent 失败、刷新和现有会话的工具快照行为保持一致；Runtime 不访问 Core 注册文件；动态安装后的工具可用性保留                |
| M05 | `registry/dev-spawn`；`registry/process-manager`；`registry/agent-usage-lease`。`engine/conversation-engine.ts:23,24,29`                                                                                                                    | 开发态 spawn 回退、启动/探活、使用租约、退出识别和释放                         | 全部具体机制留 Core，合并到 Agent 接入适配器。Runtime 接收可取消的接入结果和受限释放能力；引擎会话/整轮预算仍由 Runtime 管理，Core 遵守传入的 signal/deadline                                                              | local-path/git 开发回退、外部服务不被误停、已启动服务复用、共享租约、超时回滚和并发 dispose 都有回归；清理失败不能伪装成已释放           |
| M06 | `registry/catalog` 的 `catalogPackageSpec`、`getAgentCatalog`、`AgentCatalogEntry`；`registry/catalog-discovery` 的 `resolveAgentCatalog`；`registry/install` 的 `installAgent`、`InstallAgentEvent`。`engine/conversation-engine.ts:40–44` | 目录发现、安装参数组装、进度格式化、安装后刷新                                 | 安装/目录发现留 Core；Runtime 定义用于会话的安装能力契约，接收可用目录摘要、进度和结果。会话是否允许安装、工具审批和状态协调仍在 Runtime；不把审批门移动到安装函数内                                                       | 保持 `allowNetwork: false` 的既有启动发现行为、宿主模式限制、用户确认、环境缺失提示、取消、失败和安装后刷新；未知执行结果不自动重复安装  |
| M07 | `cli/utils/agent-tools` 的 `normalizeListedTools`、`formatToolSchemaIssue`、`formatAppOutputDiscoveryIssue`。`engine/conversation-engine.ts:34`                                                                                             | MCP 工具发现时规范化 schema/App output/超时元信息并报告问题                    | MCP wire 发现与日志格式化留 Core，适配器向 Runtime 提供规范化工具。通用 schema 校验复用 M11–M13；App output 契约复用 Protocol。迁出发现流程时同时保留资源提示、观察 retention 和工具 annotations 的投影                    | `roll ask/run/chat` 对 schema、超时和 App output 的判断一致；坏声明继续报告；资源路径基准、hint 缺失时的保守锁和 retention 行为不丢失    |
| M08 | `skills/library` 的 `createSkillLibrary`。`engine/conversation-engine.ts:47`                                                                                                                                                                | 默认扫描项目、用户、Agent 和配置目录                                           | 发现、优先级、文件读取与告警留 Core；Core 实现 M09 的 Skills 读取接口后注入。Runtime 未收到该可选能力时按约定关闭 Skills，不隐式扫描用户目录                                                                               | agent > project > user > config 优先级及 malformed/重名/读取失败告警不变；普通 chat 与 server 均有告警；测试不接触真实用户目录           |

## B. 契约与共享纯逻辑迁移表

| ID  | 当前 Core 引用与 Runtime 位置                                                                                                                                                                                             | 当前用途                                                      | 建议归属与迁移方式                                                                                                                                                                                                                     | 关键验收                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M09 | `skills/library` 的 `SkillLibrary`、`SkillSummary`、`SKILL_SOURCES`、`SKILL_TOOL_ID`。涉及 `agent-session`、`capability-manifest`、`compaction-checkpoint`、`conversation-engine`、`explicit-skill-context`、`skill-tool` | Skills 读取契约、能力目录、checkpoint 校验和内建工具标识      | 读取契约和纯数据定义归 Runtime 的 Skills 叶子模块；`SKILL_TOOL_ID` 归 Runtime 工具定义。Core 的发现实现使用同一份契约/常量；检查 `LoadedSkill`、reference 文档结果等传递类型，不能仍指回 Core                                          | 保留来源字面值和旧 checkpoint 可读性、渐进加载、手动 Skill 预加载、reference 路径约束；声明文件无 Core 引用                                                              |
| M10 | `skills/invocation` 的 `parseSkillInvocationResult`、`SKILL_INVOCATION_PARSE_KINDS`、`SkillInvocationSummary`。`engine/explicit-skill-context.ts:6`、`store/turn-input.ts:3`                                              | 解析显式 Skill 前缀、恢复持久化输入中的 Skill 上下文          | 纯解析器与返回契约归 Runtime 的 Skills 叶子模块；Core slash UI/REPL 使用同一实现。宿主命令派发仍由 Core 负责；持久化只存所需输入/快照                                                                                                  | 多 Skill、大小写、去重、未知 Skill、前导空白和普通 slash 命令边界一致；历史保留原输入；同轮重放复用快照；重启恢复不重新扫描用户目录                                      |
| M11 | `tool-runtime/json-schema-refs` 的 `inlineAcyclicLocalJsonSchemaReferences`、`JsonSchemaRefIssue`。`engine/agent-session.ts:40`、`tool-bridge/build-tools.ts:2`                                                           | 内联可解析的本地 schema 引用，报告不能内联的情况              | 算法、原因常量和问题类型归 Runtime 工具 schema 叶子模块，Core 发现/提参复用。Provider 能否接受问题仍由 M02 的适配策略决定                                                                                                              | 本地、递归、外部、悬空引用、兄弟关键字和展开上限均有原语义回归；不以降级原始 inputSchema 类型来消除错误                                                                  |
| M12 | `tool-runtime/preflight` 的 `preflightToolCall`。`tool-bridge/build-tools.ts:12`、`tool-bridge/tool-approval-continuation.ts:2`                                                                                           | 执行前输入校验，审批续执行前再次校验                          | 通用校验归 Runtime 工具校验叶子模块，Core ask/run 复用。连带整理 `schema.ts`、最小 schema 类型、`AskValidationIssue`/`AskRuntimeIssue` 中实际需要的中立问题契约；ask 命令结果和路由类型留 Core，环境检测由 Core 提供结果               | 保持 `requires_explicit_input`、required、enum、类型/数组/对象边界和 runtime issue 结果；审批续执行仍校验，不能因迁移扩大可执行输入                                      |
| M13 | `tool-runtime/execution-timeout` 的 `readExecutionTimeoutMs`、`ROLL_EXECUTION_TIMEOUT_META_KEY`。`tool-bridge/build-tools.ts:13,41`                                                                                       | 读取工具声明的 deadline，并从 Runtime 再导出                  | 常量及解析器归 Runtime 工具元数据叶子模块；Core 发现/执行入口使用同一实现。保留必要的旧 Core 导出转接；Runtime 不再经 Core 再导出                                                                                                      | 保持有限整数 1,000–1,800,000 ms 边界、无效值回退及工具 deadline 与整轮 deadline 的关系；已有 Runtime 导出行为保持可用                                                    |
| M14 | `cli/utils/tool-results` 的 `extractTextContent`、`isToolErrorResult`。`tool-bridge/normalize-result.ts:4`                                                                                                                | 提取模型可用文本、区分真实 Tool 错误和已完成 App output       | 两个纯函数归 Runtime 工具结果叶子模块；Core CLI 复用。CLI JSON 输出格式化继续归 Core；已有 App output 状态契约继续复用 Protocol                                                                                                        | 保留 `raw/model/display` 分离、内容截断与 App output 完成状态语义；不把业务已完成输出误记成 Tool 失败                                                                    |
| M15 | `types/agent` 的 `AgentTool`、`RegisteredAgent`、`AgentSourceType`、`AgentRuntimeOwnership`、`AgentTransport`。涉及 `conversation-engine`、`capability-manifest`、`naming`、`build-tools`、`tool-approval-continuation`   | 传入工具 schema、路由来源/传输/ownership 元数据及完整注册对象 | 工具描述与执行所需元信息归 Runtime 契约；完整注册、安装路径与启动配置留 Core。来源/传输/ownership 的必要字面值共用单一常量定义；`AgentTransport['type']` 改为独立传输种类契约，避免连带引入 command/endpoint。Core 映射为 Runtime 输入 | 类型从常量/schema 派生，不复制两套 union；App output、schema issues、executionTimeoutMs 字段保留；`resourceBaseDir` 等执行必要信息仍显式提供；测试替身无需强转为 Core 类 |
| M16 | `scheduler-host/schedule-tool-binding` 的 `ScheduleToolPort`、Create/Extend Request/Admission、Readiness、Error 等。`conversation-engine.ts:48`，以及 `schedule-create-input`、`schedule-tool`、`schedule-extend-tool`    | 会话内建调度工具调用 Core binding、审批前捕获条件、审批后执行 | 进程内工具端口和配套输入/结果/准入快照契约归 Runtime；Core binding 实现它们。Store、trigger、claim/lease 仍归 Runtime；daemon/service/配置检查仍归 Core。不因共享接口而新增 wire 协议                                                  | 保留 capture→确认→执行的快照/authority 校验、幂等 requestId、轮次数 CAS、时区/日历语义、服务 readiness 和迁移错误；保留进程未清时 fail-closed 的既有行为                 |

### 需要同时处理的间接依赖

| 起点            | 已核实的连带依赖                                                                                               | 处理约束                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| M12 preflight   | `tool-runtime/schema.ts` → `AgentTool`；`types/ask.ts` 同时引用 router 和 App output 类型                      | 只抽取通用 schema/问题契约，不将整个 ask/router 层迁入 Runtime                              |
| M09 Skills 契约 | `SkillLibrary` 方法返回 `LoadedSkill`、`LoadedSkillReference`，关联 `SkillSource`                              | 声明闭包一起检查；只迁接口名称仍可能在 `.d.ts` 留下 Core 路径                               |
| M16 调度端口    | Create/Extend 的 Admission、Outcome、Readiness、Schedule view 等互相引用，部分已引用 Runtime 的 scheduler 类型 | 抽出完整消费契约并复用已有 scheduler 类型；保留准入条件与配置变动校验，不能为了接口小而删除 |
| M15 工具契约    | `AgentTool` 包含 `JsonSchemaObject`、`JsonSchemaRefIssue` 和 Protocol 的 `AppOutputContract`                   | M11/M12/M15 一起定边界；Protocol 既有类型可继续使用                                         |
| 所有默认实现    | `ConversationEngine` 的可选参数回退至 Core，`installAgentFn`/`resolveCatalogFn` 甚至以 Core 函数类型描述       | 用 Runtime 所需契约替换；将便利工厂放 Core，Runtime 不保留隐式导入或全局注册回退            |

## C. 测试引用迁移表

下表的路径均相对于 `packages/runtime/src/`。同一文件可属于多个测试类别；生产迁移编号用于追踪关联，不代表删除测试。

| 当前测试文件                                                                                                                                             | Core 依赖                                                                                              | 迁移与保留要求                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/conversation-derived-context.test.ts`、`engine/conversation-fork.test.ts`、`server/runtime-server.test.ts`、`store/thread-store-summary.test.ts` | `rollConfigSchema`                                                                                     | 使用 Runtime 自己的最小配置 fixture；保留派生会话、fork、服务与存储语义断言。Core 配置映射另在 Core 测试（M01）                                               |
| `engine/conversation-engine.test.ts`                                                                                                                     | Core config、MCP manager、lease、RegisteredAgent；另有动态 `import('@roll-agent/core/registry/store')` | 拆分纯引擎用例与真实宿主接入用例；前者用 Runtime 端口替身，后者迁到 Core。保留连接回滚、关闭、租约与刷新验证，不用强制类型断言伪装具体 Core 类（M01–M06/M15） |
| `engine/explicit-skill-recovery.test.ts`、`engine/turn-input-engine.test.ts`                                                                             | Core config 和 Skills 类型                                                                             | Runtime fixture + 内存 Skills 实现，保留持久化、恢复和快照测试（M01/M09/M10）                                                                                 |
| `engine/agent-session.test.ts`                                                                                                                           | `SKILL_TOOL_ID`、Skills 类型；另有 `import('@roll-agent/core/skills/library').SkillLibrary` 类型表达式 | 改用 Runtime 契约，包含隐蔽的导入类型表达式；保留真实会话工具循环验证（M09）                                                                                  |
| `engine/explicit-skill-context.test.ts`、`engine/turn-input-failures.test.ts`、`engine/turn-input-persistence.test.ts`、`tool-bridge/skill-tool.test.ts` | Skills 类型                                                                                            | 使用迁后的 Runtime 类型/内存实现；不依赖真实项目或用户 Skills（M09/M10）                                                                                      |
| `tool-bridge/tool-approval-continuation.test.ts`                                                                                                         | `AgentTool`                                                                                            | 使用 Runtime 工具描述契约，保留批准/拒绝/取消/过期/重校验场景（M12/M15）                                                                                      |
| `tool-bridge/calendar-integration.test.ts`、`tool-bridge/schedule-tool.test.ts`、`tool-bridge/schedule-extend-tool.test.ts`                              | `createScheduleToolBinding` 的真实 Core 实现                                                           | 在 Runtime 留下端口契约与工具语义测试；真实 binding + Store/服务接线集成用例迁入 Core，不丢日历、准入与 extend 幂等/CAS 覆盖（M16）                           |
| `tool-bridge/schedule-create-input.test.ts`                                                                                                              | `createProviderModel`                                                                                  | schema/输入语义测试留 Runtime；当前模拟 fetch 的 OpenAI/DeepSeek wire 适配测试移到 Core，保留实际 Provider 适配链而不是全部替换成假模型（M02/M16）            |
| `service/app-output.integration.test.ts`                                                                                                                 | `normalizeListedTools`                                                                                 | Runtime 保留规范化工具输入后的服务/App output 契约测试；真实 Core 工具发现→Runtime 服务的集成链迁到 Core（M07/M14/M15）                                       |

移除测试中的反向引用后，才能移除 Runtime 的 Core devDependency。集成测试不以“测试专用”的理由重新挂回该依赖。

## D. 建议迁移顺序与完成条件

| 阶段                    | 迁移范围                                                               | 阶段完成条件                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 独立契约与纯逻辑     | M09–M16；先确定 M01 的 Runtime 配置输入                                | 单一实现与独立叶子出口成立；Core 可转接旧出口，Runtime 侧不再引用旧 Core 出口；无新的文件初始化环。每项同步迁移/补充对应测试          |
| 2. 模型与配置接线       | M01/M02                                                                | Core 完成 config→runtime settings 映射并提供模型/能力；Runtime 无 Provider 创建回退，model switch/Sampling/摘要请求和错误恢复回归通过 |
| 3. Agent 与 Skills 接线 | M03–M08                                                                | Host 提供发现、接入、安装和生命周期能力；Runtime 构造/执行/关闭无需 Core。保留动态刷新、租约和失败清理语义                            |
| 4. 所有入口与包边界收口 | 完成 C 中剩余测试拆分；package.json、lockfile、exports、构建与架构门禁 | Runtime 源码/测试/生成 `.js`/`.d.ts` 零 Core 引用；workspace 包图无直接或间接反向依赖；干净消费者验收通过                             |

阶段 1–3 期间 Core devDependency 可以暂留用于尚未迁移的代码；仅“没有新导入”不等于完成。接口变更需要同步所有入口，不能只迁 `createChatEngine` 一个调用点。跨包公共 API 变化及版本/Changeset 在实际实施时评估，本表不授权发布。

### 每项必须保留的生命周期约定

- 谁创建连接/租约、是否共享、谁 commit/rollback、谁释放，要在端口契约中明确；不能把 Core manager 原样套一层接口后继续让引擎任意关闭全局资源。
- Runtime 决定整轮 deadline/maxSteps、恢复准入、输入与工具事实；Core 适配器报告服务相关事实并完成连接/凭证准备。已存在的 `ModelTurnRecovery` / `createChatGptTurnRecovery` 是可复用的边界，不需要为本次迁移另造一套恢复机制。
- 取消应停止可取消的等待；已经派发的旋转令牌交换仍须遵守现有有界完成/落盘约定。迁移不改变认证、工具副作用和资源释放的安全语义。

### 最终验收清单

以下记录本次实施与复核时已完成的验收。本次提交包含解耦实现和包内回归测试，不包含临时报告、一次性包独立性验收脚本、对应新增 CI 接线或性能测量工具。这些历史验收结果不表示后续 CI 会自动运行独立消费者检查。

- [x] 静态扫描覆盖 import、export-from、动态 import、import 类型表达式、require、相对路径、别名/生成文件；Runtime 到 Core 的引用为零。
- [x] 对 workspace 全部包的 dependencies/devDependencies/peerDependencies/optionalDependencies 建图；没有经第三包绕行回 Core 的循环，Runtime 不以 peerDependency 继续要求 Core。
- [x] Runtime 在不安装 Core 的隔离环境中完成自身 typecheck/test/build；避免 workspace symlink、根 node_modules、tsconfig paths 或 NODE_PATH 掩盖依赖缺失。
- [x] 构建并打包后，在仓库之外仅安装 Runtime 及其声明依赖的临时消费者中，检查公开入口、子路径和 `.d.ts`，执行假模型会话、工具调用、SQLite 关闭重开及退出。确认依赖树未间接拉入 Core；既有第三方声明错误已完成独立控制对照。
- [x] Core 的普通 chat、基础 REPL、one-shot/JSON、Runtime 服务、UI/Companion、调度入口完成相关集成回归；已有功能限制继续显式保留，不把本次迁移当成新增支持。
- [x] 覆盖断网恢复、自动续期、取消/超时/切模型、输入保留、工具已完成不重放、Skills 前缀/快照、压缩及旧会话读取、审批确认后输入继续使用。
- [x] 调度的 claim/lease、准入快照、requestId/CAS、清理失败保持占用等既有边界不变。
- [x] Protocol / client-node / Companion / Relay 的既有序列化、投影和兼容测试通过。此次目标不要求改变 wire；如发现确有必要，单独设计版本协商与兼容。
- [x] Core build 后的 CLI 懒加载 smoke（含 `agent health`）通过；发布检查覆盖新增 exports/tarball，避免开发源码可用但发布包缺文件。
- [x] 实现复核时的 GitNexus change analysis 已在刷新后的索引上分批完成，各批次均未截断；typecheck、lint、单测与 E2E 通过。静态图仍有流程抽取限制，后续提交前应按最终改动范围重新核对。
- [x] 按用户调整后的范围完成生命周期稳定性与固定工作量核对：真实 MCP 两版本各 100 轮、各 300 个引擎/子进程，资源清理和自然退出通过。长 A/A、A/B 与持续内存矩阵已停止，未完成定量验收；本次不宣称全面性能不退化。

## 附录：生产引用逐项对照

以下每行对应一条静态导入或再导出语句；位置相对于 `packages/runtime/src/`。`值` 包括混合类型导入和再导出。

<!-- reverse-import-inventory:start -->

| #   | Runtime 位置                                  | 类型 | Core 模块                              | 导入/再导出符号                                                                            | 迁移项  |
| --- | --------------------------------------------- | ---- | -------------------------------------- | ------------------------------------------------------------------------------------------ | ------- |
| 1   | `engine/agent-session.ts:39`                  | 类型 | `skills/library`                       | `SkillLibrary, SkillSummary`                                                               | M09     |
| 2   | `engine/agent-session.ts:40`                  | 类型 | `tool-runtime/json-schema-refs`        | `JsonSchemaRefIssue`                                                                       | M11     |
| 3   | `engine/capability-manifest.ts:4`             | 类型 | `skills/library`                       | `SkillSummary`                                                                             | M09     |
| 4   | `engine/capability-manifest.ts:5`             | 类型 | `types/agent`                          | `AgentRuntimeOwnership, AgentSourceType, AgentTransport`                                   | M15     |
| 5   | `engine/compaction-checkpoint.ts:7`           | 值   | `skills/library`                       | `SKILL_SOURCES`                                                                            | M09     |
| 6   | `engine/conversation-engine.ts:14`            | 值   | `mcp/client-manager`                   | `McpClientManager, type McpConnectionAcquisition`                                          | M03     |
| 7   | `engine/conversation-engine.ts:18`            | 值   | `llm/providers`                        | `createProviderModel, providerAcceptsToolSchemaIssues`                                     | M02     |
| 8   | `engine/conversation-engine.ts:22`            | 值   | `registry/store`                       | `AgentStore`                                                                               | M04     |
| 9   | `engine/conversation-engine.ts:23`            | 值   | `registry/dev-spawn`                   | `resolveTransportWithDevSpawnSpec`                                                         | M05     |
| 10  | `engine/conversation-engine.ts:24`            | 值   | `registry/process-manager`             | `getAgentPid, startAgent, waitForAgentReady`                                               | M05     |
| 11  | `engine/conversation-engine.ts:29`            | 值   | `registry/agent-usage-lease`           | `acquireAgentUsageLease, getExitedAgentUsageNames, type AgentUsageLease`                   | M05     |
| 12  | `engine/conversation-engine.ts:34`            | 值   | `cli/utils/agent-tools`                | `formatToolSchemaIssue, formatAppOutputDiscoveryIssue, normalizeListedTools`               | M07     |
| 13  | `engine/conversation-engine.ts:39`            | 值   | `config/helpers`                       | `getAgentEnv`                                                                              | M01     |
| 14  | `engine/conversation-engine.ts:40`            | 值   | `registry/catalog`                     | `catalogPackageSpec, getAgentCatalog`                                                      | M06     |
| 15  | `engine/conversation-engine.ts:41`            | 值   | `registry/catalog-discovery`           | `resolveAgentCatalog`                                                                      | M06     |
| 16  | `engine/conversation-engine.ts:42`            | 值   | `registry/install`                     | `installAgent`                                                                             | M06     |
| 17  | `engine/conversation-engine.ts:43`            | 类型 | `registry/catalog`                     | `AgentCatalogEntry`                                                                        | M06     |
| 18  | `engine/conversation-engine.ts:44`            | 类型 | `registry/install`                     | `InstallAgentEvent`                                                                        | M06     |
| 19  | `engine/conversation-engine.ts:45`            | 类型 | `config/schema`                        | `RollConfig`                                                                               | M01     |
| 20  | `engine/conversation-engine.ts:46`            | 类型 | `types/agent`                          | `RegisteredAgent`                                                                          | M04/M15 |
| 21  | `engine/conversation-engine.ts:47`            | 值   | `skills/library`                       | `createSkillLibrary, type SkillLibrary`                                                    | M08/M09 |
| 22  | `engine/conversation-engine.ts:48`            | 类型 | `scheduler-host/schedule-tool-binding` | `ScheduleToolPort`                                                                         | M16     |
| 23  | `engine/explicit-skill-context.ts:4`          | 类型 | `skills/library`                       | `SkillLibrary, SkillSummary`                                                               | M09     |
| 24  | `engine/explicit-skill-context.ts:6`          | 值   | `skills/invocation`                    | `SKILL_INVOCATION_PARSE_KINDS, parseSkillInvocationResult, type SkillInvocationSummary`    | M10     |
| 25  | `store/turn-input.ts:3`                       | 值   | `skills/invocation`                    | `SKILL_INVOCATION_PARSE_KINDS, parseSkillInvocationResult`                                 | M10     |
| 26  | `tool-bridge/build-tools.ts:2`                | 值   | `tool-runtime/json-schema-refs`        | `inlineAcyclicLocalJsonSchemaReferences, type JsonSchemaRefIssue`                          | M11     |
| 27  | `tool-bridge/build-tools.ts:12`               | 值   | `tool-runtime/preflight`               | `preflightToolCall`                                                                        | M12     |
| 28  | `tool-bridge/build-tools.ts:13`               | 值   | `tool-runtime/execution-timeout`       | `readExecutionTimeoutMs, ROLL_EXECUTION_TIMEOUT_META_KEY`                                  | M13     |
| 29  | `tool-bridge/build-tools.ts:17`               | 类型 | `types/agent`                          | `AgentTool`                                                                                | M15     |
| 30  | `tool-bridge/build-tools.ts:41`               | 值   | `tool-runtime/execution-timeout`       | `readExecutionTimeoutMs, ROLL_EXECUTION_TIMEOUT_META_KEY`                                  | M13     |
| 31  | `tool-bridge/naming.ts:2`                     | 类型 | `types/agent`                          | `AgentRuntimeOwnership, AgentSourceType, AgentTransport`                                   | M15     |
| 32  | `tool-bridge/normalize-result.ts:4`           | 值   | `cli/utils/tool-results`               | `extractTextContent, isToolErrorResult`                                                    | M14     |
| 33  | `tool-bridge/schedule-create-input.ts:2`      | 类型 | `scheduler-host/schedule-tool-binding` | `ScheduleToolCreateRequest`                                                                | M16     |
| 34  | `tool-bridge/schedule-extend-tool.ts:4`       | 类型 | `scheduler-host/schedule-tool-binding` | `ScheduleExtendAdmission, ScheduleToolError`                                               | M16     |
| 35  | `tool-bridge/schedule-tool.ts:3`              | 类型 | `scheduler-host/schedule-tool-binding` | `ScheduleCreateAdmission, ScheduleExecutionReadiness, ScheduleToolError, ScheduleToolPort` | M16     |
| 36  | `tool-bridge/skill-tool.ts:3`                 | 值   | `skills/library`                       | `SKILL_TOOL_ID, type SkillLibrary`                                                         | M09     |
| 37  | `tool-bridge/tool-approval-continuation.ts:2` | 值   | `tool-runtime/preflight`               | `preflightToolCall`                                                                        | M12     |
| 38  | `tool-bridge/tool-approval-continuation.ts:3` | 类型 | `types/agent`                          | `AgentTool`                                                                                | M15     |

<!-- reverse-import-inventory:end -->

## 原始文档核验记录

迁移前版本只核对源代码、导入语法树、关联测试及包声明，没有执行架构迁移或行为验收。该原始清单和引用表保留用于核对迁移覆盖；实施后的结论以本文顶部及验收清单为准。
