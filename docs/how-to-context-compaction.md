# 长对话压缩与历史回查

当对话不断变长、上下文接近模型窗口限制时，Roll 默认采用 `summarize` 策略将较早的对话压缩成一份紧凑的交接摘要（最长 24,000 字符），同时完整保留近期对话原文与当前用户输入。由于摘要是对历史的提炼，可能省略早期细节；需要核对精确文本或输出时，模型可随时按需回查本地保存的原始记录。

## 自动与手动压缩

- **触发时机与预算估算**：每次请求模型前，Roll 会综合系统提示词、工具定义、Provider 参数、对话消息及输出预留空间估算上下文占用，并结合最近同构请求的实际输入 token 用量校准估算结果（模型、工具集或提示词变化后会重新校准）。当估算占用达到上下文窗口的 `threshold`（默认 `75%`）时会自动触发压缩；你也可以在聊天中随时输入 `/compact` 手动触发一次压缩（若当前没有可压缩的早期轮次则跳过）。
- **保留边界与完整性**：压缩始终保留当前用户输入、最近若干轮对话（受 `keep-recent-turns` 与 `keep-recent-tokens` 共同约束）以及尚未结算或紧密相连的工具步骤，绝不会把同一次工具调用（`tool-call`）与工具结果（`tool-result`）拆开。整轮对话原有的总超时与 `max-steps` 步数上限不会因压缩而重置，已执行完毕的工具也不会重复执行。
- **摘要输入范围**：生成新摘要时，送入摘要模型的输入包含三部分——**上一次的任务摘要**、**本次拟移出活跃上下文的早期历史**，以及**近期保留原文中的用户消息（`retainedUserMessages`）**。引入 `retainedUserMessages` 是为了对齐用户最新的目标、约束与意图（若与早期历史冲突，以较新的用户原文为准）。消息中的图片、音频等内嵌媒体数据在送入摘要模型时会替换为占位描述，本地原始记录保持不变。
- **提交条件与失败保底**：单次压缩最多调用一次摘要模型（默认限时 120 秒）。只有当生成的摘要非空、且替换后的完整模型请求体积确实缩小时，Roll 才会原子写入新检查点（checkpoint）并更新活跃上下文；若摘要超时、被取消或未能缩减体积，则保持原上下文不变（只要未超出窗口硬上限仍会继续本轮对话，超出硬上限则明确报错结束本轮）。
- **`truncate` 裁剪策略**：若显式配置 `strategy: "truncate"`，压缩时仅直接移出较早的完整对话轮次并保留检查点定位，不额外调用模型生成摘要。注意：`summarize` 失败时不会自动降级为 `truncate`。

## 配置参数

可在 `roll.config.yaml` 的 `runtime` 段调整上下文窗口与压缩行为：

```yaml
runtime:
  context-window: 200000
  compaction:
    enabled: true
    strategy: summarize
    threshold: 0.75
    keep-recent-turns: 4
    keep-recent-tokens: 32000
    timeout-ms: 120000
    max-output-tokens: 8192
    thinking-level: low
```

| 配置项 | 类型 / 可选值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `runtime.context-window` | 正整数（可选） | 按模型推断 | 显式覆盖当前模型的上下文窗口总大小（token） |
| `runtime.compaction.enabled` | `boolean` | `true` | 是否启用自动上下文压缩 |
| `runtime.compaction.strategy` | `"summarize"` \| `"truncate"` | `"summarize"` | 压缩策略：生成任务交接摘要，或仅裁剪早期完整轮次 |
| `runtime.compaction.threshold` | `0.1`–`0.95` | `0.75` | 触发自动压缩的上下文窗口占用比例阈值 |
| `runtime.compaction.keep-recent-turns` | 整数（`>= 1`） | `4` | 压缩时尽量保留的最近用户轮次数 |
| `runtime.compaction.keep-recent-tokens` | 整数（`>= 1`） | `32000` | 保留近期原文的 token 预算上限；超出时会提前切分，但至少保留最新一轮 |
| `runtime.compaction.timeout-ms` | `10000`–`600000` | `120000` | 单次摘要模型调用的超时上限（毫秒） |
| `runtime.compaction.max-output-tokens` | `2048`–`32768` | `8192` | 摘要模型单次输出的最大 token 数（同时不超过上下文窗口的 1/4） |
| `runtime.compaction.thinking-level` | `"off"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`（可选） | 沿用会话设置 | 单独指定摘要请求使用的推理强度（`xhigh` 仅 Google `gemini-4-hydrogen` / `gemini-4-neon` 与支持对应档位的 ChatGPT 模型可用，`max` 仅支持对应档位的 ChatGPT 模型可用） |

## 按需历史回查（`roll__transcript`）

发生过压缩的会话会自动向模型提供免审批的只读工具 `roll__transcript`，根据检查点提示中的 `checkpointId` 按需查阅已移出上下文的历史记录。

`kind` 参数支持以下三种记录类型：

- `"message"`（默认）：查询原始对话消息（角色、时间、消息内容）。
- `"tool_execution"`：查询完整脱敏后的工具执行记录（工具名、输入输出摘要与执行状态）。
- `"legacy_context"`：查询旧版（V1/V2）检查点与结构化账本条目（`sequence: 0` 为旧检查点与恢复备注，后续序号为该代账本条目）。

**分页列出**与**单条分块**两种调用模式互斥（切换模式时必须直接省略另一组参数，不能混传）：

- **普通分页模式**：最小调用 `{"checkpointId": "<checkpoint UUID>"}`，可选 `kind`、`afterSequence`、`limit`（默认 `10`，最大 `20`；省略 `sequence`、`offset`、`maxChars`）。单条记录超长时会在分页结果中截断预览并标记 `entryTruncated: true`。
- **长记录分块模式**：针对分页中被截断的单条记录，按序号分段读取完整脱敏 JSON 文本。最小调用 `{"checkpointId": "<checkpoint UUID>", "sequence": <序号>}`，可选 `kind`、`offset`（UTF-16 字符偏移，首次为 `0`）、`maxChars`（默认 `4000`，最大 `8000`；省略 `afterSequence`、`limit`），例如：

```json
{"checkpointId":"<checkpoint UUID>","kind":"tool_execution","sequence":12,"offset":0,"maxChars":4000}
```

分块返回结果包含 `text`、`totalChars` 与可选的 `nextOffset`；沿 `nextOffset` 继续读取同一 `sequence` 直至 `nextOffset` 为空，即读完该条记录。若需追溯更早一次压缩前的历史，可使用返回结果中的 `previousCheckpointId` 继续向前查询。

所有记录在分块切片前都会先完成完整脱敏，凭据、二进制数据与内部 Provider 元数据不会因分块而泄露。若某条早期工具记录已按保留策略清理，回查会明确说明该记录不可用。历史回查结果仅作为上下文证据，不会改变或绕过普通工具的审批策略。

## 旧会话兼容

会话数据库当前使用 schema `v12`，仍兼容读取早期 V1/V2 检查点与历史账本：

- 打开旧会话时直接复用不超过 8,000 字符的既有检查点提示，不会一次性加载全部旧账本，也不会在打开会话时额外调用模型做转换。
- 旧会话首次触发新压缩时沿用标准 `summarize` 流程：既有检查点提示作为 `previousSummary`，与拟移出的历史原文和 `retainedUserMessages` 一起生成新版摘要；拟移出近期原文且尚未归档的旧摘要片段会在提交时自动补存归档，原有旧表与历史记录保留不变。
- 需要查阅旧会话早期的结构化记录时，可沿 `previousCheckpointId` 定位到 V1/V2 检查点，并以 `kind: "legacy_context"` 分页或分块读取。早期记录若因保留策略缺失，仅在读取该条记录时提示不可用，不会阻断会话打开或后续压缩。
