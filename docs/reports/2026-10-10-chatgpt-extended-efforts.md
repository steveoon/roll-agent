# ChatGPT xhigh/max 实施与影响面验证

环境：2026-10-10，macOS，Node 24.21.0，pnpm 11.24.0；仓库 roll-agent，工作区 nano-agent，分支 dev，基线 HEAD 8c6e74d。开工前工作区干净；未提交、推送或发布，未改用户配置，未调用真实订阅模型。

## 影响面与边界

开工前分析了 runtimeThinkingLevels、thinkingProviderOptions、chatGptThinkingOptions、cycleThinking、resolveInteractiveChatSwitch、ChatSessionView、runInkRepl、ChatGptAccountPanel 和 App。公共映射/初始化评级 HIGH；快捷键、账号面板、默认模型保存和目标模型切换的直接影响较小。常量与部分 React 回调返回 UNKNOWN，通过实际源码引用和 CLI 懒加载注册核对，未把空图结果视为未使用。

- 配置：runtime.thinkingLevel 和 compaction.thinkingLevel 可表达 off/low/medium/high/xhigh/max，默认 medium 不变。
- API：具体 Provider 映射仍收窄到旧四档；不将 xhigh/max 传给 token-budget 映射或统一 structured-output reasoning。
- ChatGPT：按账号模型目录规范化档位，none 对应 off；未知档位忽略、去重并采用稳定顺序；目录缺失不开放额外高档。
- 终端：/effort 查询/设置支持档位，快捷键只遍历当前能力；切模型不兼容时先选档，取消不改变模型，校验后一起应用并更新界面。
- 配置台：复用账号目录，不引入新的认证接口；聊天及压缩选项按当前账号/模型过滤，旧非法值保持可见并提示调整。
- 压缩/Sampling/scheduler：复用现有订阅解析及适配器，不修改 Runtime 数据库、工具审批或 scheduler 状态机。压缩强度可独立配置。
- 独立 ask/run：订阅聊天的 xhigh/max 不应误入它们的 API Sampling；显式提示该独立 API 模型使用默认 medium，不切模型或授权通道。旧四档保持不变；API 聊天自身设置非法扩展档位仍失败。
- 默认保存：模型与当前聊天强度一并保存，仍保留显式压缩覆盖。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 开工前 Core/UI 与 Runtime 类型检查 | 通过 |
| 新功能第一轮针对性回归 | 111 通过 |
| 最终 Core 全量测试 | 1922 通过，0 失败，5 跳过（总计 1927） |
| 全仓类型检查 | 13 个 workspace 项目通过；末次边界修复后 Core/UI 再验证通过 |
| 仓库 lint | 通过；每个变更代码文件另执行 fast verification |
| 全量 Core E2E | 73 通过（在最后 ask/run 边界补充前执行） |
| 最后 ask/run 真实 CLI 隔离夹具 | 5 通过，含订阅 max 配置下的 run/ask；使用本地假 API，不消费真实额度 |
| 切模型后能力刷新回归 | ChatApp 64 项测试通过，最终 Core 全量亦覆盖 |
| Core 发布构建、React UI 构建 | 通过 |
| 构建态 CLI agent health | 通过 |
| Prettier 与 git diff --check | 通过 |
| Changeset | @roll-agent/core minor，status 通过 |

发现并修复的验证问题：新增测试最初缺模块（预期失败）；请求体测试需允许 SDK 自带 summary 字段；配置夹具改用 runtimeConfigSchema；补齐状态栏档位表、exactOptionalPropertyTypes 与 legacy structured reasoning 类型；修正 import 顺序/curly；更新配置目录六档断言。最终无已知失败。

## 图谱覆盖限制

已执行 index-only 刷新，新增能力模块纳入图谱。chatGptThinkingLevels 与 requireLegacyThinkingLevel 的上游评级 CRITICAL，反映 CLI/UI/Provider 共用调用链。最后 detect-changes 对已跟踪改动报告 25 文件、75 符号、29 执行流程，评级 CRITICAL。CLI 始终节选显示符号/流程，即使提高 limit；未将其当作完整无风险证明。

索引明确报告全仓 callable-value-flow 候选上限、跨语言字段未链接和执行流程预算裁剪。detect-changes 的 git diff 不包含未跟踪新文件；新增模块通过独立 impact 和测试补查。最终少量帮助文案、测试及独立 API Sampling helper 在索引刷新后追加，未再做昂贵重建；最终图分析不是对最终工作树的完整证明。没有提交，仍需在实际提交前刷新并复查。

首轮未做真实订阅额度/延迟实测、真实浏览器视觉验收、Runtime 全量测试或完整发布供应链检查；当前结果不代表已发布。

## Review follow-up：配置台误报与 /resume 强度不同步

用户提供两项中优先级复现后，确认并修复：

1. `PrimitiveControl` 不再把所有不在选项中的字符串当成环境变量；仅 `$` 开头的 ENV 草稿进入原始输入控件。`EnumControl` 根据模型目录的 loading/ready/unavailable 状态判断字面值，加载或失败时保留原值并提示未验证，已确认不支持时显示可调整的下拉选项及档位错误。目录/值变化时同步发布或清除校验，App 同时重新校验隐藏的聊天与压缩字段，避免跨模块残留错误。
2. `ChatApp` 外层保存当前强度，并在模型切换成功后与模型一起更新；手动设置需先通过 Provider 校验，再更新外层状态。恢复会话及定时任务讨论重新挂载内层视图时继承当前强度，不重用启动时的旧值；不修改请求参数。

验证：

- 新增 Ink 用例先复现订阅 max -> API low -> /resume 后错误显示 max；修复后通过，包含两次恢复、快捷键升档及再次切模型的兼容判断。测试夹具需等待新视图输入绑定，并使用已有 Kitty Alt+. 编码。
- 输入验证新增合法/非法字面值、目录加载/失败、完整/不完整 ENV 引用；能力目录测试涵盖账号归属、隐藏字段、支持情况变化以及不改写已保存值。
- 真实 Ego 浏览器访问本机隔离 Vite 页面，挂载真实 CatalogEditor 与 ChatGptAccountPanel，使用假目录与可控请求。通过：加载中保留 max 且不误报 ENV；模块切换重载后恢复可保存；不支持 max 显示档位错误；字段隐藏时切回支持模型清除旧错误；ENV 草稿与字面值往返清除错误；目录请求失败与刷新重试保持字面值。仅验证客户端保存可用性，未对真实账号或服务器执行保存。
- 初次夹具因 macOS /tmp 实际为 /private/tmp 而无法挂载，调整 Vite 根和文件访问范围后完成上述验收。隔离 TaskSpace 已 finish，夹具服务器已 Ctrl-C 关闭；未操作用户原有页面、配置或认证凭证。Ego Lite 提示可升级，未执行升级。
- 修复后 Core 全量：1930 项，1925 通过，0 失败，5 跳过。Core/UI typecheck、Core/UI build、构建态 CLI health、仓库 lint、所有变更代码 fast verification、Prettier 和 git diff --check 通过。
- 修改前对控件分派、校验、账号面板和外层状态完成 impact；控件评级 LOW，React Ink 入口 UNKNOWN 结合源码挂载与测试补查。最终 detect-changes 覆盖已跟踪整组改动：28 文件、97 符号、29 流程，评级 CRITICAL；仍有上一节描述的图谱/新文件覆盖限制，不作完整无风险证明。

本轮没有重跑全量 E2E、Runtime 全量测试或真实订阅推理。改动仍未提交或发布。
