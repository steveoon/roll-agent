# Runtime 宿主 API 迁移

本次变更将依赖方向固定为 `Core → Runtime → Protocol / 第三方基础库`，是 Runtime 的 major API 变更。CLI 配置格式、交互方式、SQLite schema、Runtime Protocol 和 Relay wire 不变。Core 继续接线现有 chat、Runtime 服务、Companion 和 scheduler 入口。

## 创建引擎

`ConversationEngine` 不再接收完整 `RollConfig`，也不创建 Provider、读取凭证、扫描 Agent 注册表或发现 Skills。调用方必须传入模型、模型标识和执行设置：

```ts
import { ConversationEngine, ThreadStore } from "@roll-agent/runtime";
import { runtimeSettingsSchema } from "@roll-agent/runtime/host-contracts";
import type { LanguageModelV4 } from "@ai-sdk/provider";

async function run(model: LanguageModelV4) {
  const store = new ThreadStore("./threads");
  const engine = new ConversationEngine({
    settings: runtimeSettingsSchema.parse({ instructions: "off" }),
    provider: "my-provider",
    modelName: "my-model",
    model,
    sources: [],
    store,
    workspaceInstructions: null,
  });
  try {
    const session = await engine.createSession();
    for await (const event of session.send("Hello")) {
      if (event.type === "text-delta") process.stdout.write(event.delta);
    }
  } finally {
    await engine.dispose();
    store.close();
  }
}
```

`RuntimeSettings` 由 `runtimeSettingsSchema` 推导，只包含 maxSteps、turnTimeoutMs、contextWindow、compaction、shell 和工作区 instructions 设置。Core 的 `mapRuntimeSettings()` 显式投影这些字段；默认值等价测试防止两侧漂移。Provider thinking 参数由 Core 转成 AI SDK 的 Provider options 后独立注入。

## API 对照

| 原 API                                                             | 新 API / 归属                                                                          |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `config: RollConfig`                                               | `settings: RuntimeSettings`、`provider`、`modelName`；Core 负责配置映射                |
| 可选 `model`，未传时创建 Provider                                  | 必需 `model: LanguageModelV4`；缺失时明确失败                                          |
| `agents`、`clientManager`、`ensureAgentReady`、`acquireAgentUsage` | `agentHost: AgentHost`；Core 内部 `CoreAgentHost` 实现注册、连接和租约                 |
| `installAgentFn`、`resolveCatalogFn`                               | 宿主的 `prepare()` 返回目录，`install()` 返回安装事实，`refresh()` 接入工具            |
| `onSkillLibraryIssue`、默认目录扫描                                | Core 发现并报告告警；Runtime 接收 `skillLibrary` 或宿主快照中的库                      |
| `prepareAgentRefresh(RegisteredAgent)`                             | `prepareAgentRefresh(agentName: string)`；注册对象留在宿主内                           |
| Provider 名称隐式决定 schema 策略                                  | `toolSchemaPolicy` 随模型注入；省略时拒绝含未解决引用问题的工具                        |
| `AgentSessionOptions.onProviderOptionsChange` 在参数写入后通知     | 改为写入前的同步校验/宿主同步；回调抛错时 Session 保留旧参数，不应在回调中重入会话执行 |
| 从 Core 导入共享纯逻辑/类型                                        | 使用 Runtime `/skills`、`/tool-contracts`、`/host-contracts`                           |

静态 `sources` 与动态 `agentHost` 互斥。静态来源的连接由调用方管理；Engine 不关闭它们。未提供动态宿主时不会发现 Agent 或提供安装功能，未注入 Skills 时不会扫描用户目录。

`AgentToolSource.client` 只要求 `callTool`，无需构造或强转为完整 MCP Client。规范化工具保留 schema issues、App output、execution timeout、annotations、资源提示和 observation retention。Core 的旧工具/Skills 子路径继续转接同一份实现。

## 宿主生命周期

`AgentHost` 在 `/host-contracts` 定义：

- `prepare({ model, providerOptions?, signal })` 提供工具、Skills 和可安装目录快照。
- `refresh(agentName, operation)` 返回该 Agent 的新工具来源及 Skills；Runtime 串行应用结果。
- 可选 `install(shortName, report, signal)` 返回安装结果。安装成功后接入失败仍保留成功事实，不重试安装。
- `updateSampling(model, providerOptions)` 只同步更新内存，不能建立连接或执行外部 I/O；校验必须在写入前完成，抛错时保留原 Sampling 状态。
- `dispose()` 幂等释放本宿主取得的资源；失败必须拒绝并保留错误。

Engine 关闭时先拒绝新会话、取消等待，结算会话、bootstrap、刷新与已开始的安装，再清理宿主。关闭后的迟到结果不会激活会话。取消请求不等于撤销安装或令牌交换；这些外部副作用沿用原有有界等待和结果记录。

Core 通过 MCP scoped acquisition 跟踪连接所有权。一次获取失败只回滚本次获取；已提交连接在最后一个 scoped owner 释放后关闭。传统 manager-owned 连接仍由原拥有者关闭。Core 适配器不调用共享管理器的 `disconnectAll()`。

连接共享与模型隔离是不同的边界：一个 MCP 连接只有一套 Sampling 模型和 Provider options。Core 默认为每个宿主创建独立 manager；需要不同模型、账号或独立切换策略时保留该默认行为。显式共享 manager 的宿主也会共享连接的 Sampling 状态，不能把 scoped 资源引用计数当作每个引擎的 Sampling 隔离。

## 模型切换与恢复

`switchModel()` 仍先检查所有活动会话能否切换，再同步模型、Provider options、structured-output 参数、schema 策略和 Sampling。调用方应在每次切换时传入对应的 `toolSchemaPolicy`，避免沿用前一个 Provider 的能力。Core 的 API Key 与 ChatGPT 选择器均提供该策略，包括恢复后重新选择模型的路径。

宿主 Sampling 校验在会话检查之后、模型状态写入之前执行；宿主拒绝时，Runtime 模型和持久化标识保持原值。`toolSchemaPolicy` 必须是无副作用、不会抛错的判定函数，不应执行 I/O 或在其中修改会话。此同步契约不为任意用户回调提供事务回滚。

模型和 Provider options 更新期间，Engine 会拒绝同步重入的切换、参数更新及已有会话的 `send()` / `compact()`；工作在接受输入和建立活动轮次前被拒绝。保护在同步更新结束或失败后释放。宿主只应同步更新 Sampling 内存状态，后续工作应由调用方在更新成功返回后启动。

恢复继续使用 `ModelTurnRecovery`。本次拆分不重置整轮 deadline、maxSteps，也不重放已经完成的工具操作。摘要请求继续使用已注入模型及专门的 structured-output 参数。
