---
name: smart-reply-agent
description: 招聘智能回复 Agent。根据候选人消息、品牌数据和回复策略，生成个性化招聘回复。
metadata:
  roll-env-file: references/env.yaml
---

# Smart Reply Agent

招聘场景智能回复 Agent，负责候选人消息理解、沟通阶段判断与回复文本生成。

npm 包名：`@roll-agent/smart-reply-agent`

## 适用场景

当任务是以下类型时，应优先选择本 Agent：

- 根据候选人消息生成一条招聘回复
- 结合对话历史、候选人信息和品牌数据草拟回复
- 判断当前沟通处于哪个招聘漏斗阶段
- 按既定回复策略生成更稳妥、更合规的回复
- 同步 Duliday 品牌/岗位数据，供后续回复生成使用

## 能力边界

本 Agent 只负责**生成回复文本**和**维护回复所需品牌数据**。

不会：打开聊天页面、读取候选人资料页面、抓取当前聊天记录、直接发送消息、交换微信、执行浏览器自动化。

如果任务需要页面操作或消息发送，应选择 `browser-use-agent`；如果只是基于已给定的 `candidateMessage`、`conversationHistory`、`candidateInfo` 生成回复，应选择本 Agent。

## Tools

- `generate_reply(candidateMessage, conversationHistory?, candidateInfo?, preferredBrand?, channelType?, defaultWechatId?, industryVoiceId?, turnIndex?, modelConfig?)`
  根据候选人消息生成智能回复，返回建议回复文本、置信度、漏斗阶段和诊断信息。输出包含 `replyPolicySource`（`”file”` = 自定义配置, `”default”` = 内置默认策略），调用方据此判断当前回复是否受自定义策略驱动。内部流程：回合规划 → primaryNeed 驱动上下文构建 → 年龄资格校验 → 策略化回复生成 → FactGate/ReplyGate 校验。
- `sync_brand_data(cityName, brandAlias?)`
  从 Duliday API 拉取并同步品牌配置数据（门店、岗位、薪资等）到本地。`cityName` 为必填城市名称，`brandAlias` 为可选品牌过滤。适用于首次初始化、定期刷新或切换城市/品牌数据源的场景。

## Reply Policy（回复策略配置）

回复行为由 `data/reply-policy.json` 驱动。文件不存在时回退到内置默认策略（`generate_reply` 输出 `replyPolicySource: "default"` 可识别）。上层编排器应只修改文档化字段，不要添加自定义字段；未声明字段不属于稳定契约，可能被忽略。完整字段说明见 [references/reply-policy-schema.md](./references/reply-policy-schema.md)。

主要可配置维度：
- **stageGoals** — 6 个漏斗阶段各自的目标、成功标准和推进策略
- **persona** — 语气、亲和度、回复长度、提问风格
- **industryVoices** — 行业语调（术语、禁用表达、风格指导）
- **hardConstraints** — 不可违反的红线规则
- **factGate** — 事实校验严格度（strict/balanced/open）
- **qualificationPolicy.age** — 年龄资格校验开关和表达策略
- **outputGuards** — 追问数量上限、禁用审查措辞

## Environment Variables

机器可读的 env 契约见 `references/env.yaml`。如果你是上层编排 Agent，请优先读取它来生成/校验 `agents.env.smart-reply-agent` 配置。

- `ANTHROPIC_API_KEY` — Anthropic/OpenAI/OhMyGPT 统一鉴权 key（回退读取 `OPENAI_API_KEY`）
- `SMART_REPLY_PROXY_BASE_URL` — 可选，统一代理地址（同时覆盖 anthropic/openai/ohmygpt 端点）
- `SMART_REPLY_CLASSIFY_MODEL` / `SMART_REPLY_REPLY_MODEL` — 可选，覆盖默认分类/回复模型；未设置时分别回退到 `openai/gpt-5-mini` / `openai/gpt-5.4`
- `DULIDAY_TOKEN` — Duliday 品牌别名 & 岗位 API 鉴权 token
- `DULIDAY_BRAND_LIST_URL` / `DULIDAY_JOB_LIST_URL` — 必填，Duliday 品牌/岗位 API 端点；public 仓库中不内置默认地址

## 典型跨 Agent 工作流

1. `browser-use-agent` 读取候选人资料、聊天记录或当前页面上下文
2. 调用方整理出 `candidateMessage`、`conversationHistory`、`candidateInfo`
3. `smart-reply-agent.generate_reply(...)` 生成回复草案
4. `browser-use-agent` 将回复发送到招聘平台

## Recommended roll.config.yaml

建议通过 `roll-core` 的 `agents.env` 为本 Agent 注入环境变量，而不是要求终端用户手工 `export`：

```yaml
agents:
  env:
    smart-reply-agent:
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      SMART_REPLY_PROXY_BASE_URL: ${SMART_REPLY_PROXY_BASE_URL}
      SMART_REPLY_CLASSIFY_MODEL: qwen/qwen-plus-latest
      SMART_REPLY_REPLY_MODEL: qwen/qwen-plus-latest
      DULIDAY_TOKEN: ${DULIDAY_TOKEN}
      DULIDAY_BRAND_LIST_URL: ${DULIDAY_BRAND_LIST_URL}
      DULIDAY_JOB_LIST_URL: ${DULIDAY_JOB_LIST_URL}
```
