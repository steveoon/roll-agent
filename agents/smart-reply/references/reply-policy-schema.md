# Reply Policy Configuration Schema

`ReplyPolicyConfig` 是 `smart-reply-agent` 的回复策略配置。配置文件为 `data/reply-policy.json`。

这份配置应被视为**固定契约**：上层编排器只应修改这里文档化的字段，不应添加自定义字段。当前实现基于 Zod `object()` 解析，未声明字段不属于稳定接口，可能被忽略或在未来版本失效。

## 顶层字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `stageGoals` | object | 每个漏斗阶段的目标、成功标准和推进策略 |
| `persona` | object | 回复人格：语气、亲和度、长度、提问风格等 |
| `industryVoices` | record | 行业语调配置（key 为 voiceId） |
| `defaultIndustryVoiceId` | string | 默认行业语调 ID |
| `hardConstraints` | object | 不可违反的红线规则 |
| `factGate` | object | 事实校验策略（strict/balanced/open） |
| `qualificationPolicy` | object | 候选人资格校验策略（当前含 age） |
| `outputGuards` | object | 输出质量守卫（追问数量、禁用审查措辞等） |

## stageGoals

固定阶段键：

- `trust_building`
- `private_channel`
- `qualify_candidate`
- `job_consultation`
- `interview_scheduling`
- `onboard_followup`

每个阶段对象包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `description` | string | 阶段说明（可选） |
| `primaryGoal` | string | 该阶段的核心目标 |
| `successCriteria` | string[] | 判定阶段成功的标准 |
| `ctaStrategy` | string | 推进下一步的策略 |
| `disallowedActions` | string[] | 该阶段禁止的行为（可选） |

归一化规则：

- `private_channel` 在 schema 中是可选的；如果省略，解析后会自动回退为 `trust_building`
- `ctaStrategy` 支持传入 `string` 或 `string[]`
- 如果传入 `string[]`，解析时会用换行符拼接为单个字符串

## persona

| 字段 | 类型 | 可选值/说明 |
|------|------|------------|
| `tone` | string | 如 "口语化" |
| `warmth` | string | 如 "高" |
| `humor` | string | 如 "低" |
| `length` | enum | `"short"` / `"medium"` / `"long"` |
| `questionStyle` | string | 如 "单轮一个关键问题" |
| `empathyStrategy` | string | 如 "先认可关切再给建议" |
| `addressStyle` | string | 如 "使用你" |
| `professionalIdentity` | string | 如 "资深招聘专员" |
| `companyBackground` | string | 如 "连锁餐饮招聘" |

## industryVoices

`industryVoices` 是 `record<string, IndustryVoicePolicy>`，key 为 `voiceId`，value 为语调对象。

每个 voice 对象包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 语调名称 |
| `industryBackground` | string | 行业背景描述 |
| `jargon` | string[] | 行业术语 |
| `styleKeywords` | string[] | 风格关键词 |
| `tabooPhrases` | string[] | 禁用表达 |
| `guidance` | string[] | 语调指导原则 |

相关字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `defaultIndustryVoiceId` | string | 默认 voiceId；应对应 `industryVoices` 中的某个 key |

## hardConstraints

| 字段 | 类型 | 说明 |
|------|------|------|
| `rules` | object[] | 红线规则数组 |

每条 rule 包含：

| 字段 | 类型 | 可选值/说明 |
|------|------|------------|
| `id` | string | 规则 ID |
| `rule` | string | 规则正文 |
| `severity` | enum | `"high"` / `"medium"` / `"low"` |

## factGate

| 字段 | 类型 | 可选值/说明 |
|------|------|------------|
| `mode` | enum | `"strict"` / `"balanced"` / `"open"` |
| `verifiableClaimTypes` | string[] | 需要事实校验的声明类型；当前 schema 不限制固定枚举 |
| `fallbackBehavior` | enum | `"generic_answer"` / `"ask_followup"` / `"handoff"` |
| `forbiddenWhenMissingFacts` | string[] | 缺事实时禁止输出的内容类型；当前 schema 不限制固定枚举 |

## qualificationPolicy

`qualificationPolicy` 当前只包含一个固定子对象：

- `age`

## qualificationPolicy.age

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用年龄资格校验 |
| `revealRange` | boolean | `false` | 是否允许透露年龄范围 |
| `failStrategy` | string | "礼貌说明不匹配，避免承诺" | 不符合时的表达策略 |
| `unknownStrategy` | string | "先核实年龄或资格条件" | 未知时的表达策略 |
| `passStrategy` | string | "确认匹配后推进下一步" | 符合时的表达策略 |
| `allowRedirect` | boolean | `true` | 不符合时是否允许推荐其他岗位 |
| `redirectPriority` | enum | `"medium"` | `"low"` / `"medium"` / `"high"` |

## outputGuards

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxQuestionsByMode.minimal` | number | `1` | minimal 模式下最多追问数 |
| `maxQuestionsByMode.focused` | number | `2` | focused 模式下最多追问数 |
| `blockedAuditPhrases` | string[] | 见默认值 | 禁止的审查式措辞 |
| `blockFirstTurnSpecificFacts` | boolean | `true` | 首轮是否禁止输出具体事实 |

当前默认 `blockedAuditPhrases`：

- `是否满足`
- `是否符合`
- `基本入职要求`
- `先确认资格`
- `年龄是否符合`

## 默认值与归一化

以下行为来自当前 schema 实现：

- `qualificationPolicy` 整体有默认值；如果整个对象缺失，会自动补齐默认 `age` 配置
- `qualificationPolicy.age` 各字段有默认值；部分缺失时会自动补齐
- `outputGuards` 整体有默认值；缺失时会自动使用默认追问上限和默认禁用措辞
- `stageGoals.private_channel` 缺失时，会自动回退为 `trust_building`
- `ctaStrategy` 允许 `string[]` 输入，但归一化后始终是单个字符串
